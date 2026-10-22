import type { Connector, RunResult } from "./types.js";

interface Row { calls: number; inTok: number; outTok: number; usd: number }

export class CostTracker {
  private rows = new Map<string, Row>();
  constructor(readonly capUsd: number) {}

  add(c: Connector, r: RunResult): number {
    const usd =
      (r.inputTokens / 1e6) * c.card.priceInPerMTok +
      (r.outputTokens / 1e6) * c.card.priceOutPerMTok;
    const row = this.rows.get(c.card.id) ?? { calls: 0, inTok: 0, outTok: 0, usd: 0 };
    row.calls++;
    row.inTok += r.inputTokens;
    row.outTok += r.outputTokens;
    row.usd += usd;
    this.rows.set(c.card.id, row);
    return usd;
  }

  /** Rebuild from saved rows (used when a job resumes after approval). */
  restore(rows: { id: string; calls: number; inTok: number; outTok: number; usd: number }[]) {
    this.rows.clear();
    for (const r of rows) this.rows.set(r.id, { calls: r.calls, inTok: r.inTok, outTok: r.outTok, usd: r.usd });
  }

  get total(): number {
    return [...this.rows.values()].reduce((s, r) => s + r.usd, 0);
  }

  get overCap(): boolean {
    return this.total > this.capUsd;
  }

  summary() {
    return [...this.rows.entries()].map(([id, r]) => ({ id, ...r }));
  }
}
