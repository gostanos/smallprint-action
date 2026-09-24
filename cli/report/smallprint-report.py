#!/usr/bin/env python3
"""Small Print level-four reporter. Runs as root from a root-owned scheduled job, so an
agent running as the user cannot read its token, forge its report or stop it.

It does exactly what `smallprint sync` does for instruction files and skills, and nothing
else: hash a fixed list of files under one user's home, hash each skill folder, and post
kind labels, path hashes and content hashes to smallprint.dev. It never reads a file it did
not list, never follows a symbolic link, never executes anything, and never sends a path,
a file's contents or a config value. Standard library only, no dependencies, so the only
code running as root is this file and the system interpreter.

    smallprint-report.py --user nick --label "mac mini" [--every 6] [--base https://smallprint.dev]
                         [--token-file /etc/smallprint/token] [--dry-run] [--json]
"""
import argparse
import datetime
import hashlib
import json
import os
import pwd
import re
import stat as S
import sys
import urllib.error
import urllib.request

VERSION = "0.0.13"
FILE_MAX = 5_000_000
DIR_MAX_FILES = 200
SKILL_MAX_FILES = 2000
IMPORT_MAX, IMPORT_DEPTH = 20, 3


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_text(s: str) -> str:
    return sha256(s.encode("utf-8"))


def locations(home: str, cwd: str):
    j = os.path.join

    def openclaw(root):
        return [(j(root, f), "openclaw", f"OpenClaw {f}, home", "home", None) for f in ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md", "HEARTBEAT.md", "BOOTSTRAP.md", "MEMORY.md"]]

    desktop = j(home, "Library", "Application Support", "Claude", "claude_desktop_config.json") if sys.platform == "darwin" else j(os.environ.get("APPDATA", j(home, "AppData", "Roaming")), "Claude", "claude_desktop_config.json")
    L = [
        (j(home, ".claude", "CLAUDE.md"), "claude-code", "Claude Code CLAUDE.md, home", "home", None),
        (j(home, ".claude", "settings.json"), "claude-code", "Claude Code settings.json, home", "home", None),
        (j(cwd, "CLAUDE.md"), "claude-code", "Claude Code CLAUDE.md, project", "project", None),
        (j(cwd, "CLAUDE.local.md"), "claude-code", "Claude Code CLAUDE.local.md, project", "project", None),
        (j(cwd, ".claude", "CLAUDE.md"), "claude-code", "Claude Code .claude/CLAUDE.md, project", "project", None),
        (j(cwd, ".claude", "settings.json"), "claude-code", "Claude Code settings.json, project", "project", None),
        (j(cwd, ".claude", "settings.local.json"), "claude-code", "Claude Code settings.local.json, project", "project", None),
        (j(home, ".codex", "AGENTS.md"), "codex", "Codex AGENTS.md, home", "home", None),
        (j(cwd, "AGENTS.md"), "codex", "Codex AGENTS.md, project", "project", None),
        (j(cwd, ".cursorrules"), "cursor", "Cursor .cursorrules, project", "project", None),
        (j(cwd, ".cursor", "rules"), "cursor", "Cursor rules file, project", "project", "dir"),
        (j(home, ".codeium", "windsurf", "memories", "global_rules.md"), "windsurf", "Windsurf global rules, home", "home", None),
        (j(cwd, ".windsurfrules"), "windsurf", "Windsurf .windsurfrules, project", "project", None),
        (j(cwd, ".windsurf", "rules"), "windsurf", "Windsurf rules file, project", "project", "dir"),
        (j(home, ".claude", "agents"), "claude-code", "Claude Code agent definition, home", "home", "dir"),
        (j(cwd, ".claude", "agents"), "claude-code", "Claude Code agent definition, project", "project", "dir"),
        (j(home, ".claude", "commands"), "claude-code", "Claude Code command, home", "home", "dir"),
        (j(cwd, ".claude", "commands"), "claude-code", "Claude Code command, project", "project", "dir"),
        (j(cwd, ".github", "copilot-instructions.md"), "manual", "Copilot instructions, project", "project", None),
        (j(home, ".gemini", "GEMINI.md"), "manual", "Gemini GEMINI.md, home", "home", None),
        (j(cwd, "GEMINI.md"), "manual", "Gemini GEMINI.md, project", "project", None),
        (j(cwd, ".clinerules"), "manual", "Cline .clinerules, project", "project", None),
        (j(cwd, ".roo", "rules"), "manual", "Roo rules file, project", "project", "dir"),
        (desktop, "claude-desktop", "Claude Desktop MCP servers, home", "home", "mcp-json"),
        (j(home, ".claude.json"), "claude-code", "Claude Code MCP servers, home", "home", "mcp-json"),
        (j(cwd, ".mcp.json"), "claude-code", "Claude Code MCP servers, project", "project", "mcp-json"),
        (j(home, ".cursor", "mcp.json"), "cursor", "Cursor MCP servers, home", "home", "mcp-json"),
        (j(cwd, ".cursor", "mcp.json"), "cursor", "Cursor MCP servers, project", "project", "mcp-json"),
        (j(home, ".codeium", "windsurf", "mcp_config.json"), "windsurf", "Windsurf MCP servers, home", "home", "mcp-json"),
        (j(home, ".codex", "config.toml"), "codex", "Codex config.toml, home", "home", None),
    ]
    L += openclaw(j(home, ".openclaw", "workspace")) + openclaw(j(home, "clawd"))
    L.append((j(home, ".openclaw", "openclaw.json"), "openclaw", "OpenClaw config, home", "home", None))
    return L


def canon(v):
    if isinstance(v, list):
        return [canon(x) for x in v]
    if isinstance(v, dict):
        return {k: canon(v[k]) for k in sorted(v)}
    return v


def dumps(v) -> str:
    # matches JSON.stringify: no spaces, keys in the order given
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)


def mcp_digest(text: str):
    try:
        j = json.loads(text)
    except Exception:
        return None
    if not isinstance(j, dict):
        return None
    servers = {}

    def take(m, prefix):
        if not isinstance(m, dict):
            return
        for name, d in m.items():
            if isinstance(d, dict):
                d = dict(d)
                if isinstance(d.get("env"), dict):
                    d["env"] = {k: f"sha256:{sha256_text(str(v))}" for k, v in d["env"].items()}
            servers[prefix + name] = canon(d)

    take(j.get("mcpServers"), "")
    if isinstance(j.get("projects"), dict):
        for path, p in j["projects"].items():
            take(p.get("mcpServers") if isinstance(p, dict) else None, f"project:{sha256_text(path)[:12]}/")
    sections = {name: sha256_text(dumps(d)) for name, d in servers.items()}
    return sha256_text(dumps(canon(servers))), sections


def section_hashes(text: str):
    try:
        j = json.loads(text)
    except Exception:
        return None
    if not isinstance(j, dict):
        return None
    return {k: sha256_text(dumps(v)) for k, v in j.items()}


IMPORT_RE = re.compile(r"(?:^|\s)@((?:~/|\.{1,2}/|/)[^\s\"'`)]+)")


def claude_imports(text: str, from_dir: str, home: str):
    out = []
    for m in IMPORT_RE.finditer(text):
        raw = m.group(1)
        p = os.path.join(home, raw[2:]) if raw.startswith("~/") else (raw if raw.startswith("/") else os.path.normpath(os.path.join(from_dir, raw)))
        if p not in out:
            out.append(p)
        if len(out) >= IMPORT_MAX:
            break
    return out


def read_one(path, host, kind, scope, mode, imported=False):
    st = os.lstat(path)
    if not S.S_ISREG(st.st_mode) or st.st_size > FILE_MAX:
        return None
    with open(path, "rb") as f:
        buf = f.read()
    if mode == "mcp-json":
        d = mcp_digest(buf.decode("utf-8", "replace"))
        if not d:
            return None
        return {"path": path, "host": host, "kind": kind, "scope": scope, "sha256": d[0], "sections": d[1]}
    out = {"path": path, "host": host, "kind": kind, "scope": scope, "sha256": sha256(buf)}
    # an imported file is hashed whole: no per-key hashes for text whose path the import author chose
    if not imported and path.endswith(".json"):
        s = section_hashes(buf.decode("utf-8", "replace"))
        if s is not None:
            out["sections"] = s
    return out


def import_allowed(path, home, owner_uid):
    """This runs as root, and the import line was written by the user (or an agent running as the user). Only a file
    inside the user's own home and owned by the user is followed: never /etc/shadow, never a root-owned file the user
    could not read themselves, and never a hash of it (decision 110)."""
    try:
        real = os.path.realpath(path)
        base = os.path.realpath(home)
        if real != base and not real.startswith(base + os.sep):
            return False
        return os.lstat(path).st_uid == owner_uid
    except Exception:
        return False


def read_files(home, cwd):
    out, seen = [], set()
    try:
        owner_uid = os.stat(home).st_uid
    except Exception:
        owner_uid = -1

    def push(f):
        if f and f["path"] not in seen:
            seen.add(f["path"])
            out.append(f)
            return True
        return False

    def follow(path, host, kind, scope, depth):
        if depth > IMPORT_DEPTH or (depth == 1 and not re.search(r"CLAUDE(?:\.local)?\.md$", path)):
            return
        try:
            text = open(path, "rb").read().decode("utf-8", "replace")
        except Exception:
            return
        for imp in claude_imports(text, os.path.dirname(path), home):
            if imp in seen or not os.path.exists(imp) or not import_allowed(imp, home, owner_uid):
                continue
            try:
                k = re.sub(r", (home|project)$", "", kind) + f" import, {scope}"
                if push(read_one(imp, host, k, scope, None, imported=True)):
                    follow(imp, host, kind, scope, depth + 1)
            except Exception:
                pass

    for path, host, kind, scope, mode in locations(home, cwd):
        if not os.path.exists(path):
            continue
        try:
            if mode == "dir":
                if not os.path.isdir(path) or os.path.islink(path):
                    continue
                for name in sorted(os.listdir(path))[:DIR_MAX_FILES]:
                    if name.startswith("."):
                        continue
                    push(read_one(os.path.join(path, name), host, kind, scope, None))
            elif push(read_one(path, host, kind, scope, mode)):
                follow(path, host, kind, scope, 1)
        except Exception:
            pass
    return out


def read_skills(home, cwd):
    items = []
    roots = [(os.path.join(home, ".claude", "skills"), "claude-code"), (os.path.join(cwd, ".claude", "skills"), "claude-code"), (os.path.join(home, ".openclaw", "skills"), "openclaw"), (os.path.join(home, "clawd", "skills"), "openclaw")]
    seen = set()
    for root, host in roots:
        if root in seen or not os.path.isdir(root) or os.path.islink(root):
            continue
        seen.add(root)
        for name in sorted(os.listdir(root)):
            d = os.path.join(root, name)
            if os.path.islink(d) or not os.path.isdir(d):
                continue
            skill_md = os.path.join(d, "SKILL.md")
            if not os.path.isfile(skill_md) or os.path.islink(skill_md):
                continue
            files = []
            for dp, dns, fns in os.walk(d):
                dns[:] = [x for x in sorted(dns) if x not in ("node_modules", ".git") and not os.path.islink(os.path.join(dp, x))]
                for fn in sorted(fns):
                    fp = os.path.join(dp, fn)
                    if fn == ".DS_Store" or os.path.islink(fp) or not os.path.isfile(fp):
                        continue
                    if os.path.getsize(fp) > FILE_MAX or len(files) >= SKILL_MAX_FILES:
                        continue
                    with open(fp, "rb") as fh:
                        files.append((os.path.relpath(fp, d).replace(os.sep, "/"), sha256(fh.read())))
            tree = sha256_text("\n".join(f"{p} {h}" for p, h in sorted(files)))
            with open(skill_md, "rb") as fh:
                skill_hash = sha256(fh.read())
            items.append({"kind": "agent-skill", "host": host, "name": name, "canonicalName": None, "version": None, "skillMdSha256": skill_hash, "treeSha256": tree})
    return items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--every", type=float, default=6)
    ap.add_argument("--base", default="https://smallprint.dev")
    ap.add_argument("--token-file", default="/etc/smallprint/token")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--home", help="read this directory instead of the account's home (tests)")
    a = ap.parse_args()
    if not (a.base.startswith("https://") or a.base.startswith("http://localhost") or a.base.startswith("http://127.0.0.1")):
        sys.exit("refusing a non-https base")
    home = a.home or pwd.getpwnam(a.user).pw_dir
    files = read_files(home, home)
    items = read_skills(home, home)
    upload = [{"pathHash": sha256_text(f["path"]), "kind": f["kind"], "host": f["host"], "scope": "home", "sha256": f["sha256"], **({"sections": f["sections"]} if "sections" in f else {})} for f in files if f["scope"] == "home"]
    body = {"label": a.label, "items": items, "files": upload, "scopes": ["home"], "scheduled": True, "every": int(a.every * 3600), "reporter": "system"}
    if a.json:
        print(dumps({"files": [{"path": f["path"], "kind": f["kind"], "sha256": f["sha256"], **({"sections": f["sections"]} if "sections" in f else {})} for f in files], "items": items}))
        return
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if a.dry_run:
        print(f"[{stamp}] dry run: would send {len(upload)} files and {len(items)} skills for {a.user} as {a.label!r} to {a.base}")
        return
    try:
        with open(a.token_file) as fh:
            token = fh.read().strip()
    except Exception as e:
        sys.exit(f"[{stamp}] no token at {a.token_file}: {e}")
    req = urllib.request.Request(a.base.rstrip("/") + "/api/sync", data=dumps(body).encode(), headers={"content-type": "application/json", "authorization": f"Bearer {token}", "user-agent": f"smallprint-report/{VERSION}"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            res = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        # the server's one line says why (a token revoked, a plan without the scheduled run); print it, not just the status
        try:
            detail = json.loads(e.read().decode()).get("error") or e.reason
        except Exception:
            detail = e.reason
        sys.exit(f"[{stamp}] send refused ({e.code}): {detail}")
    except Exception as e:
        sys.exit(f"[{stamp}] send failed: {e}")
    f = res.get("files") or {}
    changed = f.get("changed", []) + f.get("removed", []) + f.get("returned", [])
    print(f"[{stamp}] reported {f.get('recorded', 0)} files and {len(items)} skills for {a.user} as {a.label!r}" + (f"; {len(changed)} CHANGED" if changed else ""))
    for c in changed:
        where = f"  in: {', '.join(c['where']) or 'formatting only'}" if c.get("where") is not None else ""
        print(f"  {c.get('kind')}  was {(c.get('from') or 'none')[:12]}, now {(c.get('to') or 'none')[:12]}{where}")


if __name__ == "__main__":
    main()
