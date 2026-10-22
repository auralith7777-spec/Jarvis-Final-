export interface CapabilityCard {
  id: string;
  provider: "anthropic" | "openai" | "gemini" | "mock";
  model: string;
  /** What this agent is good at. The router matches these against step tags. */
  strengths: string[];
  /** 1 = cheap/fast, 3 = expensive/strong */
  costTier: 1 | 2 | 3;
  /** USD per 1M tokens. Defaults are placeholders: set your own in .env */
  priceInPerMTok: number;
  priceOutPerMTok: number;
}

export interface RunRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
}

export interface RunResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/**
 * Every agent plugs in through this one interface.
 * Today: request/response. Later: add status(jobId) and cancel(jobId)
 * for long-running agents (webhooks, MCP tasks).
 */
export interface Connector {
  card: CapabilityCard;
  run(req: RunRequest): Promise<RunResult>;
}

export type Risk = "low" | "high";

export interface Step {
  id: number;
  title: string;
  instruction: string;
  /** e.g. "research", "writing", "code", "analysis", "data" */
  tags: string[];
  /** high = facts, numbers, anything that matters: gets cross-checked */
  risk: Risk;
}

export interface CrossCheckResult {
  final: string;
  agreement: boolean;
  confidence: number; // 0..1
  conflicts: string[];
  /** true = Jarvis could not settle it: a human should look */
  flagged: boolean;
  judgeId: string;
  workerIds: string[];
}

export interface StepOutcome {
  step: Step;
  output: string;
  modelsUsed: string[];
  crossCheck?: CrossCheckResult;
  skipped?: string;
}
