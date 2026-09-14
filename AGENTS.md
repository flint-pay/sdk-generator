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
