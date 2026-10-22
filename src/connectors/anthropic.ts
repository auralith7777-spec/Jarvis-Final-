import type { Connector } from "../types.js";
import { postJson } from "../http.js";
import { num } from "../util.js";

export function anthropicConnector(): Connector | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
  return {
    card: {
      id: "claude",
      provider: "anthropic",
      model,
      strengths: ["writing", "code", "analysis", "planning", "judging"],
      costTier: 2,
      priceInPerMTok: num(process.env.ANTHROPIC_PRICE_IN, 3), // PLACEHOLDER
      priceOutPerMTok: num(process.env.ANTHROPIC_PRICE_OUT, 15), // PLACEHOLDER
    },
    async run(req) {
      const t0 = Date.now();
      const data = await postJson(
        "https://api.anthropic.com/v1/messages",
        { "x-api-key": key, "anthropic-version": "2023-06-01" },
        {
          model,
          max_tokens: req.maxTokens ?? 2000,
          system: req.system,
          messages: [{ role: "user", content: req.prompt }],
        }
      );
      const text = (data.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      return {
        text,
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
        latencyMs: Date.now() - t0,
      };
    },
  };
}
