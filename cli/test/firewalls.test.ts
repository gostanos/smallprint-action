/** Agent firewall presence (decision 156): each detection path with the tool present and absent; names only ever leave. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectFirewalls, FIREWALLS, firewallsForUpload } from "../src/firewalls";

function fixture(): { home: string; cwd: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), "sp-fw-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const bin = join(root, "bin");
  for (const d of [home, cwd, bin, join(home, ".claude"), join(cwd, ".claude")]) mkdirSync(d, { recursive: true });
  return { home, cwd, bin };
}
const env = (f: ReturnType<typeof fixture>) => ({ home: f.home, cwd: f.cwd, pathDirs: [f.bin], win: false });

describe("agent firewall presence", () => {
  it("a machine with none installed reports an empty list", () => {
    const f = fixture();
    writeFileSync(join(f.home, ".claude.json"), JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] } } }));
    writeFileSync(join(f.home, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "echo ok" }] }] } }));
    expect(detectFirewalls(env(f))).toEqual([]);
  });

  it("a binary on PATH is presence; a binary elsewhere is not", () => {
    const f = fixture();
    writeFileSync(join(f.bin, "pipelock"), "#!/bin/sh\n");
    expect(detectFirewalls(env(f))).toEqual(["pipelock"]);
    const g = fixture();
    mkdirSync(join(g.home, "elsewhere"));
    writeFileSync(join(g.home, "elsewhere", "pipelock"), "#!/bin/sh\n");
    expect(detectFirewalls(env(g))).toEqual([]);
  });

  it("an npm package under the PATH prefix or the project's node_modules is presence", () => {
    const f = fixture();
    mkdirSync(join(f.bin, "..", "lib", "node_modules", "ecc-agentshield"), { recursive: true });
    expect(detectFirewalls(env(f))).toEqual(["agentshield"]);
    const g = fixture();
    mkdirSync(join(g.cwd, "node_modules", "ecc-agentshield"), { recursive: true });
    expect(detectFirewalls(env(g))).toEqual(["agentshield"]);
    // npm "agent-firewall" and npm "agentshield" are other projects: their packages and bins are not presence of Martello or AgentShield
    const h2 = fixture();
    mkdirSync(join(h2.cwd, "node_modules", "agent-firewall"), { recursive: true });
    writeFileSync(join(h2.bin, "agent-firewall"), "");
    expect(detectFirewalls(env(h2))).toEqual([]);
    const h = fixture();
    mkdirSync(join(h.cwd, "node_modules", "some-other-package"), { recursive: true });
    expect(detectFirewalls(env(h))).toEqual([]);
  });

  it("a pip distribution in user site-packages, a venv or pipx is presence", () => {
    const f = fixture();
    mkdirSync(join(f.home, ".local", "lib", "python3.12", "site-packages", "agentgate_firewall-0.14.0.dist-info"), { recursive: true });
    expect(detectFirewalls(env(f))).toEqual(["agentgate"]);
    const g = fixture();
    mkdirSync(join(g.cwd, ".venv", "lib", "python3.11", "site-packages", "mcpkernel-0.1.0.dist-info"), { recursive: true });
    expect(detectFirewalls(env(g))).toEqual(["mcpkernel"]);
    const h = fixture();
    mkdirSync(join(h.home, ".local", "pipx", "venvs", "auditguard-mcp"), { recursive: true });
    expect(detectFirewalls(env(h))).toEqual(["auditguard-mcp"]);
    const k = fixture();
    mkdirSync(join(k.home, ".local", "lib", "python3.12", "site-packages", "requests-2.32.0.dist-info"), { recursive: true });
    expect(detectFirewalls(env(k))).toEqual([]);
  });

  it("a hook or MCP server command that names the tool is presence, in the home and project Claude settings and in any MCP config", () => {
    const f = fixture();
    writeFileSync(join(f.home, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "pipelock claude hook" }] }] } }));
    expect(detectFirewalls(env(f))).toEqual(["pipelock"]);
    const g = fixture();
    writeFileSync(join(g.cwd, ".claude", "settings.local.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "/opt/agentgate/bin/agentgate-hook.py", env: { AGENTGATE_POLICY: "/x/agentgate.yaml", AGENTGATE_DB: "/x/audit.db" } }] }] } }));
    expect(detectFirewalls(env(g))).toEqual(["agentgate"]);
    const h = fixture();
    writeFileSync(join(h.cwd, ".mcp.json"), JSON.stringify({ mcpServers: { fs: { command: "pipelock", args: ["mcp", "proxy", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem"] } } }));
    expect(detectFirewalls(env(h))).toEqual(["pipelock"]);
    const k = fixture();
    writeFileSync(join(k.home, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "", hook: "node -e \"...p.resolve('.agentshield/runtime-policy.json')...\"" }] } }));
    expect(detectFirewalls(env(k))).toEqual(["agentshield"]);
  });

  it("a file or directory the tool creates is presence: Martello's config, MCPKernel's project dir, Kiji's home dir, pipelock's config", () => {
    const f = fixture();
    writeFileSync(join(f.cwd, "firewall.config.json"), "{}");
    expect(detectFirewalls(env(f))).toEqual(["agent-firewall"]);
    const g = fixture();
    mkdirSync(join(g.cwd, ".mcpkernel"), { recursive: true });
    writeFileSync(join(g.cwd, ".mcpkernel", "config.yaml"), "");
    expect(detectFirewalls(env(g))).toEqual(["mcpkernel"]);
    const h = fixture();
    mkdirSync(join(h.home, ".kiji-proxy"), { recursive: true });
    expect(detectFirewalls(env(h))).toEqual(["kiji-proxy"]);
    const k = fixture();
    mkdirSync(join(k.home, ".config", "pipelock"), { recursive: true });
    writeFileSync(join(k.home, ".config", "pipelock", "pipelock.yaml"), "");
    expect(detectFirewalls(env(k))).toEqual(["pipelock"]);
    const m = fixture();
    writeFileSync(join(m.home, ".claude", "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: "http://127.0.0.1:8081", NODE_EXTRA_CA_CERTS: "/Users/x/Library/Application Support/Kiji Privacy Proxy/certs/ca.crt" } }));
    expect(detectFirewalls(env(m))).toEqual(["kiji-proxy"]);
  });

  it("several tools at once come back sorted and once each", () => {
    const f = fixture();
    writeFileSync(join(f.bin, "pipelock"), "");
    writeFileSync(join(f.bin, "mcpkernel"), "");
    writeFileSync(join(f.home, ".claude.json"), JSON.stringify({ mcpServers: { p: { command: "pipelock" } } }));
    expect(detectFirewalls(env(f))).toEqual(["mcpkernel", "pipelock"]);
  });

  it("an unreadable or oversized config is absence, never a crash", () => {
    const f = fixture();
    mkdirSync(join(f.home, ".claude.json"), { recursive: true }); // a directory where a file is expected
    expect(() => detectFirewalls(env(f))).not.toThrow();
    expect(detectFirewalls(env(f))).toEqual([]);
  });

  it("the upload carries names only, from the known list, nothing else", () => {
    const up = firewallsForUpload(["pipelock", "pipelock", "/usr/local/bin/pipelock", "kiji-proxy", "unknown-tool"]);
    expect(up).toEqual(["kiji-proxy", "pipelock"]);
    for (const n of up) expect(FIREWALLS.map((f) => f.name)).toContain(n);
    const json = JSON.stringify({ firewalls: up });
    expect(json).not.toMatch(/\/|\\|\.db|version|\d\.\d/);
  });
});
