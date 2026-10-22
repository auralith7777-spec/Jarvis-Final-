import type { Connector, RunRequest } from "../types.js";

/**
 * Offline fake agents so you can demo the whole loop with no API keys.
 * mock-b deliberately disagrees on a number so the cross-check path shows up.
 */
function make(id: string, strengths: string[], marketSize: string): Connector {
  return {
    card: {
      id,
      provider: "mock",
      model: "mock-1",
      strengths,
      costTier: 1,
      priceInPerMTok: 1,
      priceOutPerMTok: 2,
    },
    async run(req: RunRequest) {
      const t0 = Date.now();
      const sys = req.system;
      let text: string;
      if (sys.includes("ROLE:PLANNER")) {
        text = JSON.stringify([
          { id: 1, title: "Map the landscape", instruction: "List the main players and categories in this market.", tags: ["research"], risk: "low" },
          { id: 2, title: "Size the market", instruction: "Give market size and growth with sources.", tags: ["research", "data"], risk: "high" },
          { id: 3, title: "Find the gaps", instruction: "Identify unmet needs and weak spots in current products.", tags: ["analysis"], risk: "low" },
          { id: 4, title: "Send findings to the team by email", instruction: "Send an email with the findings to the team.", tags: ["writing"], risk: "low" },
        ]);
      } else if (sys.includes("ROLE:JUDGE")) {
        text = JSON.stringify({
          agreement: false,
          conflicts: ["Market size differs between answers ($8.5B vs $12B). Sources not independently verifiable."],
          final: "Estimates for market size range from roughly $8.5B to $12B depending on the source; treat the figure as an approximate range, not a fact.",
          confidence: 0.55,
          flagged: true,
        });
      } else if (sys.includes("ROLE:WRITER")) {
        text = "## Summary\n\nThis is a mock report assembled from the step outputs below. Replace mock connectors with real API keys to get real content.\n\n" + req.prompt.slice(0, 1200);
      } else {
        text = `[${id}] Findings: the market is growing fast. Estimated market size: ${marketSize}. Key players and gaps identified (mock content).`;
      }
      return {
        text,
        inputTokens: Math.ceil((sys.length + req.prompt.length) / 4),
        outputTokens: Math.ceil(text.length / 4),
        latencyMs: Date.now() - t0 + 5,
      };
    },
  };
}

export function mockConnectors(): Connector[] {
  return [
    make("mock-a", ["research", "analysis", "planning", "judging"], "$8.5B"),
    make("mock-b", ["research", "data", "writing"], "$12B"),
    make("mock-c", ["analysis", "writing", "summarizing", "judging"], "$8.5B"),
  ];
}
