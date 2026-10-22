import { randomUUID } from "node:crypto";
import type { Connector, StepOutcome } from "./types.js";
import { evaluateStep, type Policy } from "./policy.js";
import { CostTracker } from "./cost.js";
import { planGoal } from "./planner.js";
import { crossCheck } from "./crosscheck.js";
import { pickByStrength, pickJudge, rank } from "./router.js";
import { HttpError, truncate } from "./util.js";
import { buildReport } from "./report.js";
import { WORKER_SYSTEM, WRITER_SYSTEM } from "./prompts.js";
import type { AuditLike } from "./audit.js";
import type { Job } from "./job.js";
import type { Store } from "./store.js";

const MAX_EVENTS = 400;
const MAX_ACTIVE = 3;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The same flow as the CLI (plan → policy → approve → run → cross-check → report),
 * but as a job state machine that pauses for human approval and survives restarts.
 */
export class Engine {
  private cache = new Map<string, Job>();
  private costs = new Map<string, CostTracker>();
  private active = new Set<string>();

  constructor(
    private store: Store,
    private connectors: Connector[],
    private policy: Policy,
    readonly usingMock: boolean
  ) {}

  get agents(): string[] {
    return this.connectors.map((c) => c.card.id);
  }
  get capUsd(): number {
    return this.policy.maxUsdPerRun;
  }

  /** Jobs that were mid-flight when the server stopped cannot continue: mark them failed. */
  async recover() {
    for (const s of await this.store.list()) {
      if (s.status !== "planning" && s.status !== "running") continue;
      const job = await this.store.get(s.id);
      if (!job) continue;
      job.status = "failed";
      job.error = "Interrupted by a server restart. Start the job again.";
      for (const st of job.steps) if (st.status === "running") st.status = "failed";
      await this.persist(job);
    }
  }

  async list() {
    return this.store.list();
  }

  async get(id: string): Promise<Job> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const job = await this.store.get(id);
    if (!job) throw new HttpError(404, "Job not found");
    this.cache.set(id, job);
    return job;
  }

  async createJob(goalRaw: string): Promise<Job> {
    const goal = goalRaw.trim();
    if (goal.length < 5 || goal.length > 500) throw new HttpError(400, "Describe the goal in 5 to 500 characters.");
    if (!this.connectors.length) throw new HttpError(503, "No agents are connected. Add an API key on the server.");
    if (this.active.size >= MAX_ACTIVE) throw new HttpError(429, "Too many jobs are running. Wait for one to finish.");

    const now = new Date().toISOString();
    const job: Job = {
      id: randomUUID(),
      goal,
      status: "planning",
      createdAt: now,
      updatedAt: now,
      agents: this.agents,
      steps: [],
      blocked: [],
      cursor: 0,
      approvals: {},
      context: "",
      events: [],
      costRows: [],
      costTotal: 0,
      capUsd: this.policy.maxUsdPerRun,
      capHit: false,
    };
    this.cache.set(job.id, job);
    this.active.add(job.id);
    await this.persist(job);
    void this.plan(job);
    return job;
  }

  async decidePlan(id: string, approve: boolean): Promise<Job> {
    const job = await this.get(id);
    if (job.status !== "awaiting_plan") throw new HttpError(409, "This job is not waiting for plan approval.");
    const audit = this.audit(job);
    if (!approve) {
      job.status = "rejected";
      audit.log("plan.rejected");
      await this.persist(job);
      return job;
    }
    if (this.active.size >= MAX_ACTIVE) throw new HttpError(429, "Too many jobs are running. Wait for one to finish.");
    audit.log("plan.approved", { steps: job.steps.map((s) => s.step.title) });
    job.status = "running";
    this.active.add(id);
    await this.persist(job);
    void this.run(job);
    return job;
  }

  async decideStep(id: string, approve: boolean): Promise<Job> {
    const job = await this.get(id);
    if (job.status !== "awaiting_step" || job.pendingStep === undefined)
      throw new HttpError(409, "This job is not waiting for a step approval.");
    const stepId = job.pendingStep;
    this.audit(job).log("approval", { step: stepId, approved: approve });
    job.approvals[String(stepId)] = approve;
    job.pendingStep = undefined;
    job.status = "running";
    this.active.add(id);
    await this.persist(job);
    void this.run(job);
    return job;
  }

  // ---------- internals ----------

  private audit(job: Job): AuditLike {
    return {
      log: (event, data = {}) => {
        job.events.push({ t: new Date().toISOString(), event, ...data });
        if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
      },
    };
  }

  private tracker(job: Job): CostTracker {
    let t = this.costs.get(job.id);
    if (!t) {
      t = new CostTracker(job.capUsd);
      t.restore(job.costRows);
      this.costs.set(job.id, t);
    }
    return t;
  }

  private async persist(job: Job) {
    const t = this.costs.get(job.id);
    if (t) {
      job.costRows = t.summary();
      job.costTotal = t.total;
    }
    job.updatedAt = new Date().toISOString();
    await this.store.save(job);
  }

  private async plan(job: Job) {
    const audit = this.audit(job);
    const cost = this.tracker(job);
    try {
      audit.log("run.start", { goal: job.goal, agents: this.agents });
      const planner = pickByStrength(this.connectors, "planning");
      const steps = await planGoal(job.goal, planner, cost, audit);
      for (const s of steps) {
        const v = evaluateStep(s, this.policy);
        audit.log("policy.check", { step: s.id, verdict: v.action, reason: "reason" in v ? v.reason : undefined });
        if (v.action === "block") job.blocked.push({ title: s.title, reason: v.reason });
        else job.steps.push({ step: s, gate: v.action === "approve" ? "approval" : "none", status: "pending", models: [] });
      }
      if (!job.steps.length) {
        job.status = "failed";
        job.error = "Every step in the plan was blocked by policy.";
      } else {
        job.status = "awaiting_plan";
      }
    } catch (e) {
      job.status = "failed";
      job.error = errMsg(e);
      audit.log("run.error", { error: job.error });
    } finally {
      this.active.delete(job.id);
      await this.persist(job);
    }
  }

  private async run(job: Job) {
    const audit = this.audit(job);
    const cost = this.tracker(job);
    try {
      for (; job.cursor < job.steps.length; job.cursor++) {
        const st = job.steps[job.cursor];
        const step = st.step;

        if (cost.overCap) {
          job.capHit = true;
          audit.log("run.cap_reached", { total: cost.total });
          break;
        }

        if (st.gate === "approval" && job.approvals[String(step.id)] === undefined) {
          job.pendingStep = step.id;
          job.status = "awaiting_step";
          audit.log("approval.requested", { step: step.id, title: step.title });
          this.active.delete(job.id);
          await this.persist(job);
          return;
        }
        if (job.approvals[String(step.id)] === false) {
          st.status = "skipped";
          st.note = "You chose not to run this step.";
          await this.persist(job);
          continue;
        }

        st.status = "running";
        await this.persist(job);

        const ranked = rank(this.connectors, step);
        const crossChecked = (step.risk === "high" || this.policy.crossCheckAlways) && ranked.length > 1;
        const taskPrompt =
          `Overall goal: ${job.goal}\n\n` +
          (job.context ? `Verified results so far:\n${truncate(job.context, 6000)}\n\n` : "") +
          `Your task: ${step.instruction}`;

        try {
          if (crossChecked) {
            const workers = ranked.slice(0, Math.min(3, ranked.length));
            const judge = pickJudge(this.connectors, workers);
            const cc = await crossCheck(step, taskPrompt, workers, judge, WORKER_SYSTEM, cost, audit);
            st.output = cc.final;
            st.models = [...cc.workerIds, `judge:${cc.judgeId}`];
            st.crossCheck = cc;
            st.status = cc.flagged ? "flagged" : "done";
          } else {
            const worker = ranked[0];
            const r = await worker.run({ system: WORKER_SYSTEM, prompt: taskPrompt });
            cost.add(worker, r);
            audit.log("step.worker", { step: step.id, by: worker.card.id, ms: r.latencyMs, tokens: [r.inputTokens, r.outputTokens] });
            st.output = r.text;
            st.models = [worker.card.id];
            st.status = "done";
          }
          job.context += `\n[Step ${step.id}] ${st.output}`;
        } catch (e) {
          st.status = "failed";
          st.note = errMsg(e);
          audit.log("step.error", { step: step.id, error: st.note });
        }
        await this.persist(job);
      }
      await this.finalize(job, cost, audit);
    } catch (e) {
      job.status = "failed";
      job.error = errMsg(e);
      for (const st of job.steps) if (st.status === "running") st.status = "failed";
      audit.log("run.error", { error: job.error });
      this.active.delete(job.id);
      await this.persist(job);
    }
  }

  private async finalize(job: Job, cost: CostTracker, audit: AuditLike) {
    const outcomes: StepOutcome[] = job.steps.map((s) => ({
      step: s.step,
      output: s.output ?? "",
      modelsUsed: s.models,
      crossCheck: s.crossCheck,
      skipped: s.status === "skipped" || s.status === "failed" || s.status === "pending" ? s.note ?? "Not run" : undefined,
    }));
    const done = outcomes.filter((o) => !o.skipped);

    let body = "_No steps completed._";
    if (done.length) {
      const fallback = done.map((o) => `## ${o.step.title}\n${o.output}`).join("\n\n");
      try {
        const writer = pickByStrength(this.connectors, "writing");
        const wr = await writer.run({
          system: WRITER_SYSTEM,
          prompt: `Goal: ${job.goal}\n\nVerified step outputs:\n${fallback}`,
          maxTokens: 3000,
        });
        cost.add(writer, wr);
        audit.log("report.written", { by: writer.card.id });
        body = wr.text;
      } catch (e) {
        audit.log("report.writer_failed", { error: errMsg(e) });
        body = `_The report writer failed, so these are the raw step results._\n\n${fallback}`;
      }
    }

    job.report = buildReport({
      goal: job.goal,
      body,
      outcomes,
      rows: cost.summary(),
      total: cost.total,
      cap: this.policy.maxUsdPerRun,
    });
    job.status = job.capHit ? "cap_reached" : "done";
    audit.log("run.end", { totalUsd: cost.total, flagged: job.steps.filter((s) => s.status === "flagged").length });
    this.active.delete(job.id);
    await this.persist(job);
  }
}
