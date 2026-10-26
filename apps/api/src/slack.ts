import { App } from "@slack/bolt";
import { allowedRepos } from "../../../packages/policy/src/index.ts";

export async function bootSlack(handlers: {
  enqueueTask: (repo: string, objective: string) => Promise<string>;
  decideForTask: (
    taskId: string,
    approvalId: string,
    decision: "approved" | "rejected",
    actor: string,
  ) => Promise<void>;
}) {
  const token = process.env.SLACK_BOT_TOKEN,
    appToken = process.env.SLACK_APP_TOKEN,
    owner = process.env.SLACK_OWNER_ID;
  if (!token || !appToken || !owner) {
    console.log("Slack Socket Mode disabled: tokens / owner not configured");
    return;
  }
  const app = new App({ token, appToken, socketMode: true });
  app.event("app_mention", async ({ event, say }) => {
    if (event.user !== owner) return;
    const repo = Array.from(allowedRepos())[0];
    if (!repo) {
      await say("Aucun dépôt autorisé dans APPROVED_REPOS.");
      return;
    }
    const objective = event.text.replace(/<@[^>]+>/g, "").trim();
    if (objective.length < 6) {
      await say("Décris la tâche en quelques mots.");
      return;
    }
    const taskId = await handlers.enqueueTask(repo, objective);
    await say({
      text: `Mission ${taskId} créée. Je reviendrai vers toi pour autorisation.`,
      thread_ts: event.ts,
    });
  });
  for (const [action, decision] of [
    ["optimus_approve", "approved"],
    ["optimus_reject", "rejected"],
  ] as const) {
    app.action(action, async ({ ack, body, action: clicked, respond }) => {
      await ack();
      if (body.user.id !== owner) return;
      if (clicked.type !== "button" || !clicked.value) return;
      const [taskId, approvalId] = clicked.value.split(":");
      if (!taskId || !approvalId) return;
      try {
        await handlers.decideForTask(
          taskId,
          approvalId,
          decision,
          `slack:${body.user.id}`,
        );
        await respond(`Décision ${decision} enregistrée pour ${taskId}.`);
      } catch (e) {
        await respond(`Impossible d'enregistrer la décision : ${String(e)}`);
      }
    });
  }
  await app.start();
  console.log("Slack Socket Mode connected as Optimus");
}
