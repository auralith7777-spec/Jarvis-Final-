import { existsSync, readFileSync } from "node:fs";
import type { Step } from "./types.js";

export interface Policy {
  maxUsdPerRun: number;
  crossCheckAlways: boolean;
  /** step text containing any of these needs a human click first */
  requireApproval: string[];
  /** step text containing any of these is refused outright */
  blocked: string[];
}

const DEFAULT: Policy = {
  maxUsdPerRun: 1,
  crossCheckAlways: false,
  requireApproval: ["send email", "publish", "purchase", "delete"],
  blocked: ["password", "bank account", "credit card"],
};

export function loadPolicy(path = "policy.json"): Policy {
  if (!existsSync(path)) return DEFAULT;
  return { ...DEFAULT, ...JSON.parse(readFileSync(path, "utf8")) };
}

export type Verdict =
  | { action: "allow" }
  | { action: "approve"; reason: string }
  | { action: "block"; reason: string };

export function evaluateStep(step: Step, policy: Policy): Verdict {
  const text = `${step.title} ${step.instruction}`.toLowerCase();
  const hitBlock = policy.blocked.find((k) => text.includes(k.toLowerCase()));
  if (hitBlock) return { action: "block", reason: `matches blocked rule "${hitBlock}"` };
  const hitApprove = policy.requireApproval.find((k) => text.includes(k.toLowerCase()));
  if (hitApprove) return { action: "approve", reason: `matches approval rule "${hitApprove}"` };
  return { action: "allow" };
}
