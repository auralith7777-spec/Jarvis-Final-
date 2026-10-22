import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export interface AuditLike {
  log(event: string, data?: Record<string, unknown>): void;
}

/** Append-only JSONL log. Every plan, model call, check and approval lands here. */
export class Audit implements AuditLike {
  readonly file: string;
  constructor(readonly runId: string, dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `run-${runId}.jsonl`);
  }
  log(event: string, data: Record<string, unknown> = {}) {
    const line = JSON.stringify({ t: new Date().toISOString(), runId: this.runId, event, ...data });
    appendFileSync(this.file, line + "\n");
  }
}
