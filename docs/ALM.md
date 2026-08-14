# Application lifecycle management

Two halves with two ALM models. This document is mostly about reconciling them.

| Half | Artefact | Promotion | CI/CD completeness |
| --- | --- | --- | --- |
| KPI engine, dashboard, infra | Git | GitHub Actions → Bicep | **Complete** |
| Copilot Studio agent | Dataverse solution | Power Platform Pipelines / Build Tools | **Partial** |

## Environments

```
dev  →  test  →  prod
```

Each has its own Power Platform environment, its own Azure resource group, and its own
`copilot-studio/scripts/settings/<env>.json`.

## The code half

Standard and unremarkable, which is the point.

```
PR → CI (lint, typecheck, test, catalog drift check, build, CodeQL, audit)
   → merge to main
   → build and push container image
   → deploy to test via Bicep
   → approval gate
   → deploy to prod via Bicep
```

Everything is declarative and in Git. A rollback is a redeploy of a previous image digest.

## The Copilot Studio half

### What a solution carries

- Agent definition, instructions, topics
- Tool configuration, including the MCP registration
- Agent flows
- Environment variables and connection references

### What a solution does not carry

- **Application Insights settings**
- **Manual authentication settings**
- **Direct Line and web channel security**
- **Sharing permissions**
- **Deployed channels**

This is the crux. **A successful solution import does not produce a working agent.** Treat a
promotion as incomplete until `verify-agent.ps1` passes.

### Promotion

```powershell
# 1. export from dev as unmanaged, unpack into Git
pac solution export --name AdoFinOpsAgent --path ./out --managed false
pac solution unpack --zipfile ./out/AdoFinOpsAgent.zip --folder ./solution-src --packagetype Unmanaged

# 2. review the diff in a pull request
git add solution-src && git commit -m "agent: adjust pipeline economics instructions"

# 3. pack and import as managed
pac solution pack --zipfile ./out/AdoFinOpsAgent_managed.zip --folder ./solution-src --packagetype Managed
pac solution import --path ./out/AdoFinOpsAgent_managed.zip --environment $testEnv --publish-changes

# 4. re-apply what the solution did not carry
./copilot-studio/scripts/post-deploy.ps1 -EnvironmentUrl $testEnv `
    -AgentSchemaName cr123_adoFinOpsDeliveryIntelligence -Settings ./settings/test.json

# 5. assert the deployed agent matches the declaration
./copilot-studio/scripts/verify-agent.ps1 -EnvironmentUrl $testEnv
```

Dataverse Git integration can sync solutions to an Azure DevOps repository directly from the
maker portal, which is worth enabling — it makes maker-portal edits visible in Git rather than
invisible until the next manual export.

### Why `solution/` exists as YAML alongside the exported solution

The exported solution is the artefact; `copilot-studio/solution/` is the **intent**. A change
to agent behaviour starts as a pull request against the YAML and Markdown, where it can be
argued about in readable form, and `verify-agent.ps1` then asserts the deployed environment
matches.

Without this, agent behaviour changes arrive as an opaque diff in packed solution XML, which
nobody reviews properly.

## Ordering constraint

**The MCP server must be deployed before the agent is imported**, because the agent's tool
registration points at the `/mcp` endpoint. A solution import against a non-existent endpoint
succeeds and produces an agent that fails on the first question.

Deployment order:

1. Bicep → MCP server
2. Grant the managed identity Azure DevOps `Analytics (read)`
3. Upload reference data
4. Verify `/api/health` and `/mcp` respond
5. Import the Copilot Studio solution
6. `post-deploy.ps1`
7. `verify-agent.ps1`
8. Deploy the dashboard, add its origin to Direct Line trusted origins

## Versioning

**Formula changes require a revision bump.** Trend data is only comparable within a revision;
a silently changed formula produces a trend line that mixes two definitions, which is worse
than a discontinuity because it is invisible.

`catalogVersion` (a fingerprint of KPI count and total revisions) is stamped on every
scorecard, so a stored or screenshotted figure traces back to the exact definition set.

CI regenerates `docs/KPI-CATALOG.md` and fails if the committed copy is stale, so the
published formula can never drift from the executed one.

## Testing before release

Automated (CI):

- 33 unit tests: catalog integrity, governance guards, calculators, scoring, period handling
- Catalog ↔ calculator drift check in both directions
- Typecheck, lint, build for server and dashboard
- CodeQL, dependency audit

Manual (before any agent release) — the four that automation does not cover:

1. A scorecard question returns figures **with the period stated**.
2. A question about a named individual is **refused**, and refused again when pressed.
3. A profitability question with no reference data reports **missing inputs by name**, not zeros.
4. An unknown project name triggers `list_scopes` rather than a guess.

The [Copilot Studio Kit](https://github.com/microsoft/Power-CAT-Copilot-Studio-Kit) can
automate conversation-level tests. It is community-maintained rather than a supported
Microsoft product — assess its stability before making it a required gate.

## Rollback

| Component | How |
| --- | --- |
| MCP server | Redeploy the previous image digest; container app revisions allow instant traffic shift |
| Dashboard | Redeploy previous build |
| Infrastructure | Redeploy previous Bicep from Git |
| Copilot Studio agent | Import the previous managed solution, then re-run `post-deploy.ps1` |
| Reference data | Restore from Git; blob versioning retained 30 days |

Note the asymmetry: the code half rolls back in seconds, the agent half takes an import plus a
post-deployment script. Plan agent changes accordingly.
