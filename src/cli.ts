import "dotenv/config";
import { loadConnectors } from "./connectors/index.js";
import { loadPolicy } from "./policy.js";
import { runJob } from "./orchestrator.js";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const goal = args.filter((a) => !a.startsWith("--")).join(" ").trim();

if (!goal) {
  console.log('Usage: npm run jarvis -- [--mock] [--yes] "your goal"');
  console.log("  --mock  use offline fake agents (no API keys needed)");
  console.log("  --yes   auto-approve every prompt (demo/testing only)");
  process.exit(1);
}

try {
  await runJob({
    goal,
    connectors: loadConnectors(flags.has("--mock")),
    policy: loadPolicy(),
    autoYes: flags.has("--yes"),
    outDir: "output",
  });
} catch (e) {
  console.error("Jarvis error:", e instanceof Error ? e.message : e);
  process.exit(1);
}
