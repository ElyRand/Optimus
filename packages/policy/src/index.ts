export type Capability =
  | "github.create_pr"
  | "github.delete_repo"
  | "slack.notify_owner"
  | "host.shell";
export type Decision = "allow" | "ask" | "deny";
export type PolicyRequest = {
  capability: string;
  resource: string;
  ownerId?: string;
};

export function allowedRepos(
  env: string | undefined = process.env.APPROVED_REPOS,
): Set<string> {
  return new Set(
    (env ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
}

/** Pure policy, never delegated to the LLM, Jev, or memory. */
export function decidePolicy(
  req: PolicyRequest,
  repoAllowlist: ReadonlySet<string>,
): Decision {
  switch (req.capability) {
    case "github.create_pr":
      return repoAllowlist.has(req.resource) ? "ask" : "deny";
    case "slack.notify_owner":
      return req.ownerId && req.resource === req.ownerId ? "allow" : "deny";
    case "github.delete_repo":
    case "host.shell":
    default:
      return "deny";
  }
}
