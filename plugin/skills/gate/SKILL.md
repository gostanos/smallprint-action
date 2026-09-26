---
name: gate
description: Ask Small Print's record whether any MCP server installed here has changed what it tells an agent since the lock, or gained a high advisory. Sends the names and versions of the servers, and nothing else.
allowed-tools: Bash(npx -y smallprint@0.1.3:*)
disable-model-invocation: true
---

# The gate

The command below asked smallprint.dev, for each MCP server this machine has installed, whether its small print moved on the record since the lock and whether a high or critical advisory names it. It sent the names and versions of the servers and nothing else. It exits with code 2 when a small print moved and 3 when a high advisory names a server.

```!
npx -y smallprint@0.1.3 gate || true
```

Show the user the result above as it was printed, in a code block. Then say, in plain sentences, what it means: nothing moved, or which servers moved or carry an advisory, with the link the command printed for each one. Do not judge whether a server is safe; say what the record holds and where to read it.
