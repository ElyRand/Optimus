import { WebClient } from "@slack/web-api";
import {
  audit,
  getApproval,
  getTask,
  saveApproval,
  setTaskStatus,
  isPaused,
} from "../../../packages/db/src/index.ts";
import {
  allowedRepos,
  decidePolicy,
} from "../../../packages/policy/src/index.ts";
import { proposalHash } from "../../../packages/contracts/src/action.ts";
import { prepareAgentProposal } from "../../../packages/agent-runtime/src/index.ts";

export async function setStatus(
  taskId: string,
  status: string,
  result?: string,
) {
  setTaskStatus(taskId, status, result);
}
export async function prepare(input: {
  taskId: string;
  repo: string;
  objective: string;
}): Promise<
  | { state: "blocked" }
  | { state: "prepared"; approvalId: string; summary: string }
> {
  if (isPaused()) return { state: "blocked" };
  if (
    decidePolicy(
      { capability: "github.create_pr", resource: input.repo },
      allowedRepos(),
    ) !== "ask"
  ) {
    audit(input.taskId, "policy", "proposal.blocked", { resource: input.repo });
    return { state: "blocked" };
  }
  const proposal = await prepareAgentProposal(input);
  const approvalId = saveApproval(
    input.taskId,
    proposal.action,
    proposal.resource,
    proposal.payloadHash,
  );
  audit(input.taskId, "harness", "proposal.prepared", {
    approvalId,
    summary: proposal.summary,
    simulated: proposal.simulated,
  });
  return { state: "prepared", approvalId, summary: proposal.summary };
}
export async function requestOwnerApproval(
  taskId: string,
  approvalId: string,
  summary: string,
) {
  const token = process.env.SLACK_BOT_TOKEN;
  const owner = process.env.SLACK_OWNER_ID;
  if (!token || !owner) return; // The local dashboard still shows this request.
  const slack = new WebClient(token);
  const dm = await slack.conversations.open({ users: owner });
  if (!dm.channel?.id) throw new Error("Slack DM unavailable");
  await slack.chat.postMessage({
    channel: dm.channel.id,
    text: `Optimus requests approval for task ${taskId}: ${summary}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Optimus requests approval*
${summary.slice(0, 1500)}
Task: \`${taskId}\``,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "optimus_approve",
            text: { type: "plain_text", text: "Approve" },
            value: `${taskId}:${approvalId}`,
            style: "primary",
          },
          {
            type: "button",
            action_id: "optimus_reject",
            text: { type: "plain_text", text: "Reject" },
            value: `${taskId}:${approvalId}`,
            style: "danger",
          },
        ],
      },
    ],
  });
}
export async function finalize(taskId: string, approvalId: string) {
  if (isPaused())
    return { status: "blocked", message: "Optimus paused by owner" };
  const approval = getApproval(approvalId);
  const task = getTask(taskId);
  if (
    !approval ||
    !task ||
    approval.task_id !== taskId ||
    approval.status !== "approved"
  ) {
    return { status: "blocked", message: "Missing valid owner approval" };
  }
  if (
    approval.action !== "github.create_pr" ||
    approval.resource !== task.repo ||
    approval.payload_hash !==
      proposalHash({
        taskId: task.id,
        repo: task.repo,
        objective: task.objective,
      }) ||
    decidePolicy(
      { capability: approval.action, resource: approval.resource },
      allowedRepos(),
    ) !== "ask"
  ) {
    return { status: "blocked", message: "Permission broker denied action" };
  }
  // INTENTIONALLY NO GitHub write here. No verified diff or release capability yet.
  audit(taskId, "broker", "publication.simulated", {
    approvalId,
    payloadHash: approval.payload_hash,
  });
  return {
    status: "completed",
    message: "DRY RUN complete — approval verified. NO PR published.",
  };
}
