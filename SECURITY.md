# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| `main` (latest) | ✅ Active |
| `0.1.x` | ✅ Best effort |
| `< 0.1.0` | ❌ No |

## Reporting a Vulnerability

> **⚠️ Do not open public issues, discussions, or pull requests for security vulnerabilities.**

### How to Report

Use one of these private channels:

1. **GitHub Security Advisories** (preferred) — [Report a vulnerability](https://github.com/AgentBigBrain/AgentBigBrain/security/advisories/new)
2. **Email** — [security@agentbigbrain.com](mailto:security@agentbigbrain.com)

### What to Include

Provide enough detail to reproduce and triage quickly:

| Field | Details |
|---|---|
| **Affected version** | Commit hash, tag, or branch |
| **Impacted components** | Files, modules, or layers affected |
| **Vulnerability type** | e.g., sandbox escape, receipt chain bypass, governor circumvention |
| **Severity estimate** | Critical / High / Medium / Low |
| **Reproduction steps** | Minimal steps or proof-of-concept |
| **Expected vs. actual** | What should happen vs. what does happen |
| **Known mitigations** | Any workarounds you've identified |
| **Public exposure** | Whether this is already disclosed elsewhere |

> **Note:** If your report involves secrets, tokens, or personal data, redact all sensitive values.

## Response Timeline

| Stage | Target |
|---|---|
| Acknowledgment | Within 72 hours |
| Initial triage | Within 7 calendar days |
| Remediation | Depends on severity and complexity |

You will receive status updates as triage progresses.

## Disclosure Policy

- **Coordinated disclosure is required.** Do not publish details until a fix or documented mitigation is available.
- Security fixes will include regression tests when feasible.
- Fixed vulnerabilities will be documented in [CHANGELOG.md](CHANGELOG.md) under the `Security` section.

## Security Architecture

AgentBigBrain is designed with security as a first-class concern:

- **Hard constraints** run before governance — deterministic safety checks that cannot be bypassed by the LLM
- **Governor council** provides multi-dimensional policy evaluation with fail-closed defaults
- **Execution receipts** create a tamper-evident audit trail for every approved action
- **Sandbox enforcement** restricts file access, shell execution, and network egress by policy
- **Probing detection** monitors memory access patterns for extraction attacks

For architecture details, see [ARCHITECTURE.md](docs/ARCHITECTURE.md) and [README.md](README.md).

