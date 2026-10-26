import {
  CancellationScope,
  condition,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type * as activities from "./activities.ts";

type ApprovalSignal = { approvalId: string; approved: boolean };
export const approvalSignal = defineSignal<[ApprovalSignal]>("approval");
const { prepare, requestOwnerApproval, finalize } = proxyActivities<
  typeof activities
>({
  startToCloseTimeout: "15 minutes",
  retry: { maximumAttempts: 1 },
});
const { setStatus } = proxyActivities<typeof activities>({
  startToCloseTimeout: "20 seconds",
  retry: { maximumAttempts: 3 },
});

export async function taskWorkflow(input: {
  taskId: string;
  repo: string;
  objective: string;
}) {
  let expectedApprovalId: string | undefined;
  let response: ApprovalSignal | undefined;
  setHandler(approvalSignal, (signal) => {
    // Signals are hints. The broker rechecks persisted approval and its hash.
    if (
      expectedApprovalId &&
      signal?.approvalId === expectedApprovalId &&
      typeof signal.approved === "boolean" &&
      !response
    )
      response = signal;
  });
  try {
    await setStatus(input.taskId, "running");
    const result = await prepare(input);
    if (result.state === "blocked") {
      await setStatus(input.taskId, "blocked");
      return { status: "blocked" };
    }
    expectedApprovalId = result.approvalId;
    // Persist the reviewable proposal before sending its notification.
    await setStatus(input.taskId, "waiting_approval", result.summary);
    try {
      await requestOwnerApproval(
        input.taskId,
        result.approvalId,
        result.summary,
      );
    } catch {
      await setStatus(
        input.taskId,
        "waiting_approval",
        `${result.summary}\nSlack notification failed; review in the local dashboard.`,
      );
    }
    const received = await condition(() => response !== undefined, "7 days");
    if (!received || !response?.approved) {
      await setStatus(
        input.taskId,
        "cancelled",
        received
          ? "Owner rejected the proposal."
          : "Approval expired after 7 days.",
      );
      return { status: "cancelled" };
    }
    await setStatus(input.taskId, "finalizing");
    const outcome = await finalize(input.taskId, result.approvalId);
    await setStatus(input.taskId, outcome.status, outcome.message);
    return outcome;
  } catch (error) {
    await CancellationScope.nonCancellable(() =>
      setStatus(
        input.taskId,
        isCancellation(error) ? "cancelled" : "failed",
        isCancellation(error)
          ? "Mission cancelled by owner."
          : "Mission failed; inspect the worker logs.",
      ),
    );
    throw error;
  }
}
