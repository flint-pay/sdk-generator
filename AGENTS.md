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

Finish the user's task. A Linear ticket records independent future work; it never
substitutes for required implementation, investigation, root-cause fixes, or validation.

- Keep work needed for the requested outcome, acceptance criteria, or relevant checks in
  the current task. Fix regressions introduced by your changes. Difficulty, size, elapsed
  time, failing tests, or an unfamiliar subsystem are not reasons to offload required work.
- Before deferring, establish that the requested outcome will be correct, complete, and
  verified without addressing the finding, and explain why it is independently out of scope.
  If it is required or blocking, continue working under the existing authorization boundaries.
  If access or approval actually blocks you, report the blocker and unfinished work plainly;
  creating a ticket does not resolve the blocker or make the task complete.
- Automatically capture substantial, actionable bugs, reliability or performance problems,
  and maintenance obstacles encountered during authorized work. Require concrete evidence
  and a clear next step. Skip minor unrelated cleanup, stylistic preferences, and speculative
  concerns. Do not expand the task into a general audit to generate tickets.
- Search Linear for the same underlying problem before creating anything. Add materially
  new evidence to an existing issue when appropriate; do not repeat comments, reopen issues,
  or change their ownership, scheduling, priority, or review labels just because they recur.
- A create error or timeout does not prove that creation failed. Before retrying, search for
  the same problem and source task, inspect matches, and reuse a confirmed existing issue.
  If the result remains ambiguous or search is unavailable, report the unconfirmed creation
  instead of blindly retrying or claiming that a ticket was saved.
- Create new findings in the **Flint Pay** team (`FLI`, team ID
  `3a7d17d9-34c8-42c4-b298-02f82f5e508c`), status **Backlog**, with both
  **agent-discovered** and **needs-triage**. Leave assignee, delegate, cycle, due date,
  priority, and estimate unset. Link an existing project only when the association is clear.
  Filing does not authorize scheduling, delegation, or implementation of the deferred work.
- Use a specific problem title. Include the observed behavior, expected behavior, evidence
  or reproduction, likely impact, repository and code references, source task or PR when
  available, the explicit reason for deferral, and acceptance criteria or an investigation
  next step. Distinguish confirmed facts from hypotheses; never include secrets or private
  customer data. Prefer commit permalinks for code references when available.
- Continue the original task and report created or updated ticket links in the final response,
  separately from completed work and genuine blockers. If Linear or duplicate search is
  unavailable, finish the authorized work and report the unfiled finding without claiming
  that a ticket exists. Routine eligible findings do not require per-ticket confirmation.
- The shared **Agent findings** view is the review queue: unresolved issues with both labels.
  **Agent backlog** shows all unresolved **agent-discovered** issues, including reviewed ones.
  After an authorized review decision, remove **needs-triage** and retain **agent-discovered**.
  Do not mark findings reviewed merely because they were filed or automatically summarized.
- Use authenticated Linear tools in the current agent environment. When first using Linear
  in a session, verify access to the Flint Pay team. Repository guidance does not install
  tools or authenticate another client or machine; use that environment's normal MCP setup
  and login flow. Never put credentials in repository files or copy tokens between machines.
- Agents may search, summarize, and group tickets freely. Apply explicitly requested bulk
  metadata changes and report the affected issues. Resolve ambiguous target sets before
  mutation; closing, assigning, scheduling, or starting work requires the requested action
  or an applicable standing instruction.
