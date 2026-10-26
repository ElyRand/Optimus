import type { IncomingEvent } from "../../contracts/src/index.ts";
import { allowedRepos } from "../../policy/src/index.ts";

export type Initiative = {
  action: "ignore" | "investigate" | "notify" | "review";
  reason: string;
  source: "rules" | "jev";
};
export interface DecisionEngine {
  decide(event: IncomingEvent): Promise<Initiative>;
}

/** Fast local fail-closed default. External classifier adapter (Jev) must preserve policy checks. */
export class RulesDecisionEngine implements DecisionEngine {
  async decide(event: IncomingEvent): Promise<Initiative> {
    if (
      event.source === "github" &&
      event.type === "ci.failed" &&
      event.repo &&
      allowedRepos().has(event.repo)
    ) {
      return {
        action: "investigate",
        reason: "Allowlisted GitHub CI failure",
        source: "rules",
      };
    }
    return {
      action: "ignore",
      reason: "No allowlisted proactive rule matched",
      source: "rules",
    };
  }
}

// Jev adapter intentionally not active until its SDK, data boundary and evaluation suite are configured.
