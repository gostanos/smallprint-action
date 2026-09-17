# smallprint-mcp

[Small Print](https://smallprint.dev) as an MCP server: four read-only tools over the public record of the tool descriptions, schemas and instructions of MCP servers, agent skills and plugins, hashed every version, diffed between versions, every change graded by a printed rule, public advisories joined by version.

```json
{ "mcpServers": { "smallprint": { "command": "npx", "args": ["-y", "smallprint-mcp"] } } }
```

Tools:

- `lookup_entry(name)`: what the record holds for one entry.
- `changes_since(name, since?, min_severity?)`: the releases that changed the small print, with each diff and the rule behind its grade.
- `advisories_for(name, version?)`: the advisories that name it, attributed to their sources, with version ranges.
- `changed_since_approval(name, approved)`: yes or no, before use: has the small print moved since the version, content hash or date that was reviewed. Answers start with UNCHANGED, CHANGED or UNKNOWN.

Names: `npm:@scope/name`, `pypi:name`, `mcp-registry:io.github.owner/server`, `skills.sh:owner/repo/skill`, `oci:ghcr.io/owner/image`; a bare name is read as npm.

The server reads https://smallprint.dev/api and nothing else. No account, nothing about your machine is sent, and it never calls the tool it looked up. Rate limited to one entry per request; for the whole record see the site. The rules behind every grade: https://smallprint.dev/how-we-grade.
