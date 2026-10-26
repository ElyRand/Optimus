import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@temporalio/client";

const dataDir = mkdtempSync(join(tmpdir(), "optimus-test-"));
process.env.OPTIMUS_DATA_DIR = dataDir;
process.env.LIVE_HARNESS = "false";
process.env.APPROVED_REPOS = "owner/repo";
delete process.env.SLACK_BOT_TOKEN;
delete process.env.SLACK_APP_TOKEN;
delete process.env.SLACK_OWNER_ID;
const store = await import("../packages/db/src/index.ts");
const { prepare, finalize } = await import("../apps/worker/src/activities.ts");
const { createApi } = await import("../apps/api/src/app.ts");
const { proposalHash } = await import("../packages/contracts/src/action.ts");

after(() => {
  store.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  store.setPaused(false);
  process.env.APPROVED_REPOS = "owner/repo";
});

async function proposal() {
  const taskId = store.createTask(
    "owner/repo",
    "Investigate failing CI safely.",
  );
  const input = {
    taskId,
    repo: "owner/repo",
    objective: "Investigate failing CI safely.",
  };
  const result = await prepare(input);
  assert.equal(result.state, "prepared");
  if (result.state !== "prepared") throw Error("No proposal");
  return { ...input, approvalId: result.approvalId };
}

test("dry-run proposal is persisted and retries reuse its exact approval", async () => {
  const input = await proposal();
  const second = await prepare(input);
  assert.equal(
    second.state === "prepared" && second.approvalId,
    input.approvalId,
  );
  assert.equal(
    store.getApproval(input.approvalId)?.payload_hash,
    proposalHash(input),
  );
  assert.equal(
    (await finalize(input.taskId, input.approvalId)).status,
    "blocked",
  );
});

test("approved action completes only as a simulation", async () => {
  const p = await proposal();
  store.decideApproval(p.approvalId, p.taskId, "approved", "local-owner");
  const outcome = await finalize(p.taskId, p.approvalId);
  assert.equal(outcome.status, "completed");
  assert.match(outcome.message, /NO PR published/);
  assert.throws(() =>
    store.decideApproval(p.approvalId, p.taskId, "rejected", "local-owner"),
  );
});

test("changing a task after approval invalidates the payload hash", async () => {
  const p = await proposal();
  store.decideApproval(p.approvalId, p.taskId, "approved", "local-owner");
  store.db
    .prepare("UPDATE tasks SET objective=? WHERE id=?")
    .run("Publish something else", p.taskId);
  assert.equal((await finalize(p.taskId, p.approvalId)).status, "blocked");
  await assert.rejects(
    prepare({ ...p, objective: "Publish something else" }),
    /Conflicting approval/,
  );
});

test("an approval cannot authorize a different mission", async () => {
  const p = await proposal();
  store.decideApproval(p.approvalId, p.taskId, "approved", "local-owner");
  const other = store.createTask("owner/repo", "Another mission");
  assert.equal((await finalize(other, p.approvalId)).status, "blocked");
});

test("pause and revoked repository permission block an approved action", async () => {
  const p = await proposal();
  store.decideApproval(p.approvalId, p.taskId, "approved", "local-owner");
  store.setPaused(true);
  assert.equal((await finalize(p.taskId, p.approvalId)).status, "blocked");
  assert.equal((await prepare(p)).state, "blocked");
  store.setPaused(false);
  process.env.APPROVED_REPOS = "";
  assert.equal((await finalize(p.taskId, p.approvalId)).status, "blocked");
});

test("memory search accepts punctuation and retrieves saved facts", () => {
  store.remember({
    kind: "fact",
    title: "Optimus architecture",
    summary: "Temporal orchestrates missions",
    body: "Use scoped memory",
    sourceMessageId: "test:1",
  });
  assert.equal(
    store.searchMemories('Temporal " OR ***')[0]?.title,
    "Optimus architecture",
  );
  assert.deepEqual(store.searchMemories("***"), []);
});

const apiToken = "unit-test-token-abcdefghijklmnopqrstuvwxyz";
const calls: { method: string; id?: string }[] = [];
let unavailable = false;
const fakeClient = {
  workflow: {
    start: async (_type: string, options: { workflowId: string }) => {
      if (unavailable) throw Error("Test Temporal unavailable");
      calls.push({ method: "start", id: options.workflowId });
    },
    getHandle: (id: string) => ({
      signal: async () => {
        if (unavailable) throw Error("Signal unavailable");
        calls.push({ method: "signal", id });
      },
      cancel: async () => {
        calls.push({ method: "cancel", id });
      },
    }),
  },
} as unknown as Pick<Client, "workflow">;
const { app, decideForTask } = createApi(apiToken, async () => fakeClient);
function request(path: string, body?: object, authorized = true) {
  return app.request(path, {
    method: body ? "POST" : "GET",
    headers: {
      ...(authorized ? { authorization: `Bearer ${apiToken}` } : {}),
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test("API rejects missing and placeholder credentials", async () => {
  assert.throws(() => createApi(undefined), /API_ACCESS_TOKEN/);
  assert.throws(
    () => createApi("change-me-abcdefghijklmnopqrstuvwxyz"),
    /API_ACCESS_TOKEN/,
  );
  assert.equal((await request("/api/tasks", undefined, false)).status, 401);
  assert.equal((await request("/health", undefined, false)).status, 200);
});

test("API validates missions and enforces pause and repository allowlist", async () => {
  assert.equal(
    (await request("/api/tasks", { repo: "bad", objective: "short" })).status,
    400,
  );
  assert.equal(
    (
      await request("/api/tasks", {
        repo: "other/repo",
        objective: "Investigate CI",
      })
    ).status,
    403,
  );
  store.setPaused(true);
  assert.equal(
    (
      await request("/api/tasks", {
        repo: "owner/repo",
        objective: "Investigate CI",
      })
    ).status,
    409,
  );
  store.setPaused(false);
  const response = await request("/api/tasks", {
    repo: "owner/repo",
    objective: "Investigate CI",
  });
  assert.equal(response.status, 202);
  assert.equal(calls.at(-1)?.method, "start");
});

test("failed Temporal startup leaves an explicit failed mission", async () => {
  unavailable = true;
  try {
    assert.equal(
      (
        await request("/api/tasks", {
          repo: "owner/repo",
          objective: "Investigate an unavailable server",
        })
      ).status,
      503,
    );
    const task = (
      store.listTasks() as { objective: string; status: string }[]
    ).find((t) => t.objective === "Investigate an unavailable server");
    assert.equal(task?.status, "failed");
  } finally {
    unavailable = false;
  }
});

test("persisted approval can be resent after a failed signal without changing the decision", async () => {
  const p = await proposal();
  store.setTaskStatus(p.taskId, "waiting_approval");
  unavailable = true;
  try {
    await assert.rejects(
      decideForTask(p.taskId, p.approvalId, "approved", "local-owner"),
    );
  } finally {
    unavailable = false;
  }
  assert.equal(store.getApproval(p.approvalId)?.status, "approved");
  await decideForTask(p.taskId, p.approvalId, "approved", "local-owner");
  assert.equal(calls.at(-1)?.method, "signal");
});
