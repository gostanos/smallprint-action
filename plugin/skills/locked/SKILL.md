---
name: locked
description: Check this project's MCP servers, skills and instruction files against smallprint.lock, on this machine, with nothing sent anywhere.
allowed-tools: Bash(npx -y smallprint@0.1.3:*)
disable-model-invocation: true
---

# The locked check

The command below compared what this machine's agents have installed with the lock file, `smallprint.lock`, on this machine. Nothing was sent anywhere. If there is no lock file yet, the command says so; `npx smallprint lock` writes one.

```!
npx -y smallprint@0.1.3 check --locked --no-upload --no-signup || true
```

Show the user the result above as it was printed, in a code block. Then say, in plain sentences, whether anything moved since the lock. If a file or a server moved and the user did not expect it, tell them to look at the named file before doing anything else, and that `npx smallprint lock` records the new state once they have checked it.
