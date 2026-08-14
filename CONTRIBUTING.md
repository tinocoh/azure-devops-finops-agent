# Contributing

## The one rule that matters

**A KPI formula is a claim about reality. Treat a change to one as you would a change to a
financial calculation, because for half this catalog that is exactly what it is.**

## Changing a KPI

1. Edit the definition in `kpi-engine/catalog/*.yaml`.
2. **Bump `revision`.** Trend data is only comparable within a revision — a silently changed
   formula produces a trend that mixes two definitions, which is worse than a visible
   discontinuity because nobody notices it.
3. Update the calculator in `mcp-server/src/kpi/calculators.ts`.
4. Add or update a test asserting the new behaviour.
5. Regenerate the docs: `cd kpi-engine && npm run docs`.
6. Explain in the pull request **why the previous formula was wrong**, not just what changed.

CI enforces that the catalog and the calculator registry cannot drift apart in either
direction, and that `docs/KPI-CATALOG.md` matches the YAML.

## Adding a KPI

Everything above, plus the definition must include:

- `formula` and `formula_display` — the second is what a non-engineer reads
- `unit` and `direction`
- `feasibility` — be honest. If it needs finance data, it is `external`.
- `sources` — which system and entity
- `thresholds` where a good/bad judgement is defensible; **omit them if it is not**
- `interpretation` — what a reader should conclude, and what they should not
- `caveats` — where the metric misleads
- `pairs_with` — the counterweight metric, if one exists
- `min_aggregation` — if it is finer-grained than `team`, expect to justify it

A KPI without an `interpretation` is a number without a meaning. Please do not add one.

## What will be declined

- **Any per-person metric.** Not negotiable. See [docs/RESPONSIBLE-METRICS.md](docs/RESPONSIBLE-METRICS.md).
- **A relaxation of the governance guards.**
- **A default or estimated value where an input is missing.** Reporting the missing input by
  name is the feature.
- **Cross-team comparison of team-local units** — story points, velocity, focus factor.
- **A composite "productivity score" for individuals or teams** that collapses the counterweights.

## Code

- TypeScript, strict mode. `noUncheckedIndexedAccess` is on and stays on.
- Comment *why*, not *what*. If a formula uses a specific percentile method or a
  median-absolute-deviation z-score, say why that choice was made.
- Prefer a clear function over a clever one — these calculations get audited.

Before opening a pull request:

```powershell
cd mcp-server;  npm run typecheck; npm test; npm run build
cd ../dashboard; npm run build
cd ../kpi-engine; npm run docs:check
```

## Dashboard

Keep components small and single-purpose. The previous generation of this product had an
8,500-line single-file chat view; the modularity here is a deliberate correction and worth
preserving.

Do not add a chart instance per tile. Sparklines are hand-rolled SVG for a reason — 60 chart
instances costs roughly a second of main-thread time on the machine a demo will run on.

## Copilot Studio assets

- `instructions.md` has a hard 8,000-character limit, enforced in CI.
- Add a topic only where behaviour must be deterministic. Every topic competes for the
  orchestrator's attention.
- Never commit a real settings file — only `*.example.json`.

## Commit messages

```
component: what changed

Why it changed, if not obvious.
```

Examples:

```
catalog: correct flow efficiency to use summed rather than averaged times

Averaging per-item ratios over-weights short items. Summing active and elapsed
time across the set gives the system-level figure the metric is meant to express.
Revision bumped to 2; prior trend data is not comparable.
```

```
guards: block cross-team comparison of focus factor

Focus factor depends on hoursPerStoryPoint, which is calibrated per team.
```
