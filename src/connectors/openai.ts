import type { Connector } from "../types.js";
import { postJson } from "../http.js";
import { num } from "../util.js";

export function openaiConnector(): Connector | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const model = process.env.OPENAI_MODEL ?? "gpt-5";
  return {
    card: {
      id: "gpt",
      provider: "openai",
      model,
      strengths: ["research", "data", "code", "analysis", "judging"],
      costTier: 2,
      priceInPerMTok: num(process.env.OPENAI_PRICE_IN, 2.5), // PLACEHOLDER
      priceOutPerMTok: num(process.env.OPENAI_PRICE_OUT, 10), // PLACEHOLDER
    },
    async run(req) {
      const t0 = Date.now();
      const data = await postJson(
        "https://api.openai.com/v1/chat/completions",
        { authorization: `Bearer ${key}` },
        {
          model,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.prompt },
          ],
        }
      );
      return {
        text: data.choices?.[0]?.message?.content ?? "",
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        latencyMs: Date.now() - t0,
      };
    },
  };
}
