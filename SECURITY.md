# Security policy

## Reporting a vulnerability

**Do not open a public issue.**

Report privately through
[GitHub Security Advisories](https://github.com/tinocodemos/azure-devops-finops-agent/security/advisories/new).

Please include: what the issue is, how to reproduce it, which component is affected, and your
assessment of the impact.

You can expect an acknowledgement within three working days and an initial assessment within
ten.

## Scope

**In scope**

- The KPI MCP server (`mcp-server/`) — authentication, authorisation, input handling, the
  governance guards
- The dashboard (`dashboard/`) — XSS, token handling, CORS
- Infrastructure (`infra/`) — over-permissive RBAC, exposed endpoints, missing encryption
- Copilot Studio assets (`copilot-studio/`) — over-permissive sharing, weak authentication,
  committed secrets

Of particular interest: **any way to obtain person-level metrics**, or to make the engine
return a value where it should report the input as missing.

**Out of scope**

- Vulnerabilities in Microsoft Copilot Studio, Power Platform or Azure — report those to
  [MSRC](https://msrc.microsoft.com/)
- Issues requiring an already-compromised Power Platform administrator
- The demo data generator — it is synthetic by design
- Missing rate limiting on a service intended to run behind a private endpoint

## Security design

This project takes several deliberate positions. If you believe any of them is wrong, that is
also worth reporting:

- **No secrets anywhere.** Workload identity federation and managed identity throughout. CI
  fails if a secret appears in a settings file.
- **Read-only by construction.** No identity holds a write role.
- **User-delegated access.** Interactive queries run on-behalf-of the caller; Azure DevOps
  project security applies.
- **Governance enforced in code.** Person-level metrics are refused by the engine, not by a
  prompt.
- **No transcript logging.** Conversations quote commercially sensitive figures.

See [docs/SECURITY.md](docs/SECURITY.md) and [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

## Supported versions

The latest release on `main`.
