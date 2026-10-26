# Security boundaries and threat model

## Assets

Home filesystem, SSH keys, passwords, Slack/GitHub tokens, local browser sessions, documents, memory, permission rules, Temporal execution state.

## Adversarial inputs

Slack messages from non-owner users, websites, issue descriptions, code repositories, shell command output, LLM hallucinations, compromised dependencies.

## Enforcement

- API listens on 127.0.0.1 and requires a bearer token.
- Slack Socket Mode validates incoming Slack events through the SDK; code also checks owner user ID.
- Worker and broker run on host; no shell-capability exposed through broker.
- The only mock privileged capability is `github.create_pr` and it requires a verified owner approval for a specific action hash.
- All unknown capabilities default deny; owner approval cannot override an explicit deny.
- Only repos in `APPROVED_REPOS` are eligible for proposals.
- Sandbox must have restricted filesystem/network; built-in harness shell tools do not pass through the broker automatically.
- An action hash is bound to exact planned action; any changed payload invalidates old approval.
- The starter simulates publication. DO NOT reinterpret this as a production ready GitHub integration.

## Production hardening to implement

Secure local secret store, short-lived credentials and issuer validation, per-tool and per-resource scopes, outbound allowlists, token exfiltration protection, idempotent external actions, signature validation, confirmations for irreversible operations, private DM policy, audit retention, data deletion, rate limiting, crash recovery testing and timeouts.
