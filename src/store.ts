import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import type { Job, JobSummary } from "./job.js";

export interface Store {
  init(): Promise<void>;
  get(id: string): Promise<Job | null>;
  list(): Promise<JobSummary[]>;
  save(job: Job): Promise<void>;
}

const summary = (j: Job): JobSummary => ({ id: j.id, goal: j.goal, status: j.status, createdAt: j.createdAt });

/** Local development: one JSON file per job. (Render's free disk is not permanent, so use Postgres there.) */
export class FileStore implements Store {
  constructor(private dir = "data/jobs") {}
  async init() {
    mkdirSync(this.dir, { recursive: true });
  }
  async get(id: string) {
    try {
      return JSON.parse(readFileSync(join(this.dir, `${id}.json`), "utf8")) as Job;
    } catch {
      return null;
    }
  }
  async list() {
    const jobs: JobSummary[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        jobs.push(summary(JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Job));
      } catch {
        /* skip unreadable file */
      }
    }
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
  }
  async save(job: Job) {
    const file = join(this.dir, `${job.id}.json`);
    writeFileSync(file + ".tmp", JSON.stringify(job));
    renameSync(file + ".tmp", file);
  }
}

/** Production: Postgres. The whole job is one JSONB document, so there is no schema to migrate. */
export class PgStore implements Store {
  private pool: pg.Pool;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      // Render's internal URL needs no SSL. Set PGSSL=1 when using an external URL.
      ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : undefined,
      max: 5,
    });
  }
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id text PRIMARY KEY,
        status text NOT NULL,
        goal text NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        data jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs (created_at DESC);
    `);
  }
  async get(id: string) {
    const r = await this.pool.query("SELECT data FROM jobs WHERE id = $1", [id]);
    return r.rows[0] ? (r.rows[0].data as Job) : null;
  }
  async list() {
    const r = await this.pool.query(
      "SELECT id, goal, status, created_at FROM jobs ORDER BY created_at DESC LIMIT 50"
    );
    return r.rows.map((x) => ({
      id: x.id as string,
      goal: x.goal as string,
      status: x.status as Job["status"],
      createdAt: new Date(x.created_at).toISOString(),
    }));
  }
  async save(job: Job) {
    await this.pool.query(
      `INSERT INTO jobs (id, status, goal, created_at, updated_at, data)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET status = $2, updated_at = $5, data = $6`,
      [job.id, job.status, job.goal, job.createdAt, job.updatedAt, JSON.stringify(job)]
    );
  }
}
