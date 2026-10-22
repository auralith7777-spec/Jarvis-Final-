import type { CrossCheckResult, Step } from "./types.js";
import type { CostRow } from "./report.js";

export type JobStatus =
  | "planning"
  | "awaiting_plan"
  | "running"
  | "awaiting_step"
  | "done"
  | "rejected"
  | "failed"
  | "cap_reached";

export type StepStatus = "pending" | "running" | "done" | "flagged" | "skipped" | "failed";

export interface StepState {
  step: Step;
  /** "approval" = policy says a human must click before this step runs */
  gate: "none" | "approval";
  status: StepStatus;
  models: string[];
  output?: string;
  crossCheck?: CrossCheckResult;
  note?: string;
}

export interface JobEvent {
  t: string;
  event: string;
  [k: string]: unknown;
}

export interface Job {
  id: string;
  goal: string;
  status: JobStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
  agents: string[];
  steps: StepState[];
  blocked: { title: string; reason: string }[];
  /** index into steps of the next step to run */
  cursor: number;
  pendingStep?: number;
  /** step.id -> approved? */
  approvals: Record<string, boolean>;
  context: string;
  events: JobEvent[];
  costRows: CostRow[];
  costTotal: number;
  capUsd: number;
  capHit: boolean;
  report?: string;
}

export interface JobSummary {
  id: string;
  goal: string;
  status: JobStatus;
  createdAt: string;
}
