import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Connector, Step, StepOutcome } from "./types.js";
import { Audit } from "./audit.js";
import { CostTracker } from "./cost.js";
import { evaluateStep, type Policy } from "./policy.js";
import { ask } from "./approval.js";
import { planGoal } from "./planner.js";
import { crossCheck } from "./crosscheck.js";
import { pickByStrength, pickJudge, rank } from "./router.js";
import { truncate } from "./util.js";
import { WORKER_SYSTEM, WRITER_SYSTEM } from "./prompts.js";
import { buildReport } from "./report.js";

export interface RunOptions {
  goal: string;
  connectors: Connector[];
  policy: Policy;
  autoYes: boolean;
  outDir: string;
}

export async function runJob(opts: RunOptions): Promise<string> {
  const { goal, connectors, policy, autoYes, outDir } = opts;
  if (!connectors.length) throw new Error("No agents available. Add an API key to .env or run with --mock.");

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const audit = new Audit(runId, join(outDir, "audit"));
  const cost = new CostTracker(policy.maxUsdPerRun);
  audit.log("run.start", { goal, agents: connectors.map((c) => c.card.id) });

  // 1. PLAN
  console.log(`\n▶ Goal: ${goal}`);
  console.log(`  Agents online: ${connectors.map((c) => c.card.id).join(", ")}\n`);
  const planner = pickByStrength(connectors, "planning");
  let steps = await planGoal(goal, planner, cost, audit);

  // 2. POLICY CHECK on the plan
  const approveNeeded = new Set<number>();
  steps = steps.filter((s) => {
    const v = evaluateStep(s, policy);
    audit.log("policy.check", { step: s.id, verdict: v.action, reason: "reason" in v ? v.reason : undefined });
    if (v.action === "block") {
      console.log(`  ✖ Step ${s.id} blocked by policy (${v.reason}): ${s.title}`);
      return false;
    }
    if (v.action === "approve") approveNeeded.add(s.id);
    return true;
  });

  console.log("Plan:");
  for (const s of steps) {
    const flags = [s.risk === "high" ? "cross-check" : "", approveNeeded.has(s.id) ? "needs approval" : ""].filter(Boolean);
    console.log(`  ${s.id}. ${s.title}  [${s.tags.join(", ")}]${flags.length ? "  ⚑ " + flags.join(", ") : ""}`);
  }
  if (!(await ask("\nApprove this plan?", autoYes))) {
    audit.log("plan.rejected");
    return "Plan rejected. Nothing was run.";
  }
  audit.log("plan.approved", { steps });

  // 3. RUN each step
  const outcomes: StepOutcome[] = [];
  let context = "";
  for (const step of steps) {
    if (cost.overCap) {
      console.log(`\n⛔ Spend cap of $${policy.maxUsdPerRun} reached. Stopping.`);
      audit.log("run.cap_reached", { total: cost.total });
      break;
    }
    if (approveNeeded.has(step.id)) {
      const ok = await ask(`\n⚑ Step ${step.id} "${step.title}" needs your approval. Run it?`, autoYes);
      audit.log("approval", { step: step.id, approved: ok });
      if (!ok) {
        outcomes.push({ step, output: "", modelsUsed: [], skipped: "Not approved by user" });
        continue;
      }
    }

    console.log(`\n→ Step ${step.id}: ${step.title}`);
    const ranked = rank(connectors, step);
    const crossChecked = (step.risk === "high" || policy.crossCheckAlways) && ranked.length > 1;
    const taskPrompt =
      `Overall goal: ${goal}\n\n` +
      (context ? `Verified results so far:\n${truncate(context, 6000)}\n\n` : "") +
      `Your task: ${step.instruction}`;

    try {
      if (crossChecked) {
        const workers = ranked.slice(0, Math.min(3, ranked.length));
        const judge = pickJudge(connectors, workers);
        console.log(`  cross-checking on ${workers.map((w) => w.card.id).join(" + ")}, judge: ${judge.card.id}`);
        const cc = await crossCheck(step, taskPrompt, workers, judge, WORKER_SYSTEM, cost, audit);
        outcomes.push({ step, output: cc.final, modelsUsed: [...cc.workerIds, `judge:${cc.judgeId}`], crossCheck: cc });
        context += `\n[Step ${step.id}] ${cc.final}`;
        console.log(cc.flagged ? `  ⚠ flagged for review (confidence ${cc.confidence.toFixed(2)})` : `  ✔ checked (confidence ${cc.confidence.toFixed(2)})`);
        for (const c of cc.conflicts) console.log(`    conflict: ${c}`);
      } else {
        const worker = ranked[0];
        const r = await worker.run({ system: WORKER_SYSTEM, prompt: taskPrompt });
        cost.add(worker, r);
        audit.log("step.worker", { step: step.id, by: worker.card.id, ms: r.latencyMs, tokens: [r.inputTokens, r.outputTokens] });
        outcomes.push({ step, output: r.text, modelsUsed: [worker.card.id] });
        context += `\n[Step ${step.id}] ${r.text}`;
        console.log(`  ✔ done by ${worker.card.id}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ✖ failed: ${msg}`);
      audit.log("step.error", { step: step.id, error: msg });
      outcomes.push({ step, output: "", modelsUsed: [], skipped: `Failed: ${msg}` });
    }
  }

  // 4. WRITE the report
  const done = outcomes.filter((o) => !o.skipped);
  let body = "";
  if (done.length) {
    const writer = pickByStrength(connectors, "writing");
    const wr = await writer.run({
      system: WRITER_SYSTEM,
      prompt:
        `Goal: ${goal}\n\nVerified step outputs:\n` +
        done.map((o) => `## ${o.step.title}\n${o.output}`).join("\n\n"),
      maxTokens: 3000,
    });
    cost.add(writer, wr);
    audit.log("report.written", { by: writer.card.id });
    body = wr.text;
  } else {
    body = "_No steps completed._";
  }

  const flagged = outcomes.filter((o) => o.crossCheck?.flagged);
  const md = buildReport({ goal, body, outcomes, rows: cost.summary(), total: cost.total, cap: policy.maxUsdPerRun });

  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, `report-${runId}.md`);
  writeFileSync(reportPath, md);
  audit.log("run.end", { report: reportPath, totalUsd: cost.total, flagged: flagged.length });

  console.log(`\n✔ Report: ${reportPath}`);
  console.log(`  Audit log: ${audit.file}`);
  console.log(`  Spend: $${cost.total.toFixed(4)} / $${policy.maxUsdPerRun}`);
  if (flagged.length) console.log(`  ⚠ ${flagged.length} step(s) flagged for your review`);
  return reportPath;
}
