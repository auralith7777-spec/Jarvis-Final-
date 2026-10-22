import type { Connector } from "../types.js";
import { anthropicConnector } from "./anthropic.js";
import { openaiConnector } from "./openai.js";
import { geminiConnector } from "./gemini.js";
import { mockConnectors } from "./mock.js";

/** Register every connector that has a key. To add a new agent: write one adapter, add it here. */
export function loadConnectors(useMock: boolean): Connector[] {
  if (useMock) return mockConnectors();
  return [anthropicConnector(), openaiConnector(), geminiConnector()].filter(
    (c): c is Connector => c !== null
  );
}
