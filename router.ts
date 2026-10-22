import type { Connector, Step } from "./types.js";

function score(c: Connector, step: Step): number {
  const match = step.tags.filter((t) => c.card.strengths.includes(t)).length;
  // more matching strengths wins; on ties prefer the cheaper tier
  return match * 10 - c.card.costTier;
}

/** Best-fit agents for a step, best first. */
export function rank(connectors: Connector[], step: Step): Connector[] {
  return [...connectors].sort((a, b) => score(b, step) - score(a, step));
}

/** Pick a judge that did NOT write any of the answers, when possible. */
export function pickJudge(connectors: Connector[], workers: Connector[]): Connector {
  const workerIds = new Set(workers.map((w) => w.card.id));
  const outsiders = connectors.filter((c) => !workerIds.has(c.card.id));
  const pool = outsiders.length ? outsiders : connectors;
  return pool.find((c) => c.card.strengths.includes("judging")) ?? pool[0];
}

export function pickByStrength(connectors: Connector[], strength: string): Connector {
  return connectors.find((c) => c.card.strengths.includes(strength)) ?? connectors[0];
}
