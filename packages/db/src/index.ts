import Database from "better-sqlite3";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

const dir = resolve(process.env.OPTIMUS_DATA_DIR ?? "./data");
mkdirSync(dir, { recursive: true });
export const db = new Database(join(dir, "optimus.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO settings(key,value) VALUES ('paused','false');
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', result TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  action TEXT NOT NULL, resource TEXT NOT NULL, payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS external_events (
  id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL, event_type TEXT NOT NULL, repo TEXT, body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
  summary TEXT NOT NULL, body TEXT NOT NULL, source_message_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  memory_id UNINDEXED, title, summary, body, tokenize='porter unicode61'
);
CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY, task_id TEXT, actor TEXT NOT NULL,
  event_type TEXT NOT NULL, payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export function audit(
  taskId: string | null,
  actor: string,
  eventType: string,
  payload: object,
) {
  db.prepare(
    `INSERT INTO audit(id,task_id,actor,event_type,payload) VALUES(?,?,?,?,?)`,
  ).run(randomUUID(), taskId, actor, eventType, JSON.stringify(payload));
}
export function createTask(repo: string, objective: string) {
  const id = randomUUID();
  db.prepare(`INSERT INTO tasks(id,repo,objective) VALUES(?,?,?)`).run(
    id,
    repo,
    objective,
  );
  audit(id, "system", "task.created", { repo, objective });
  return id;
}
export function setTaskStatus(id: string, status: string, result?: string) {
  db.prepare(
    `UPDATE tasks SET status=?,result=COALESCE(?,result),updated_at=datetime('now') WHERE id=?`,
  ).run(status, result ?? null, id);
  audit(id, "system", "task.status", { status });
}
export function listTasks() {
  return db
    .prepare(
      `SELECT t.*, a.id AS approval_id,a.status AS approval_status,a.payload_hash
    FROM tasks t LEFT JOIN approvals a ON a.task_id=t.id ORDER BY t.created_at DESC LIMIT 100`,
    )
    .all();
}
export function getTask(id: string) {
  return db.prepare(`SELECT * FROM tasks WHERE id=?`).get(id) as
    { id: string; repo: string; objective: string; status: string } | undefined;
}
export function saveApproval(
  taskId: string,
  action: string,
  resource: string,
  payloadHash: string,
) {
  const existing = db
    .prepare(
      `SELECT id,action,resource,payload_hash FROM approvals WHERE task_id=?`,
    )
    .get(taskId) as
    | { id: string; action: string; resource: string; payload_hash: string }
    | undefined;
  if (existing) {
    if (
      existing.action !== action ||
      existing.resource !== resource ||
      existing.payload_hash !== payloadHash
    )
      throw Error("Conflicting approval payload");
    return existing.id;
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO approvals(id,task_id,action,resource,payload_hash) VALUES(?,?,?,?,?)`,
  ).run(id, taskId, action, resource, payloadHash);
  audit(taskId, "system", "approval.requested", {
    id,
    action,
    resource,
    payloadHash,
  });
  return id;
}
export function getApproval(id: string) {
  return db.prepare(`SELECT * FROM approvals WHERE id=?`).get(id) as
    | {
        id: string;
        task_id: string;
        action: string;
        resource: string;
        payload_hash: string;
        status: string;
      }
    | undefined;
}
export function decideApproval(
  id: string,
  taskId: string,
  status: "approved" | "rejected",
  actor: string,
) {
  const approval = getApproval(id);
  if (!approval || approval.task_id !== taskId)
    throw new Error("Unknown approval");
  if (approval.status !== "pending" && approval.status !== status)
    throw new Error("Approval already decided differently");
  if (approval.status === "pending") {
    db.prepare(
      `UPDATE approvals SET status=?,decided_by=?,decided_at=datetime('now') WHERE id=? AND status='pending'`,
    ).run(status, actor, id);
    audit(taskId, actor, "approval.decided", { id, status });
  }
}
export function recordExternalEvent(event: {
  source: string;
  type: string;
  repo?: string;
  summary: string;
  externalId: string;
}): boolean {
  const fingerprint = createHash("sha256")
    .update(`${event.source}:${event.externalId}`)
    .digest("hex");
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO external_events(id,fingerprint,source,event_type,repo,body)
    VALUES(?,?,?,?,?,?)`,
    )
    .run(
      randomUUID(),
      fingerprint,
      event.source,
      event.type,
      event.repo ?? null,
      JSON.stringify(event),
    );
  return result.changes > 0;
}
export function remember(input: {
  kind: string;
  title: string;
  summary: string;
  body: string;
  sourceMessageId: string;
}) {
  const id = randomUUID();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO memories(id,kind,title,summary,body,source_message_id) VALUES(?,?,?,?,?,?)`,
    ).run(
      id,
      input.kind,
      input.title,
      input.summary,
      input.body,
      input.sourceMessageId,
    );
    db.prepare(
      `INSERT INTO memories_fts(memory_id,title,summary,body) VALUES(?,?,?,?)`,
    ).run(id, input.title, input.summary, input.body);
  })();
  return id;
}
export function searchMemories(query: string, limit = 8) {
  const terms = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? [];
  if (!terms.length) return [];
  const phrase = terms.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR ");
  return db
    .prepare(
      `SELECT memory_id,title,summary,snippet(memories_fts,3,'[',']','...',12) AS excerpt,
    bm25(memories_fts) AS score FROM memories_fts WHERE memories_fts MATCH ? ORDER BY score LIMIT ?`,
    )
    .all(phrase, Math.min(20, Math.max(1, limit))) as {
    memory_id: string;
    title: string;
    summary: string;
    excerpt: string;
    score: number;
  }[];
}

export function isPaused(): boolean {
  return (
    (
      db.prepare(`SELECT value FROM settings WHERE key='paused'`).get() as
        { value: string } | undefined
    )?.value === "true"
  );
}
export function setPaused(paused: boolean) {
  db.prepare(
    `INSERT INTO settings(key,value) VALUES('paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(String(paused));
  audit(null, "local-owner", "agent.pause", { paused });
}
