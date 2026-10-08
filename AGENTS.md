# Agent instructions

## Public repository and secrets

This is a **public repository**. Treat every commit, pull request, issue, comment,
and CI log as publicly visible.

- Never commit secrets: API keys, access tokens, passwords, private keys,
  credentials, or populated environment files.
- Never publish private provider definitions, customer data, sensitive request or
  response bodies, or local investigation artifacts. Use synthetic fixtures and
  obvious placeholders in examples and tests.
- Keep local working notes in the ignored `.context/` directory and generated
  output in ignored locations. Do not force-add ignored files containing private
  data. Follow `.gitignore` and the distribution allowlist in `package.json`.
- Before committing or pushing, inspect the staged diff and outgoing changes for
  secrets and private data. Check PR descriptions and other public text too.
- If you discover a secret, do not repeat it in output or public discussion.
  Stop publication of the affected content and notify the owner privately so the
  credential can be revoked or rotated. Follow [SECURITY.md](SECURITY.md).

## Working in this repository

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing code. Follow its scope,
  design, review, and validation requirements.
- This generator exists to produce and maintain the Flint Pay SDKs. Keep changes
  focused on that scope and preserve deterministic, readable generated output.
- Start with [the architecture](docs/architecture.md) and
  [the support matrix](docs/support-matrix.md). Keep shared semantic decisions in
  their owning compiler layer and verify affected Node.js/TypeScript and PHP
  behavior with independent expectations.
- Use Node.js 22+ and the PHP/Composer prerequisites listed in CONTRIBUTING.md.
  For code changes, run `npm run check` and `npm test`, plus the checks required
  for the affected area. For documentation-only changes, check the changed files
  with Prettier and verify links. Report any checks that could not run.
- Review the final diff and stage only files intended for the task. Keep unrelated
  changes and generated artifacts out of commits.

## Shared guidance

This file is the shared source of repository instructions for coding agents.
`CLAUDE.md` and `.claude/agents.md` point here; keep substantive guidance here.

## Deferred findings in Linear

Complete required implementation, investigation, root-cause fixes, and validation;
fix regressions introduced by your changes. Tickets never replace this work, regardless of
difficulty, size, time spent, failed checks, or unfamiliar systems. Respect existing
authorization boundaries; report genuine access/approval blockers as unfinished work.

- Automatically capture substantial, evidenced, actionable bugs, reliability/performance
  problems, or maintenance obstacles found during authorized work only if the requested
  outcome remains correct, complete, and verified without fixing them. Explain their
  independent scope. Skip unrelated minor cleanup, preferences, speculation, and
  ticket-generating audits. Eligible findings need no per-ticket confirmation.
- Before creating or retrying a failed/timed-out create, search for the underlying problem
  and source task; inspect matches and reuse confirmed issues. Add only materially new evidence. Recurrence
  does not authorize repeated comments, reopening, or ownership/scheduling/priority/review-label
  changes. Report ambiguous creation outcomes or unavailable search without blind retries or claims of success.
- Create in **Flint Pay** (`FLI`), **Backlog**, with **agent-discovered** and **needs-triage**;
  leave assignee, delegate, cycle, due date, priority, and estimate unset. Attach an existing
  project only when clearly applicable. Filing authorizes no scheduling, delegation, or implementation.
- Use a specific problem title; include observed/expected behavior, evidence/reproduction,
  likely impact, repository/code references (prefer commit permalinks), source task/PR when
  available, why deferred, and acceptance criteria or an investigation next step. Separate
  facts from hypotheses; omit secrets and private customer data.
- Continue the original task. Final responses distinguish completed work, genuine blockers,
  and created/updated ticket links. If Linear or duplicate search is unavailable, finish
  authorized work and truthfully report unfiled or unconfirmed findings.
- **Agent findings**: unresolved issues with both labels. **Agent backlog**: all unresolved
  **agent-discovered** issues, including reviewed ones. Only an authorized review removes
  **needs-triage**; retain **agent-discovered**. Filing or automatic summaries are not review.
- On first Linear use each session, verify authenticated team access. Setup/login is per
  client/machine; guidance does not install or authenticate tools. No repository credentials
  or copying tokens between machines.
- Search, summarize, and group freely. Apply explicitly requested bulk metadata changes and
  report affected issues; resolve ambiguous targets before mutation. Closing, assigning,
  scheduling, or starting work requires the requested action or an applicable standing instruction.
