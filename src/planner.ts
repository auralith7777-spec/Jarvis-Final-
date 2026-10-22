import type { Connector, Step } from "./types.js";
import { extractJson } from "./util.js";
import type { CostTracker } from "./cost.js";
import type { AuditLike } from "./audit.js";

const SYSTEM = `ROLE:PLANNER
You break a goal into a short, ordered plan for a team of AI agents.
Return ONLY a JSON array (no prose, no markdown) of at most 5 steps.
Each step: {"id": number, "title": string, "instruction": string, "tags": string[], "risk": "low"|"high"}.
tags come from: research, data, analysis, writing, code, summarizing.
risk is "high" for anything involving facts, figures, claims or actions that matter; otherwise "low".
Keep steps concrete and self-contained.`;

export async function planGoal(
  goal: string,
  planner: Connector,
  cost: CostTracker,
  audit: AuditLike
): Promise<Step[]> {
  const res = await planner.run({ system: SYSTEM, prompt: `Goal: ${goal}`, maxTokens: 1200 });
  cost.add(planner, res);
  audit.log("plan.raw", { by: planner.card.id, tokens: [res.inputTokens, res.outputTokens] });
  const steps = extractJson<Step[]>(res.text);
  if (!Array.isArray(steps) || !steps.length) throw new Error("Planner returned no steps");
  return steps.slice(0, 5).map((s, i) => ({
    id: i + 1,
    title: String(s.title ?? `Step ${i + 1}`),
    instruction: String(s.instruction ?? ""),
    tags: Array.isArray(s.tags) ? s.tags.map(String) : ["research"],
    risk: s.risk === "high" ? "high" : "low",
  }));
}
