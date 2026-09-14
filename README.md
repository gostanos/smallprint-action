# Small Print check, as a GitHub Action

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

Inputs: `lockfile` (default `smallprint.lock`), `version` (the CLI version, default 0.0.13).
