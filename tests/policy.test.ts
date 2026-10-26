import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePolicy } from "../packages/policy/src/index.ts";
import { RulesDecisionEngine } from "../packages/decisions/src/index.ts";

test("unknown privileges default deny", () => {
  assert.equal(
    decidePolicy(
      { capability: "host.shell", resource: "/" },
      new Set(["owner/repo"]),
    ),
    "deny",
  );
  assert.equal(
    decidePolicy(
      { capability: "github.delete_repo", resource: "owner/repo" },
      new Set(["owner/repo"]),
    ),
    "deny",
  );
  assert.equal(
    decidePolicy(
      { capability: "github.push", resource: "owner/repo" },
      new Set(["owner/repo"]),
    ),
    "deny",
  );
});
test("GitHub PR can only be requested on allowlisted repo", () => {
  assert.equal(
    decidePolicy(
      { capability: "github.create_pr", resource: "owner/repo" },
      new Set(["owner/repo"]),
    ),
    "ask",
  );
  assert.equal(
    decidePolicy(
      { capability: "github.create_pr", resource: "other/repo" },
      new Set(["owner/repo"]),
    ),
    "deny",
  );
});
test("owner notification is explicitly scoped", () => {
  assert.equal(
    decidePolicy(
      { capability: "slack.notify_owner", resource: "U1", ownerId: "U1" },
      new Set(),
    ),
    "allow",
  );
  assert.equal(
    decidePolicy(
      { capability: "slack.notify_owner", resource: "U2", ownerId: "U1" },
      new Set(),
    ),
    "deny",
  );
});
test("rules decision engine does not launch unknown initiatives", async () => {
  process.env.APPROVED_REPOS = "owner/repo";
  const engine = new RulesDecisionEngine();
  assert.equal(
    (
      await engine.decide({
        source: "github",
        type: "ci.failed",
        repo: "owner/repo",
        externalId: "x",
        summary: "CI broke",
      })
    ).action,
    "investigate",
  );
  assert.equal(
    (
      await engine.decide({
        source: "github",
        type: "ci.failed",
        repo: "other/repo",
        externalId: "y",
        summary: "CI broke",
      })
    ).action,
    "ignore",
  );
});
