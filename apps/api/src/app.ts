import { Hono } from "hono";
import { Connection, Client } from "@temporalio/client";
import { timingSafeEqual } from "node:crypto";
import {
  manualTaskSchema,
  eventSchema,
  approvalDecisionSchema,
} from "../../../packages/contracts/src/index.ts";
import {
  createTask,
  decideApproval,
  getApproval,
  getTask,
  listTasks,
  recordExternalEvent,
  searchMemories,
  audit,
  isPaused,
  setPaused,
  setTaskStatus,
} from "../../../packages/db/src/index.ts";
import { allowedRepos } from "../../../packages/policy/src/index.ts";
import { RulesDecisionEngine } from "../../../packages/decisions/src/index.ts";

let clientPromise: Promise<Client> | undefined;
async function client() {
  clientPromise ??= Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
  })
    .then((connection) => new Client({ connection }))
    .catch((e) => {
      clientPromise = undefined;
      throw e;
    });
  return clientPromise;
}
function secureEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Construct without opening sockets or connecting to external services. */
export function createApi(
  apiToken: string | undefined,
  getClient: () => Promise<Pick<Client, "workflow">> = client,
) {
  if (!apiToken || apiToken.length < 24 || apiToken.startsWith("change-me")) {
    throw new Error(
      "Set a random API_ACCESS_TOKEN (24+ characters) in .env before starting",
    );
  }
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok", mode: "dry-run" }));
  app.use("/api/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    if (
      !header.startsWith("Bearer ") ||
      !secureEqual(header.slice(7), apiToken)
    )
      return c.json({ error: "Unauthorized" }, 401);
    await next();
  });
  async function enqueueTask(repo: string, objective: string) {
    if (await isPaused()) throw Error("Optimus is paused");
    if (!allowedRepos().has(repo)) throw Error("Repository not allowlisted");
    const id = await createTask(repo, objective);
    try {
      await (
        await getClient()
      ).workflow.start("taskWorkflow", {
        taskQueue: "optimus-tasks",
        workflowId: id,
        args: [{ taskId: id, repo, objective }],
      });
    } catch (e) {
      await setTaskStatus(
        id,
        "failed",
        "Temporal could not start the mission. Retry after checking the service.",
      );
      await audit(id, "system", "temporal.start_failed", { error: String(e) });
      throw e;
    }
    return id;
  }
  async function decideForTask(
    taskId: string,
    approvalId: string,
    decision: "approved" | "rejected",
    actor: string,
  ) {
    const task = await getTask(taskId);
    const approval = await getApproval(approvalId);
    if (
      !task ||
      !approval ||
      approval.task_id !== taskId ||
      (approval.status === "rejected" && decision === "approved")
    )
      throw Error("Approval does not match task");
    if (!["waiting_approval", "finalizing"].includes(task.status))
      throw Error("Task is not waiting for approval");
    await decideApproval(approvalId, taskId, decision, actor);
    await (
      await getClient()
    ).workflow
      .getHandle(taskId)
      .signal("approval", { approvalId, approved: decision === "approved" });
  }
  app.get("/api/tasks", async (c) =>
    c.json({ tasks: await listTasks(), paused: await isPaused() }),
  );
  app.post("/api/control/pause", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.paused !== "boolean")
      return c.json({ error: "paused boolean required" }, 400);
    await setPaused(body.paused);
    return c.json({ paused: await isPaused() });
  });
  app.post("/api/tasks/:id/cancel", async (c) => {
    const id = c.req.param("id");
    if (!(await getTask(id))) return c.json({ error: "Unknown task" }, 404);
    try {
      await (await getClient()).workflow.getHandle(id).cancel();
      await setTaskStatus(id, "cancelled");
      return c.json({ status: "cancelled" });
    } catch (e) {
      return c.json({ error: String(e) }, 409);
    }
  });
  app.post("/api/tasks", async (c) => {
    const body = manualTaskSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    if (await isPaused()) return c.json({ error: "Optimus is paused" }, 409);
    if (!allowedRepos().has(body.data.repo))
      return c.json({ error: "Repository not allowlisted" }, 403);
    try {
      return c.json(
        { taskId: await enqueueTask(body.data.repo, body.data.objective) },
        202,
      );
    } catch (e) {
      return c.json({ error: "Temporal unavailable", details: String(e) }, 503);
    }
  });
  app.post("/api/events", async (c) => {
    const body = eventSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    const first = await recordExternalEvent(body.data);
    if (!first) return c.json({ status: "duplicate" });
    const initiative = await new RulesDecisionEngine().decide(body.data);
    if (initiative.action !== "investigate" || !body.data.repo)
      return c.json({ status: "ignored", initiative });
    try {
      return c.json(
        {
          status: "queued",
          taskId: await enqueueTask(body.data.repo, body.data.summary),
          initiative,
        },
        202,
      );
    } catch (e) {
      return c.json({ error: "Temporal unavailable", details: String(e) }, 503);
    }
  });
  app.post("/api/tasks/:id/approval", async (c) => {
    const body = approvalDecisionSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    try {
      await decideForTask(
        c.req.param("id"),
        body.data.approvalId,
        body.data.decision,
        "local-owner",
      );
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 409);
    }
  });
  app.get("/api/memories/search", async (c) => {
    const q = c.req.query("q") ?? "";
    return c.json({ results: await searchMemories(q) });
  });

  return { app, enqueueTask, decideForTask };
}
