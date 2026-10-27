import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Prisma, PrismaClient } from "../generated/prisma/client.ts";

const dir = resolve(process.env.OPTIMUS_DATA_DIR ?? "./data");
mkdirSync(dir, { recursive: true });
const databaseFile = join(dir, "optimus.sqlite");

export const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url: `file:${databaseFile}` }),
});

const statements = [
  `CREATE TABLE IF NOT EXISTS "settings" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repo" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "result" TEXT,
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "approvals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_by" TEXT,
    "decided_at" TEXT,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "approvals_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "approvals_task_id_key" ON "approvals"("task_id")`,
  `CREATE TABLE IF NOT EXISTS "external_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fingerprint" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "repo" TEXT,
    "body" TEXT NOT NULL,
    "created_at" TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "external_events_fingerprint_key" ON "external_events"("fingerprint")`,
  `CREATE TABLE IF NOT EXISTS "memories" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "source_message_id" TEXT NOT NULL,
    "created_at" TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "audit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT,
    "actor" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "created_at" TEXT NOT NULL
  )`,
  // FTS5 virtual tables cannot be declared in schema.prisma.
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    memory_id UNINDEXED, title, summary, body, tokenize='porter unicode61'
  )`,
];

function now() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

let schemaError: unknown;
const ready = ensureSchema().catch((error: unknown) => {
  schemaError = error;
});

async function ensureSchema() {
  await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON");
  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement);
  }
  await prisma.setting.upsert({
    where: { key: "paused" },
    create: { key: "paused", value: "false" },
    update: {},
  });
}

async function readyDb() {
  await ready;
  if (schemaError) throw schemaError;
}

export async function closeDb() {
  await readyDb();
  await prisma.$disconnect();
}

function isUniqueViolation(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

export type TaskRow = {
  id: string;
  repo: string;
  objective: string;
  status: string;
};

export type ApprovalRow = {
  id: string;
  task_id: string;
  action: string;
  resource: string;
  payload_hash: string;
  status: string;
};

export type TaskListItem = {
  id: string;
  repo: string;
  objective: string;
  status: string;
  result: string | null;
  created_at: string;
  updated_at: string;
  approval_id: string | null;
  approval_status: string | null;
  payload_hash: string | null;
};

export async function audit(
  taskId: string | null,
  actor: string,
  eventType: string,
  payload: object,
) {
  await readyDb();
  await prisma.auditEvent.create({
    data: {
      id: randomUUID(),
      taskId,
      actor,
      eventType,
      payload: JSON.stringify(payload),
      createdAt: now(),
    },
  });
}

export async function createTask(repo: string, objective: string) {
  await readyDb();
  const id = randomUUID();
  const timestamp = now();
  await prisma.task.create({
    data: {
      id,
      repo,
      objective,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  });
  await audit(id, "system", "task.created", { repo, objective });
  return id;
}

export async function setTaskStatus(id: string, status: string, result?: string) {
  await readyDb();
  await prisma.task.update({
    where: { id },
    data: {
      status,
      ...(result !== undefined ? { result } : {}),
      updatedAt: now(),
    },
  });
  await audit(id, "system", "task.status", { status });
}

export async function listTasks(): Promise<TaskListItem[]> {
  await readyDb();
  const tasks = await prisma.task.findMany({
    include: { approval: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return tasks.map((task) => ({
    id: task.id,
    repo: task.repo,
    objective: task.objective,
    status: task.status,
    result: task.result,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    approval_id: task.approval?.id ?? null,
    approval_status: task.approval?.status ?? null,
    payload_hash: task.approval?.payloadHash ?? null,
  }));
}

export async function getTask(id: string): Promise<TaskRow | undefined> {
  await readyDb();
  const task = await prisma.task.findUnique({ where: { id } });
  if (!task) return undefined;
  return {
    id: task.id,
    repo: task.repo,
    objective: task.objective,
    status: task.status,
  };
}

export async function saveApproval(
  taskId: string,
  action: string,
  resource: string,
  payloadHash: string,
) {
  await readyDb();
  const existing = await prisma.approval.findUnique({ where: { taskId } });
  if (existing) {
    if (
      existing.action !== action ||
      existing.resource !== resource ||
      existing.payloadHash !== payloadHash
    ) {
      throw Error("Conflicting approval payload");
    }
    return existing.id;
  }
  const id = randomUUID();
  await prisma.approval.create({
    data: {
      id,
      taskId,
      action,
      resource,
      payloadHash,
      createdAt: now(),
    },
  });
  await audit(taskId, "system", "approval.requested", {
    id,
    action,
    resource,
    payloadHash,
  });
  return id;
}

export async function getApproval(id: string): Promise<ApprovalRow | undefined> {
  await readyDb();
  const approval = await prisma.approval.findUnique({ where: { id } });
  if (!approval) return undefined;
  return {
    id: approval.id,
    task_id: approval.taskId,
    action: approval.action,
    resource: approval.resource,
    payload_hash: approval.payloadHash,
    status: approval.status,
  };
}

export async function decideApproval(
  id: string,
  taskId: string,
  status: "approved" | "rejected",
  actor: string,
) {
  const approval = await getApproval(id);
  if (!approval || approval.task_id !== taskId) {
    throw new Error("Unknown approval");
  }
  if (approval.status !== "pending" && approval.status !== status) {
    throw new Error("Approval already decided differently");
  }
  if (approval.status === "pending") {
    await prisma.approval.updateMany({
      where: { id, status: "pending" },
      data: { status, decidedBy: actor, decidedAt: now() },
    });
    await audit(taskId, actor, "approval.decided", { id, status });
  }
}

export async function recordExternalEvent(event: {
  source: string;
  type: string;
  repo?: string;
  summary: string;
  externalId: string;
}): Promise<boolean> {
  await readyDb();
  const fingerprint = createHash("sha256")
    .update(`${event.source}:${event.externalId}`)
    .digest("hex");
  try {
    await prisma.externalEvent.create({
      data: {
        id: randomUUID(),
        fingerprint,
        source: event.source,
        eventType: event.type,
        repo: event.repo ?? null,
        body: JSON.stringify(event),
        createdAt: now(),
      },
    });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

export async function remember(input: {
  kind: string;
  title: string;
  summary: string;
  body: string;
  sourceMessageId: string;
}) {
  await readyDb();
  const id = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.memory.create({
      data: {
        id,
        kind: input.kind,
        title: input.title,
        summary: input.summary,
        body: input.body,
        sourceMessageId: input.sourceMessageId,
        createdAt: now(),
      },
    });
    await tx.$executeRaw`INSERT INTO memories_fts(memory_id, title, summary, body) VALUES (${id}, ${input.title}, ${input.summary}, ${input.body})`;
  });
  return id;
}

export async function searchMemories(query: string, limit = 8) {
  await readyDb();
  const terms = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? [];
  if (!terms.length) return [];
  const phrase = terms.map((term) => `"${term.replaceAll('"', "")}"`).join(" OR ");
  const rows = await prisma.$queryRaw<
    {
      memory_id: string;
      title: string;
      summary: string;
      excerpt: string;
      score: number;
    }[]
  >`SELECT memory_id, title, summary, snippet(memories_fts, 3, '[', ']', '...', 12) AS excerpt,
    bm25(memories_fts) AS score FROM memories_fts WHERE memories_fts MATCH ${phrase} ORDER BY score LIMIT ${Math.min(20, Math.max(1, limit))}`;
  return rows.map((row) => ({ ...row, score: Number(row.score) }));
}

export async function isPaused(): Promise<boolean> {
  await readyDb();
  const setting = await prisma.setting.findUnique({ where: { key: "paused" } });
  return setting?.value === "true";
}

export async function setPaused(paused: boolean) {
  await readyDb();
  await prisma.setting.upsert({
    where: { key: "paused" },
    create: { key: "paused", value: String(paused) },
    update: { value: String(paused) },
  });
  await audit(null, "local-owner", "agent.pause", { paused });
}
