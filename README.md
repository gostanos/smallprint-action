# Small Print, the public pieces

[![M8ven Score](https://m8ven.ai/badge/mcp/gostanos-smallprint-action-12nii2?v=f92621c28b9eb0ba49f7f8dc22ea074d&variant=verified)](https://m8ven.ai/mcp/gostanos-smallprint-action-12nii2)

Two small things that read the [Small Print](https://smallprint.dev) record, the nightly diff of what MCP servers, agent skills and plugins tell your agent. The site, the ingest and the grading rules live elsewhere; the rules themselves are printed at https://smallprint.dev/how-we-grade.

- **This Action** fails a build when the small print in a repository moved away from its lock.
- **`npx smallprint gate`** asks the record before a session whether any server here moved since the lock or gained a high advisory; exit codes for a shell hook. CLI 0.0.14.
- **[`mcp/`](./mcp)**: `smallprint-mcp`, an MCP server with four read-only tools over the public record (`npx -y smallprint-mcp`; registry name `dev.smallprint/smallprint`).
- **`Dockerfile`** builds and runs that server over stdio, for registries that start a server to check it answers.
- **[`cli/`](./cli)**: the `smallprint` command itself, the same files that are published to npm, with its tests. `npx smallprint check --no-upload` prints what it found and sends nothing.

## Small Print check, as a GitHub Action

Fails the build when the small print your agents read has moved: an MCP server's version, a skill's files, or an instruction file such as CLAUDE.md, AGENTS.md or an `.mcp.json`, compared with a lock you committed.

```yaml
- uses: gostanos/smallprint-action@v1
```

Write the lock from the repository's directory on a machine that has the intended configuration, with `--project` so it holds only what lives in the repository (the `.mcp.json`, the `.claude/` and `.cursor/` folders, `CLAUDE.md`, `AGENTS.md` and the rest), and commit it:

```bash
npx smallprint lock --project
git add smallprint.lock
```

The check is local: it reads the repository's config and instruction files, compares them with the lock, and sends nothing anywhere. It exits 2 when something moved and prints what. When the change is yours, run `npx smallprint lock --project` again and commit. A lock written without `--project` also holds the machine's home-directory entries, which a CI runner does not have, so that check would fail on every run; the lock records which kind it is and the check honours it.

Inputs: `lockfile` (default `smallprint.lock`), `version` (the CLI version, default 0.0.14).
