# Small Print

[![M8ven Score](https://m8ven.ai/badge/mcp/gostanos-smallprint-action-12nii2?v=f92621c28b9eb0ba49f7f8dc22ea074d&variant=verified)](https://m8ven.ai/mcp/gostanos-smallprint-action-12nii2)

Small Print keeps a record of the text that MCP servers, agent skills and plugins give your AI agent, and tells you when it changes. It reads the public registries every night, keeps every version, and grades each change by a written rule: https://smallprint.dev.

- **Get an email the morning something you use changes.** Sign up with just your email address at https://smallprint.dev/start, from the watch box on any entry's page, or by typing it when `npx smallprint check` asks. Pin the servers and skills you use; the daily brief shows what changed overnight and its grade, by email or Discord. No password and no card.
- **Check what your agents have installed**, free and with no account: `npx smallprint check`, or paste a config file at https://smallprint.dev/check.
- **Plans:** the Free plan keeps 25 pins and the daily brief, and every account starts with 30 days of Pro. Pro adds scheduled syncs and the instruction-file record. https://smallprint.dev/pricing
- **New to this?** A step-by-step guide in plain words: https://smallprint.dev/guide

The grading rules are printed at https://smallprint.dev/how-we-grade.

## What is in this repository

- **This Action** fails a build when the small print in a repository changed since its lock was written.
- **`npx smallprint gate`** asks the record before a session whether any server here changed since the lock or gained a high advisory; exit codes for a shell hook. CLI 0.1.4.
- **[`mcp/`](./mcp)**: `smallprint-mcp`, an MCP server with four read-only tools over the public record (`npx -y smallprint-mcp`; registry name `dev.smallprint/smallprint`).
- **`Dockerfile`** builds and runs that server over stdio, for registries that start a server to check it answers.
- **[`cli/`](./cli)**: the `smallprint` command itself, the same files that are published to npm, with its tests. `npx smallprint check --no-upload` prints what it found and sends nothing.
- **[`tools/verify-chain.mjs`](./tools/verify-chain.mjs)**: recomputes the record chain from the public API, every link, the newest day's entries hash and the Ed25519 signature; `node tools/verify-chain.mjs`.

## Small Print check, as a GitHub Action

Fails the build when the small print your agents read has changed: an MCP server's version, a skill's files, or an instruction file such as CLAUDE.md, AGENTS.md or an `.mcp.json`, compared with a lock you committed.

```yaml
- uses: gostanos/smallprint-action@v1
```

Write the lock from the repository's directory on a machine that has the intended configuration, with `--project` so it holds only what lives in the repository (the `.mcp.json`, the `.claude/` and `.cursor/` folders, `CLAUDE.md`, `AGENTS.md` and the rest), and commit it:

```bash
npx smallprint lock --project
git add smallprint.lock
```

The check is local: it reads the repository's config and instruction files, compares them with the lock, and sends nothing anywhere. It exits 2 when something changed and prints what. When the change is yours, run `npx smallprint lock --project` again and commit. A lock written without `--project` also holds the machine's home-directory entries, which a CI runner does not have, so that check would fail on every run; the lock records which kind it is and the check honours it.

Inputs: `lockfile` (default `smallprint.lock`), `version` (the CLI version, default 0.1.4).

### With a code-scanning upload

The step can write what changed as a SARIF log, and GitHub's upload-sarif action turns each line into a code-scanning alert on the pull request. Needs the `--sarif` flag, which is in `smallprint` 0.1.4 and later.

```yaml
      - uses: gostanos/smallprint-action@v1
        with:
          sarif: smallprint.sarif
        continue-on-error: true
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: smallprint.sarif
```

### As a pre-commit hook

One line in `.pre-commit-config.yaml` runs the lock check before every commit, offline:

```yaml
repos:
  - repo: local
    hooks:
      - id: smallprint-lock
        name: small print lock
        entry: npx -y smallprint@0.1.4 check --locked --no-upload --no-signup
        language: system
        pass_filenames: false
```
