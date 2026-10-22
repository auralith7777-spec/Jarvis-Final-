import type { Connector, CrossCheckResult, Step } from "./types.js";
import { extractJson, truncate } from "./util.js";
import type { CostTracker } from "./cost.js";
import type { AuditLike } from "./audit.js";

const JUDGE_SYSTEM = `ROLE:JUDGE
You compare several independent answers to the same task and produce the single most accurate one.
Rules:
- Do not assume agreement means correctness; models can share mistakes.
- List real conflicts (different facts, numbers, claims). Ignore wording differences.
- If you cannot settle a conflict from the answers alone, say so and set "flagged": true.
- Never invent sources or numbers.
Return ONLY JSON: {"agreement": boolean, "conflicts": string[], "final": string, "confidence": number between 0 and 1, "flagged": boolean}`;

export async function crossCheck(
  step: Step,
  taskPrompt: string,
  workers: Connector[],
  judge: Connector,
  system: string,
  cost: CostTracker,
  audit: AuditLike
): Promise<CrossCheckResult> {
  // run workers in parallel; a failed worker must not sink the step
  const settled = await Promise.allSettled(
    workers.map(async (w) => {
      const r = await w.run({ system, prompt: taskPrompt });
      cost.add(w, r);
      audit.log("step.worker", { step: step.id, by: w.card.id, ms: r.latencyMs, tokens: [r.inputTokens, r.outputTokens] });
      return { id: w.card.id, text: r.text };
    })
  );
  const answers = settled.flatMap((s, i) => {
    if (s.status === "fulfilled") return [s.value];
    audit.log("step.worker.error", { step: step.id, by: workers[i].card.id, error: String(s.reason) });
    return [];
  });
  if (!answers.length) throw new Error(`All agents failed on step ${step.id}`);

  // only one answer survived: nothing to compare, flag it honestly
  if (answers.length === 1) {
    return {
      final: answers[0].text,
      agreement: true,
      confidence: 0.4,
      conflicts: [],
      flagged: true,
      judgeId: "none",
      workerIds: [answers[0].id],
    };
  }

  const judgePrompt =
    `Task:\n${step.instruction}\n\n` +
    answers.map((a, i) => `--- Answer ${i + 1} ---\n${truncate(a.text, 6000)}`).join("\n\n");
  const jr = await judge.run({ system: JUDGE_SYSTEM, prompt: judgePrompt, maxTokens: 2500 });
  cost.add(judge, jr);

  let parsed: Omit<CrossCheckResult, "judgeId" | "workerIds">;
  try {
    parsed = extractJson(jr.text);
  } catch {
    // judge broke format: fall back to the first answer and flag it
    audit.log("step.judge.parse_error", { step: step.id, by: judge.card.id });
    return {
      final: answers[0].text,
      agreement: false,
      confidence: 0.3,
      conflicts: ["Judge reply could not be parsed"],
      flagged: true,
      judgeId: judge.card.id,
      workerIds: answers.map((a) => a.id),
    };
  }
  const result: CrossCheckResult = {
    final: String(parsed.final ?? answers[0].text),
    agreement: Boolean(parsed.agreement),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.5))),
    conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts.map(String) : [],
    flagged: Boolean(parsed.flagged),
    judgeId: judge.card.id,
    workerIds: answers.map((a) => a.id),
  };
  audit.log("step.crosscheck", { step: step.id, ...result, final: undefined });
  return result;
}
