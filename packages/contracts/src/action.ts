import { createHash } from "node:crypto";
import type { AgentRunInput } from "./index.ts";

/** Host-owned canonical payload for the simulated action; never trust a model hash. */
export function proposalHash(input: AgentRunInput): string {
  const payload = {
    taskId: input.taskId,
    repo: input.repo,
    objective: input.objective,
    action: "github.create_pr",
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
