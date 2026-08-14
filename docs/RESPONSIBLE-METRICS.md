# Responsible metrics

This document exists because engineering metrics products are routinely misused, and because
the misuse is predictable enough to design against.

## The position

**These metrics describe systems, not people.**

Every figure this agent produces is shaped by things the measured individual does not control:
the work they were handed, the age and state of the codebase, how many times they were
interrupted, how long a reviewer took, how many hand-offs sit between "in progress" and
"done", and how much of their week went to unblocking other people — which, by construction,
appears in *someone else's* numbers rather than their own.

Aggregate those to a team and you have a signal about a system. Attribute them to a person and
you have measurement error with a name attached.

## What is enforced, not merely recommended

Three controls, deliberately independent, because a policy that lives only in a prompt will
eventually be talked around:

**1. The engine refuses.** Every KPI declares a `min_aggregation`. The global floor is `team`.
[`mcp-server/src/kpi/guards.ts`](../mcp-server/src/kpi/guards.ts) raises a `GovernanceError`
before any calculation runs. This applies to the Copilot Studio agent, the dashboard, and any
direct API caller equally — there is no privileged path.

**2. The agent refuses.** A dedicated Copilot Studio topic,
[`individual-performance-refusal`](../copilot-studio/solution/topics/individual-performance-refusal.yaml),
takes deterministic control of the turn. It is a topic rather than an instruction precisely
because instructions are advisory to the model and erode under a persistent user.

**3. The data layer does not carry the identifier.** The live Azure DevOps provider does not
populate `contributorKey` from `AssignedTo` at all. The engine has no per-person KPI, so it
has no reason to hold a person identifier, and it does not.

Where a contributor key does exist — in the demo provider, and in the knowledge-concentration
KPI — it is a non-reversible hash, and the output names **code paths at risk**, never authors.

## Cross-team comparison is also blocked

Story points, velocity, focus factor and cost per story point are blocked from cross-team
comparison, because their unit is defined locally by each team. Team A's 8-point story and
Team B's 8-point story are not the same quantity, and no amount of normalisation makes them
one. Comparing them produces a confident, precise, wrong answer — the worst kind.

Compare a team against its own history.

## Goodhart's law is the default outcome, not the edge case

> When a measure becomes a target, it ceases to be a good measure.

In this domain that is not a caution, it is a description:

| Target this | Get this |
| --- | --- |
| Velocity | Point inflation. Same work, bigger numbers. |
| Deployment frequency | Trivial deploys to move the count. Watch change failure rate rise alongside. |
| Code coverage | Assertion-free tests that execute lines without checking anything. |
| Lead time | Work items opened late, so the clock starts later. |
| Utilisation | All slack removed, queues form, lead time gets *worse*. |
| Bug counts | Bugs reclassified as tasks. |

The catalog's `pairs_with` field is the structural defence: the agent is instructed to surface
the counterweight whenever it reports one of these. Deployment frequency arrives with change
failure rate. Utilisation arrives with lead time. Velocity arrives with flow distribution.

**Use these as diagnostics for conversations, not as targets in objectives.** The moment a KPI
here appears in someone's performance objectives, it stops measuring what you wanted.

## Utilisation deserves its own warning

`team.utilization_rate` is banded, not maximised, and its threshold configuration treats **high
readings as bad**.

This is not softness. Queueing theory says utilisation above roughly 85% causes wait times to
rise sharply and non-linearly. A team at 95% utilisation has no slack to absorb variability, so
every unplanned item queues behind planned work and lead time degrades. The team is working
harder and delivering more slowly, and the utilisation number is the only one that looks good.

The agent is instructed to report a high figure as a risk signal.

## Legal and works-council considerations

If you operate in the EU, the UK, or any jurisdiction with equivalent worker-protection law,
individual-level engineering telemetry is likely to be **personal data used for performance
evaluation**, which typically triggers:

- a lawful-basis assessment under GDPR Article 6, where legitimate interest is a high bar for
  performance monitoring;
- transparency obligations under Articles 13 and 14 — people must know they are measured;
- a Data Protection Impact Assessment under Article 35, since systematic monitoring of
  employees is explicitly in scope;
- in Germany, Austria, the Netherlands and elsewhere, **works council co-determination** —
  performance monitoring systems generally require an agreement, not merely notification.

This product's team-level floor keeps it well clear of that boundary by design. If you extend
it to individual level, you have almost certainly moved into scope, and that is a legal
question before it is an engineering one.

## What good use looks like

**A good question:** "Our lead time has doubled this quarter — where is the time going?"
Flow efficiency shows 14%, so the work is waiting, not being worked. Review latency is 30
hours. The constraint is review scheduling, and the fix is a team agreement, not more effort.

**A bad question:** "Who on the team has the worst cycle time?"
Refused. Cycle time varies mostly by the type of work assigned. This ranks the person given
the hardest problems as the worst performer.

**A good question:** "Are we going to come in on budget?"
CPI is 0.82 at 40% complete. EAC exceeds budget by 22%. CPI stabilises after roughly 20%
completion, so this is a credible early warning with time left to act on it.

**A bad question:** "Show me who is over-running their estimates."
Refused. Estimation accuracy is a team-level learning signal. Attributed to a person, it
teaches people to inflate estimates, which destroys the forecast for everyone.

## If you disagree

That is a legitimate position, and you have the source. But please consider that the guards
are not there to protect the metrics — they are there because the alternative measurement is
*wrong*, and wrong measurement applied to people's careers is a hard thing to undo.

## References

- DORA, *Accelerate State of DevOps* — team-level framing of the four keys
- Forsgren et al., *The SPACE of Developer Productivity*, ACM Queue — why no single metric
  captures productivity
- Noda et al., *DevEx: What Actually Drives Productivity*, ACM Queue — feedback loops,
  cognitive load, flow state
- Goodhart, C., *Problems of Monetary Management* (1975)
- GDPR Articles 6, 13, 14 and 35
