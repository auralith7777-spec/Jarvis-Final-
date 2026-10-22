import type { StepOutcome } from "./types.js";

export interface CostRow { id: string; calls: number; inTok: number; outTok: number; usd: number }

export function buildReport(p: {
  goal: string;
  body: string;
  outcomes: StepOutcome[];
  rows: CostRow[];
  total: number;
  cap: number;
}): string {
  const flagged = p.outcomes.filter((o) => o.crossCheck?.flagged);
  return (
    `# ${p.goal}\n\n${p.body}\n\n---\n\n## Needs your review\n\n` +
    (flagged.length
      ? flagged
          .map(
            (o) =>
              `- **Step ${o.step.id} – ${o.step.title}** (confidence ${o.crossCheck!.confidence.toFixed(2)})\n` +
              o.crossCheck!.conflicts.map((c) => `  - ${c}`).join("\n")
          )
          .join("\n")
      : "Nothing flagged.") +
    `\n\n## Provenance\n\n| Step | Models | Checked | Result |\n|---|---|---|---|\n` +
    p.outcomes
      .map((o) => {
        const checked = o.crossCheck ? (o.crossCheck.agreement ? "agreed" : "conflict") : "single model";
        const result = o.skipped ?? (o.crossCheck?.flagged ? "flagged" : "ok");
        return `| ${o.step.id}. ${o.step.title} | ${o.modelsUsed.join(", ") || "-"} | ${checked} | ${result} |`;
      })
      .join("\n") +
    `\n\n## Cost\n\n| Agent | Calls | In tok | Out tok | USD |\n|---|---|---|---|---|\n` +
    p.rows.map((r) => `| ${r.id} | ${r.calls} | ${r.inTok} | ${r.outTok} | $${r.usd.toFixed(4)} |`).join("\n") +
    `\n\n**Total: $${p.total.toFixed(4)}** (cap $${p.cap}). Prices are estimates from your config.\n`
  );
}
