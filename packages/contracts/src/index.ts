import { z } from "zod";

export const repoSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
export const manualTaskSchema = z.object({
  repo: repoSchema,
  objective: z.string().trim().min(6).max(1000),
});
export const eventSchema = z.object({
  source: z.enum(["github", "slack", "scheduler"]),
  type: z.string().min(1).max(80),
  repo: repoSchema.optional(),
  summary: z.string().max(2000),
  externalId: z.string().min(1).max(160),
});
export const approvalDecisionSchema = z.object({
  approvalId: z.string().uuid(),
  decision: z.enum(["approved", "rejected"]),
});
export type ManualTask = z.infer<typeof manualTaskSchema>;
export type IncomingEvent = z.infer<typeof eventSchema>;
export type AgentHarness = "claude" | "codex";
export type AgentRunInput = { taskId: string; repo: string; objective: string };
export type AgentProposal = {
  taskId: string;
  summary: string;
  artifactId: string;
  action: "github.create_pr";
  resource: string;
  payloadHash: string;
  simulated: boolean;
};
