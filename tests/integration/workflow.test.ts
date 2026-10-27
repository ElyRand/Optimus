import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";

const dataDir = mkdtempSync(join(tmpdir(), "optimus-integration-"));
process.env.OPTIMUS_DATA_DIR = dataDir;
process.env.LIVE_HARNESS = "false";
process.env.APPROVED_REPOS = "owner/repo";
delete process.env.SLACK_BOT_TOKEN;
delete process.env.SLACK_APP_TOKEN;
delete process.env.SLACK_OWNER_ID;
const store = await import("../../packages/db/src/index.ts");
const activities = await import("../../apps/worker/src/activities.ts");
const { createApi } = await import("../../apps/api/src/app.ts");
Runtime.install({ logger: new DefaultLogger("ERROR") });

async function waitForStatus(taskId: string, expected: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await store.getTask(taskId))?.status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error(`Expected ${expected}, got ${(await store.getTask(taskId))?.status}`);
}

test(
  "API → real Temporal worker → SQLite approval and recovery",
  { timeout: 120_000 },
  async (t) => {
    const server = { dbFilename: join(dataDir, "temporal.sqlite"), ui: false };
    let env: TestWorkflowEnvironment | undefined;
    try {
      env = await TestWorkflowEnvironment.createLocal({ server });
      const apiToken = "integration-test-token-abcdefghijklmnopqrstuvwxyz";
      const { app } = createApi(apiToken, async () => env!.client);
      const headers = {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      };
      const queue = "optimus-tasks";
      async function worker(overrides: Partial<typeof activities> = {}) {
        return Worker.create({
          connection: env!.nativeConnection,
          taskQueue: queue,
          workflowsPath: fileURLToPath(
            new URL("../../apps/worker/src/workflows.ts", import.meta.url),
          ),
          activities: { ...activities, ...overrides },
        });
      }
      async function create() {
        const r = await app.request("/api/tasks", {
          method: "POST",
          headers,
          body: JSON.stringify({
            repo: "owner/repo",
            objective: "Investigate CI with no external side effects.",
          }),
        });
        assert.equal(r.status, 202);
        return (await r.json()).taskId as string;
      }
      async function decide(id: string, decision: "approved" | "rejected") {
        const task = (
          (await store.listTasks()) as {
            id: string;
            approval_id: string;
            result: string;
          }[]
        ).find((x) => x.id === id)!;
        assert.match(task.result, /DRY RUN/);
        const r = await app.request(`/api/tasks/${id}/approval`, {
          method: "POST",
          headers,
          body: JSON.stringify({ approvalId: task.approval_id, decision }),
        });
        assert.equal(r.status, 200);
      }

      await t.test(
        "approval survives worker and Temporal server restart; unrelated signals are ignored",
        async () => {
          const id = await create();
          const first = await worker();
          await first.runUntil(async () => {
            await waitForStatus(id, "waiting_approval");
            await env!.client.workflow
              .getHandle(id)
              .signal("approval", { approvalId: "unrelated", approved: true });
          });
          await env!.teardown();
          env = undefined;
          env = await TestWorkflowEnvironment.createLocal({ server });
          assert.equal((await store.getTask(id))?.status, "waiting_approval");
          await decide(id, "approved");
          const second = await worker();
          const result = await second.runUntil(() =>
            env!.client.workflow.getHandle(id).result(),
          );
          assert.equal(result.status, "completed");
          assert.equal((await store.getTask(id))?.status, "completed");
          assert.match(result.message, /NO PR published/);
        },
      );

      await t.test("rejection cancels without finalizing", async () => {
        const id = await create();
        const w = await worker();
        await w.runUntil(async () => {
          await waitForStatus(id, "waiting_approval");
          await decide(id, "rejected");
          assert.equal(
            (await env!.client.workflow.getHandle(id).result()).status,
            "cancelled",
          );
        });
        assert.equal((await store.getTask(id))?.status, "cancelled");
      });

      await t.test(
        "a matching workflow signal cannot bypass persisted owner approval",
        async () => {
          const id = await create();
          const w = await worker();
          await w.runUntil(async () => {
            await waitForStatus(id, "waiting_approval");
            const approval = (
              (await store.listTasks()) as { id: string; approval_id: string }[]
            ).find((x) => x.id === id)!;
            await env!.client.workflow
              .getHandle(id)
              .signal("approval", {
                approvalId: approval.approval_id,
                approved: true,
              });
            assert.equal(
              (await env!.client.workflow.getHandle(id).result()).status,
              "blocked",
            );
            assert.equal(
              (await store.getApproval(approval.approval_id))?.status,
              "pending",
            );
          });
        },
      );

      await t.test("owner cancellation is reflected in SQLite", async () => {
        const id = await create();
        const w = await worker();
        await w.runUntil(async () => {
          await waitForStatus(id, "waiting_approval");
          const r = await app.request(`/api/tasks/${id}/cancel`, {
            method: "POST",
            headers,
          });
          assert.equal(r.status, 200);
          await assert.rejects(env!.client.workflow.getHandle(id).result());
        });
        assert.equal((await store.getTask(id))?.status, "cancelled");
      });

      await t.test(
        "failed preparation closes the mission with a failed status",
        async () => {
          const id = await create();
          const w = await worker({
            prepare: async () => {
              throw Error("Harness failed in test");
            },
          });
          await w.runUntil(() =>
            assert.rejects(env!.client.workflow.getHandle(id).result()),
          );
          assert.equal((await store.getTask(id))?.status, "failed");
        },
      );

      await t.test(
        "Slack outage still permits local dashboard approval",
        async () => {
          const id = await create();
          const w = await worker({
            requestOwnerApproval: async () => {
              throw Error("Slack unavailable in test");
            },
          });
          await w.runUntil(async () => {
            await waitForStatus(id, "waiting_approval");
            await decide(id, "approved");
            assert.equal(
              (await env!.client.workflow.getHandle(id).result()).status,
              "completed",
            );
          });
        },
      );
    } finally {
      await env?.teardown();
      await store.closeDb();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);
