---
name: check
description: List the MCP servers, skills and instruction files this machine's agents have installed, using Small Print's check. Nothing is sent anywhere.
allowed-tools: Bash(npx -y smallprint@0.1.3:*)
disable-model-invocation: true
---

# What Small Print found on this machine

The command below was run on this machine with `--no-upload`, so nothing was sent anywhere. It read the MCP configuration files of Claude Desktop, Claude Code, Cursor, Windsurf, Codex and VS Code, the skills those agents load, and the instruction files of Claude Code, Codex and OpenClaw.

```!
npx -y smallprint@0.1.3 check --no-upload
```

Show the user the list above as it was printed, in a code block, without leaving anything out. Then tell them, in two or three plain sentences: that nothing was sent; that `npx smallprint check --upload` would send only the names, versions, hosts and file hashes of those items to smallprint.dev and return grades and any advisories on record for them; and that `/smallprint:locked` checks the same list against a lock file and `/smallprint:gate` asks the record whether anything installed has changed or gained a high advisory. Do not run either of those unless the user asks.
