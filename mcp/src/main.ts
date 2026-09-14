#!/usr/bin/env node
/**
 * Small Print as an MCP server (decision 123): three read-only tools over the public read API, so an agent can ask
 * what the record holds for a server or skill it is about to use. The server reads https://smallprint.dev/api and
 * nothing else; it holds no account, sends nothing about the machine, and never calls the tool it looked up.
 *   npx smallprint-mcp            stdio transport, for a client's MCP config
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.SMALLPRINT_BASE_URL ?? "https://smallprint.dev").replace(/\/$/, "");
const UA = "smallprint-mcp/0.1 (+https://smallprint.dev)";

interface Change { field: string; subject: string | null; severity: string; severityRule: string; diff: string }
interface Release { from: string | null; to: string; publishedAt: string | null; worst: string; identical: boolean; summary: string; changes: Change[] }
interface Advisory { id: string; aliases: string[]; severity: string; severityRule: string; criterion: string; summary: string; attribution: string | null; source: string; published: string | null; versionRange: string | null; url: string }
interface Entry {
  asset: { canonicalName: string; displayName: string; kind: string; registry: string; description: string | null; sourceUrl: string | null; repoUrl: string | null; maintainer: string | null; installCount: number | null; latestVersion: string | null; inCatalogSince: string | null; url: string };
  baseline: { version: string; publishedAt: string | null; contentHash: string | null; treeHash: string | null } | null;
  tools: { name: string; description?: string; inputSchema?: unknown }[] | null;
  skillMd: string | null;
  advisories: Advisory[];
  releases: Release[];
  versions: { version: string; publishedAt: string | null; contentHash: string | null; treeHash: string | null }[];
  notice: string;
}

/** "npm:@scope/name", "npm/@scope/name" or a bare "@scope/name" (npm assumed) to the API path. */
export function apiPath(name: string): string | null {
  const s = name.trim();
  if (!s || s.length > 300 || /[\s"'<>]/.test(s)) return null;
  let registry: string;
  let rest: string;
  const colon = s.indexOf(":");
  const slash = s.indexOf("/");
  if (colon > 0 && (slash === -1 || colon < slash)) {
    registry = s.slice(0, colon);
    rest = s.slice(colon + 1);
  } else if (slash > 0 && !s.startsWith("@") && /^(npm|pypi|oci|docker|huggingface|mcp-registry|clawhub|skills\.sh|gemini|zed|github|claude-plugins|smithery|nuget|mcpb)$/.test(s.slice(0, slash))) {
    registry = s.slice(0, slash);
    rest = s.slice(slash + 1);
  } else {
    registry = "npm";
    rest = s;
  }
  if (!/^[a-z0-9.-]+$/i.test(registry) || !rest) return null;
  return `/api/asset/${registry}/${rest.split("/").map(encodeURIComponent).join("/")}`;
}

async function readEntry(name: string): Promise<{ entry: Entry } | { error: string }> {
  const path = apiPath(name);
  if (!path) return { error: `"${name}" is not a name the record uses. Try "npm:@scope/name", "pypi:name", "mcp-registry:io.github.owner/server" or "skills.sh:owner/repo/skill".` };
  const res = await fetch(`${BASE}${path}`, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return { error: `Not in the catalog: ${name}. The record lists what the public registries publish; a private or unpublished server has no page.` };
  if (res.status === 429) return { error: "The read API is one entry per request and rate limited; wait a minute and ask again." };
  if (!res.ok) return { error: `smallprint.dev answered ${res.status}.` };
  return { entry: (await res.json()) as Entry };
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const day = (d: string | null | undefined) => (d ? d.slice(0, 10) : "unknown date");

export function describeEntry(e: Entry): string {
  const a = e.asset;
  const lines = [
    `${a.displayName} (${a.canonicalName}), a ${a.kind} on ${a.registry}. Record: ${a.url}`,
    a.description ? `Registry description: ${a.description}` : null,
    `${e.versions.length} version(s) on record; latest ${a.latestVersion ?? "unknown"}${a.installCount != null ? `; ${a.installCount.toLocaleString("en-US")} installs (${a.registry})` : ""}.`,
    e.tools ? `${e.tools.length} tool(s) read from the pinned version: ${e.tools.slice(0, 40).map((t) => t.name).join(", ")}${e.tools.length > 40 ? ", …" : ""}.` : e.skillMd ? "SKILL.md read from the pinned version." : "The small print of this entry has not been read yet.",
    e.releases.length ? `${e.releases.length} release(s) diffed; worst change graded ${worstOf(e.releases)}.` : "No release has been diffed yet.",
    e.advisories.length ? `${e.advisories.length} advisory(ies) name it: ${e.advisories.map((v) => `${v.id} (${v.severity}, ${v.source})`).join("; ")}.` : "No advisory on record names it.",
    a.repoUrl ? `Source: ${a.repoUrl}` : null,
    e.notice,
  ];
  return lines.filter(Boolean).join("\n");
}

const RANK: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
function worstOf(releases: Release[]): string {
  return releases.reduce<string>((w, r) => ((RANK[r.worst] ?? 0) > (RANK[w] ?? 0) ? r.worst : w), "info");
}

export function describeChanges(e: Entry, since: string | undefined, minSeverity: string): string {
  const floor = RANK[minSeverity] ?? 1;
  const rel = e.releases.filter((r) => (!since || (r.publishedAt ?? "") >= since) && (RANK[r.worst] ?? 0) >= floor && !r.identical);
  if (!rel.length) return `No release of ${e.asset.displayName}${since ? ` since ${day(since)}` : ""} changed its small print at ${minSeverity} or above. ${e.releases.length} release(s) are on record. ${e.asset.url}`;
  const out = [`${e.asset.displayName}: ${rel.length} release(s)${since ? ` since ${day(since)}` : ""} changed the small print (grade ${minSeverity} or above). Each grade prints its rule; the rules are at ${BASE}/how-we-grade.`];
  for (const r of rel.slice(0, 12)) {
    out.push(`\n${r.from ?? "first read"} -> ${r.to} (${day(r.publishedAt)}), worst ${r.worst}: ${r.summary}`);
    for (const c of r.changes.filter((c) => (RANK[c.severity] ?? 0) >= floor).slice(0, 8)) out.push(`  [${c.severity}] ${c.field}${c.subject ? ` ${c.subject}` : ""} (${c.severityRule})\n    ${c.diff.split("\n").slice(0, 6).join("\n    ")}`);
  }
  if (rel.length > 12) out.push(`\n${rel.length - 12} more release(s) at ${e.asset.url}`);
  return out.join("\n");
}

export function describeAdvisories(e: Entry, version: string | undefined): string {
  if (!e.advisories.length) return `No advisory on record names ${e.asset.displayName}. Record: ${e.asset.url}`;
  const out = [`${e.advisories.length} advisory(ies) name ${e.asset.displayName}${version ? `; version ranges are shown so you can read whether ${version} is inside one` : ""}. Each is attributed to the database or report that published it; Small Print adds no verdict.`];
  for (const a of e.advisories) out.push(`\n${a.id}${a.aliases.length ? ` (${a.aliases.join(", ")})` : ""}: ${a.severity}, ${a.criterion}\n  ${a.summary}\n  affects: ${a.versionRange ?? "range not stated"}; published ${day(a.published)}; ${a.attribution ?? a.source}; ${a.url}`);
  return out.join("\n");
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "smallprint", version: "0.1.0" }, { instructions: "Small Print keeps a public, dated record of the tool descriptions, schemas and instructions (the small print) of MCP servers, agent skills and plugins, hashed every version and diffed between versions, with every change graded by a printed rule and public advisories joined by version. Use these tools before installing or trusting a server or skill, or when a user asks whether one changed. Facts only: the record attributes every advisory to its source and never calls anything malicious." });
  server.registerTool(
    "lookup_entry",
    { title: "Look up an entry on the Small Print record", description: "What the record holds for one MCP server, skill or plugin: versions on record, the tools read from the pinned version, how many releases changed the small print and the worst grade, and the advisories that name it. Name forms: npm:@scope/name, pypi:name, mcp-registry:io.github.owner/server, skills.sh:owner/repo/skill, oci:ghcr.io/owner/image; a bare name is read as npm.", inputSchema: { name: z.string().min(1).max(300).describe("The entry's name, with its registry prefix when known") } },
    async ({ name }) => { const r = await readEntry(name); return text("error" in r ? r.error : describeEntry(r.entry)); },
  );
  server.registerTool(
    "changes_since",
    { title: "Changes to an entry's small print", description: "The releases of one entry whose tool descriptions, schemas or instructions changed, with each change's diff, grade and the rule that graded it. Optionally only releases published since a date and only changes at or above a grade.", inputSchema: { name: z.string().min(1).max(300), since: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional().describe("ISO date; releases published on or after it"), min_severity: z.enum(["info", "low", "medium", "high", "critical"]).default("low") } },
    async ({ name, since, min_severity }) => { const r = await readEntry(name); return text("error" in r ? r.error : describeChanges(r.entry, since, min_severity)); },
  );
  server.registerTool(
    "advisories_for",
    { title: "Advisories that name an entry", description: "Every public security advisory on record that names one entry, each attributed to the database or report that published it, with its severity criterion and the affected version range.", inputSchema: { name: z.string().min(1).max(300), version: z.string().max(100).optional().describe("A version to read the ranges against") } },
    async ({ name, version }) => { const r = await readEntry(name); return text("error" in r ? r.error : describeAdvisories(r.entry, version)); },
  );
  return server;
}

if (process.argv[1] && /smallprint-mcp(\.js)?$|main\.ts$/.test(process.argv[1])) {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
