import { createInterface } from "node:readline/promises";

export async function ask(question: string, autoYes: boolean): Promise<boolean> {
  if (autoYes) {
    console.log(`${question} [auto-yes]`);
    return true;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}
