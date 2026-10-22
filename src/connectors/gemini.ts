import type { Connector } from "../types.js";
import { postJson } from "../http.js";
import { num } from "../util.js";

export function geminiConnector(): Connector | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-pro";
  return {
    card: {
      id: "gemini",
      provider: "gemini",
      model,
      strengths: ["research", "data", "analysis", "summarizing"],
      costTier: 1,
      priceInPerMTok: num(process.env.GEMINI_PRICE_IN, 1.25), // PLACEHOLDER
      priceOutPerMTok: num(process.env.GEMINI_PRICE_OUT, 10), // PLACEHOLDER
    },
    async run(req) {
      const t0 = Date.now();
      const data = await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        { "x-goog-api-key": key },
        {
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: "user", parts: [{ text: req.prompt }] }],
        }
      );
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p: any) => p.text ?? "")
        .join("");
      return {
        text,
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        latencyMs: Date.now() - t0,
      };
    },
  };
}
