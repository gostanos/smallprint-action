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

/** Yes or no: has the small print moved since a version, a content hash or a date the caller approved? (decision 137) */
export function describeApproval(e: Entry, approved: string): string {
  const a = e.asset;
  const latest = e.baseline;
  const isHash = /^[0-9a-f]{64}$/i.test(approved);
  const isDate = /^\d{4}-\d{2}-\d{2}/.test(approved);
  const v = isHash ? e.versions.find((x) => x.contentHash?.toLowerCase() === approved.toLowerCase()) : isDate ? undefined : e.versions.find((x) => x.version === approved);
  if (!latest?.contentHash) return `UNKNOWN: the small print of ${a.displayName} has not been read yet, so nothing can be compared. Record: ${a.url}`;
  if (!isDate && !v) return `UNKNOWN: ${approved} is not a version or content hash on record for ${a.displayName}. Versions on record: ${e.versions.slice(0, 20).map((x) => x.version).join(", ")}${e.versions.length > 20 ? ", …" : ""}. Record: ${a.url}`;
  if (!isDate && !v!.contentHash) return `UNKNOWN: version ${v!.version} of ${a.displayName} is on record but its small print was not read, so it cannot be compared with ${latest.version}. Record: ${a.url}`;
  const since = isDate ? approved : (v!.publishedAt ?? "");
  const rel = e.releases.filter((r) => !r.identical && (r.publishedAt ?? "") > since);
  const same = isDate ? rel.length === 0 : v!.contentHash === latest.contentHash;
  const head = same
    ? `UNCHANGED: the small print of ${a.displayName} is the same as ${isDate ? `on ${day(since)}` : isHash ? "the approved hash" : `version ${approved}`}; latest ${latest.version}, content hash ${latest.contentHash}.`
    : `CHANGED: the small print of ${a.displayName} moved since ${isDate ? day(since) : isHash ? "the approved hash" : `version ${approved}`}. Latest ${latest.version}, content hash ${latest.contentHash}. ${rel.length} release(s) changed it; worst grade ${worstOf(rel)}.`;
  const lines = [head];
  for (const r of rel.slice(0, 6)) lines.push(`  ${r.from ?? "first read"} -> ${r.to} (${day(r.publishedAt)}), worst ${r.worst}: ${r.summary}`);
  if (rel.length > 6) lines.push(`  ${rel.length - 6} more at ${a.url}`);
  if (e.advisories.length) lines.push(`${e.advisories.length} advisory(ies) name it; ask advisories_for.`);
  lines.push(same ? `Review can stand. Record: ${a.url}` : `Re-review before use; changes_since shows each diff with its rule. Record: ${a.url}`);
  return lines.join("\n");
}

/** Structured shapes returned beside the text, so a client can read a field without parsing prose. */
const ADVISORY = z.object({ id: z.string(), severity: z.string(), source: z.string(), versionRange: z.string().nullable(), url: z.string() });
const RELEASE = z.object({ from: z.string().nullable(), to: z.string(), publishedAt: z.string().nullable(), worst: z.string(), summary: z.string(), changes: z.array(z.object({ field: z.string(), subject: z.string().nullable(), severity: z.string(), rule: z.string(), diff: z.string() })) });
const releaseOut = (r: Release) => ({ from: r.from, to: r.to, publishedAt: r.publishedAt, worst: r.worst, summary: r.summary, changes: r.changes.map((c) => ({ field: c.field, subject: c.subject, severity: c.severity, rule: c.severityRule, diff: c.diff })) });
const advisoryOut = (a: Advisory) => ({ id: a.id, severity: a.severity, source: a.source, versionRange: a.versionRange, url: a.url });
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const NAME_DESC = "The entry, with its registry prefix when known: npm:@scope/name, pypi:name, mcp-registry:io.github.owner/server, skills.sh:owner/repo/skill, oci:ghcr.io/owner/image. A bare name is read as an npm package. Case-sensitive, up to 300 characters.";
const BEHAVIOUR = "Read-only: one HTTPS GET to smallprint.dev per call, no account, no key, nothing about the caller sent, and the server or skill asked about is never run or contacted. Rate limited to one entry per request; a 429 answer says to wait a minute. A name not in the catalog returns a plain error, not a guess.";
const result = <T,>(textOut: string, structured: T) => ({ content: [{ type: "text" as const, text: textOut }], structuredContent: structured as Record<string, unknown> });
const errorResult = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], structuredContent: { error: msg }, isError: true });

export function buildServer(): McpServer {
  const server = new McpServer({ name: "smallprint", version: "0.2.0" }, { instructions: "Small Print keeps a public, dated record of the tool descriptions, schemas and instructions (the small print) of MCP servers, agent skills and plugins, hashed every version and diffed between versions, with every change graded by a printed rule and public advisories joined by version. Use these tools before installing or trusting a server or skill, or when a user asks whether one changed. Start with lookup_entry when you know nothing about an entry; use changed_since_approval when a version, hash or date was already reviewed; changes_since for the diffs themselves; advisories_for for the advisories. Facts only: every advisory is attributed to its source and nothing is called malicious." });
  server.registerTool(
    "lookup_entry",
    {
      title: "Look up an entry on the Small Print record",
      description: `What the record holds for one MCP server, skill or plugin: versions on record, the tools read from the pinned version, how many releases changed the small print and the worst grade, and the advisories that name it. Use it first, when nothing about the entry is known yet, or to confirm an entry exists before the other tools; use changes_since for the diffs and advisories_for for advisory detail. Not for private or unpublished servers, which have no page. ${BEHAVIOUR}`,
      inputSchema: { name: z.string().min(1).max(300).describe(NAME_DESC) },
      outputSchema: { canonicalName: z.string(), url: z.string(), kind: z.string(), latestVersion: z.string().nullable(), versionsOnRecord: z.number(), toolsRead: z.number().nullable(), releasesChanged: z.number(), worstGrade: z.string(), advisories: z.array(ADVISORY) },
      annotations: { title: "Look up an entry", ...READ_ONLY },
    },
    async ({ name }) => {
      const r = await readEntry(name);
      if ("error" in r) return errorResult(r.error);
      const e = r.entry;
      const changed = e.releases.filter((x) => !x.identical);
      return result(describeEntry(e), { canonicalName: e.asset.canonicalName, url: e.asset.url, kind: e.asset.kind, latestVersion: e.asset.latestVersion, versionsOnRecord: e.versions.length, toolsRead: e.tools ? e.tools.length : null, releasesChanged: changed.length, worstGrade: worstOf(changed), advisories: e.advisories.map(advisoryOut) });
    },
  );
  server.registerTool(
    "changes_since",
    {
      title: "Changes to an entry's small print",
      description: `The releases of one entry whose tool descriptions, schemas or instructions changed, each with its diff, its grade and the rule that graded it (rules at ${BASE}/how-we-grade). Use it to read what actually changed, after lookup_entry or changed_since_approval said something did; use changed_since_approval instead when the question is only whether anything moved since an approved version. Filters: since keeps releases published on or after a date; min_severity drops changes below a grade (default low, so plain version bumps and identical releases are never listed). Returns at most 12 releases in text; the structured result carries all of them. ${BEHAVIOUR}`,
      inputSchema: {
        name: z.string().min(1).max(300).describe(NAME_DESC),
        since: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional().describe("ISO date, YYYY-MM-DD; only releases published on or after it. Omit for every release on record."),
        min_severity: z.enum(["info", "low", "medium", "high", "critical"]).default("low").describe("Lowest grade to include: info, low, medium, high or critical. Default low. Use high to see only changes that name a secret, a destination or an instruction to hide something."),
      },
      outputSchema: { canonicalName: z.string(), url: z.string(), releases: z.array(RELEASE), total: z.number() },
      annotations: { title: "Changes to the small print", ...READ_ONLY },
    },
    async ({ name, since, min_severity }) => {
      const r = await readEntry(name);
      if ("error" in r) return errorResult(r.error);
      const e = r.entry;
      const floor = RANK[min_severity] ?? 1;
      const rel = e.releases.filter((x) => (!since || (x.publishedAt ?? "") >= since) && (RANK[x.worst] ?? 0) >= floor && !x.identical);
      return result(describeChanges(e, since, min_severity), { canonicalName: e.asset.canonicalName, url: e.asset.url, releases: rel.map(releaseOut), total: rel.length });
    },
  );
  server.registerTool(
    "advisories_for",
    {
      title: "Advisories that name an entry",
      description: `Every public security advisory on record that names one entry, each attributed to the database or report that published it, with its severity criterion and the affected version range. Use it when deciding whether a specific version is inside a known advisory, or after lookup_entry reported advisories; it adds nothing for an entry with none. Small Print attributes and never judges: the severity is the source's or a printed CVSS band. ${BEHAVIOUR}`,
      inputSchema: {
        name: z.string().min(1).max(300).describe(NAME_DESC),
        version: z.string().max(100).optional().describe("A version string to read the affected ranges against, for example 1.4.2. Optional; the ranges are returned either way and the caller compares."),
      },
      outputSchema: { canonicalName: z.string(), url: z.string(), advisories: z.array(ADVISORY), total: z.number() },
      annotations: { title: "Advisories for an entry", ...READ_ONLY },
    },
    async ({ name, version }) => {
      const r = await readEntry(name);
      if ("error" in r) return errorResult(r.error);
      const e = r.entry;
      return result(describeAdvisories(e, version), { canonicalName: e.asset.canonicalName, url: e.asset.url, advisories: e.advisories.map(advisoryOut), total: e.advisories.length });
    },
  );
  server.registerTool(
    "changed_since_approval",
    {
      title: "Has the small print changed since it was approved?",
      description: `Yes or no, before using a server or skill: has its small print moved since the version, content hash or date that was reviewed? The answer opens with UNCHANGED, CHANGED or UNKNOWN, then the releases that changed it since and their worst grade, then whether the review can stand. Use it on every run when an approval is on file, instead of re-reading the tools; use lookup_entry when nothing was approved yet and changes_since to read the diffs after a CHANGED answer. UNKNOWN means the approved version is not on record or its small print was never read, so nothing is compared; treat it as no answer, not as safe. ${BEHAVIOUR}`,
      inputSchema: {
        name: z.string().min(1).max(300).describe(NAME_DESC),
        approved: z.string().min(1).max(120).describe("What was reviewed: a version string exactly as published (1.4.2), the 64-character hex content hash from an earlier answer, or an ISO date YYYY-MM-DD. A date compares against releases published after it."),
      },
      outputSchema: { status: z.enum(["UNCHANGED", "CHANGED", "UNKNOWN"]), canonicalName: z.string(), url: z.string(), latestVersion: z.string().nullable(), latestContentHash: z.string().nullable(), releasesSince: z.array(RELEASE), worstGrade: z.string().nullable(), advisories: z.number() },
      annotations: { title: "Changed since approval?", ...READ_ONLY },
    },
    async ({ name, approved }) => {
      const r = await readEntry(name);
      if ("error" in r) return errorResult(r.error);
      const e = r.entry;
      const textOut = describeApproval(e, approved.trim());
      const status = textOut.startsWith("UNCHANGED") ? "UNCHANGED" : textOut.startsWith("CHANGED") ? "CHANGED" : "UNKNOWN";
      const a = approved.trim();
      const isDate = /^\d{4}-\d{2}-\d{2}/.test(a);
      const v = /^[0-9a-f]{64}$/i.test(a) ? e.versions.find((x) => x.contentHash?.toLowerCase() === a.toLowerCase()) : isDate ? undefined : e.versions.find((x) => x.version === a);
      const since = isDate ? a : (v?.publishedAt ?? "");
      const rel = status === "UNKNOWN" ? [] : e.releases.filter((x) => !x.identical && (x.publishedAt ?? "") > since);
      return result(textOut, { status, canonicalName: e.asset.canonicalName, url: e.asset.url, latestVersion: e.baseline?.version ?? null, latestContentHash: e.baseline?.contentHash ?? null, releasesSince: rel.map(releaseOut), worstGrade: rel.length ? worstOf(rel) : null, advisories: e.advisories.length });
    },
  );
  return server;
}

if (process.argv[1] && /smallprint-mcp(\.js)?$|main\.ts$/.test(process.argv[1])) {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
