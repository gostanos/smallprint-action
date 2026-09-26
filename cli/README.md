# smallprint

The thin, open client for [Small Print](https://smallprint.dev): find the MCP servers and agent skills your agents have installed, see what the advisory databases have on record for them, and get a grade with the rule printed next to it.

```
npx smallprint check            # discover and print; asks before it sends anything, then grades; then one question: watch these every morning?
npx smallprint check --upload   # answer the send question up front (a script or CI has no terminal to ask in, so without it nothing is sent)
npx smallprint check --email you@company.com   # answer it up front; --no-signup never asks
npx smallprint check --share    # also get a card link you can post
npx smallprint check --json     # machine-readable inventory, nothing sent; says so in itself (about, sent) and names its fields at https://smallprint.dev/cli#json
npx smallprint check --no-upload  # discover and print, nothing sent
npx smallprint@0.1.3 check        # pinned: npx then never fetches a version you have not read; pin it in anything unattended
npx smallprint show npm/mcp-remote   # the record for one entry: baseline, tools read, advisories, last releases
npx smallprint check --locked --sarif smallprint.sarif   # the lock check, plus a SARIF log for a code-scanning upload

SMALLPRINT_TOKEN=sp_... npx smallprint sync --label "work laptop"   # pin what you run to your daily brief
npx smallprint sync --label "work laptop" --dry-run                 # show what would be pinned
npx smallprint sync --label "work laptop" --prune                   # drop pins this machine no longer has
SMALLPRINT_TOKEN=sp_... npx smallprint schedule --install --label "work laptop"   # the sync every 6 hours, off-machine record of instruction files
```

New to MCP servers and agent skills? https://smallprint.dev/guide is a step-by-step guide in plain words, and https://smallprint.dev/learn explains the basics in three levels, from what a terminal is to how to tell when an MCP server changes, with every fact linked to an official source.

Small Print is not only a lookup: pin what you run and it emails you the morning any of it changes, with the change and its grade. Free keeps 25 pins and that daily brief; Pro adds scheduled syncs and the instruction-file record (prices at https://smallprint.dev/pricing). Signing up is the question at the end of `check`: type your email, the account is created, everything found is pinned, and one emailed link turns the daily brief on. Your email is the account and the link is the login; no password. A token (from your settings page) is only needed to pin a second machine with `sync`. Every account starts with 30 days of Pro, no card. After that, Free keeps 25 pins from a sync you run by hand; the scheduled runs and the instruction file record are Pro. The full guide with sample output is at https://smallprint.dev/cli.

What leaves your machine: server names, versions, hosts, file hashes of skills (the SKILL.md hash and one hash over all files), and with `sync` a kind label and a hash of the path for each instruction file, CLAUDE.md imports included, and the names of any agent firewalls present on the machine, counted anonymously: the name says a machine somewhere runs the tool, not which machine or whose. What never leaves: paths, config values, environment variables, tokens, file contents. Plaintext secrets and world-readable config files are reported locally only.

Looks in: Claude Desktop, Claude Code (global, project, skills), Cursor, Windsurf, Codex, OpenClaw, Hermes, harnOS.

`check` also hashes your instruction files (CLAUDE.md and what it imports, AGENTS.md, an OpenClaw workspace's TOOLS.md and SOUL.md, Cursor, Windsurf, Copilot, Gemini, Cline and Roo rules, Claude agents, commands and settings with hooks, and the server definitions in your MCP configs with env values hashed) and compares them with the last run on the same machine: first seen, unchanged since a date, changed, or removed. A prompt injection that rewrites one of these persists into every later run; this is the line that says so. For settings files the line names the section that moved (`in: permissions` is an always-allow click, `in: hooks` is worth reading). Three ways to keep that record, weakest to strongest, your choice:

- `check`: the record is a file on your machine and nothing is sent. An agent that can write files can change the record as well as the files. Fine for a look; not a defence.
- `sync`: the record lives on smallprint.dev as a hash of each path, a kind label and the content hash, and keeps every change as an event. An agent can push a new hash; it cannot erase that the hash changed. Seen the next time you run sync.
- a hook instead of a job: keep the token in `~/.config/smallprint/token` (chmod 600; sync finds it there) and run `npx -y smallprint sync --yes --quiet --label "work laptop"` from a Claude Code `SessionStart` hook, a git `post-checkout` hook, or your shell profile. Recipes at https://smallprint.dev/cli#hooks.
- `sudo --preserve-env=PATH,SMALLPRINT_TOKEN smallprint schedule --install --system`: level four. A root-owned job runs a short standard-library Python helper (`report/smallprint-report.py` in this package) with the system interpreter, with a root-owned token, so an agent running as you cannot read the token, forge a report or stop the job. Refuses to install if the interpreter or destination is writable by anyone but root. Details at https://smallprint.dev/cli#system.
- `schedule --install`: installs a job on this machine that runs sync every six hours (launchd on macOS, systemd on Linux, a printed Task Scheduler command on Windows). You install it, `--uninstall` removes it, and a machine that goes quiet is reported in your brief. Nothing else ever installs it.

MIT. Everything clever lives on the server.

## Lock the small print, and fail the build when it moves

```
npx smallprint lock             # writes smallprint.lock: what this machine runs, and its instruction-file hashes
npx smallprint check --locked   # compares with the lock; exit 2 when anything moved. Local only, works offline
```

The lock holds names, versions, hosts and hashes, and the paths of instruction files, never a configuration value. For a server with a registry identity and a version it also carries the record's digest of that version's tool names, descriptions and input schemas, fetched when the lock is written (`--offline` skips it), and `smallprint gate` says when the record's digest for that version has changed since. Commit it; `check --locked` then says exactly what moved, on a laptop or in CI. The GitHub Action in `action/` of the repository runs that one command.

## Before a session: ask the record

```sh
npx smallprint gate --project   # exit 2 when a server's small print moved on the record since the lock, 3 when a high advisory names one
npx smallprint gate && claude    # as a launcher line or a shell hook
```

The lock says whether this machine moved. The gate asks the record: for every server here with a registry identity, has its small print changed since the version in the lock, and does a high or critical advisory name it. One request per server, carrying the registry name and nothing else. An entry the record has not read is reported as unknown and only fails the gate with `--strict`.

It reads Claude Desktop, Claude Code, Cursor, Windsurf, Codex, VS Code, Zed, Gemini CLI, Cline and Roo configurations, home and project.

## Reading the record without the CLI

Every trust page is also JSON: `GET /api/asset/npm/@modelcontextprotocol/server-filesystem`. Every advisory too: `GET /api/advisory/CVE-2025-6514`. One exact version has a receipt, the digest of its tool names, descriptions and input schemas plus the signed chain row that covers it: `GET /api/receipt/npm/mcp-remote/0.14.3`. The words inside every entry's tool text: `GET /api/search?q=webhook`. One item per request, rate limited, same attribution and printed criteria as the pages.

Inside an agent instead of a terminal: the MCP server `smallprint-mcp` (`npx -y smallprint-mcp`, registry name `dev.smallprint/smallprint`) reads the same record with three tools: lookup_entry, changes_since, advisories_for.

## Source

The program itself, the same files that npm installs, can be read with its tests at https://github.com/gostanos/smallprint-action/tree/main/cli, and an issue can be opened there. That is the program, not anything it finds: what the command reads on your machine stays on your machine. About 60 KB of unminified JavaScript plus a 14 KB Python helper; everything clever lives on the server. What the record can and cannot see is written at https://smallprint.dev/faq.
