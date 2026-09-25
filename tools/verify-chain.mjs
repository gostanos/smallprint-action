// Recompute Small Print's record chain from the public API and check every link, the newest day's entries hash and
// the Ed25519 signature. No dependencies beyond Node 18+. Usage: node verify-chain.mjs [https://smallprint.dev]
// Method, as the API prints it: entries_hash = sha256 of the lines "canonical_name<TAB>version<TAB>content_hash<LF>"
// sorted by name then version; chain_hash = sha256 of prev_hash + LF + day + LF + through_at + LF + entries_hash;
// the first prev_hash is 64 zeros; signature = Ed25519 over the UTF-8 bytes of chain_hash, base64.
import { createHash, createPublicKey, verify } from "node:crypto";

const base = (process.argv[2] ?? "https://smallprint.dev").replace(/\/$/, "");
const ua = { headers: { "user-agent": "smallprint-verify-chain/1 (+https://smallprint.dev)" } };
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const chain = await (await fetch(`${base}/api/chain`, ua)).json();
const rows = [...chain.rows].sort((a, b) => (a.day < b.day ? -1 : 1));
let ok = true;
const say = (good, text) => { ok = ok && good; console.log(`${good ? "ok  " : "FAIL"} ${text}`); };

let prev = "0".repeat(64);
for (const r of rows) {
  say(r.prevHash === prev, `${r.day}: prev_hash links to the day before`);
  say(sha256(`${r.prevHash}\n${r.day}\n${r.throughAt}\n${r.entriesHash}`) === r.chainHash, `${r.day}: chain_hash recomputes`);
  prev = r.chainHash;
}

const last = rows[rows.length - 1];
const day = await (await fetch(`${base}/api/chain/${last.day}`, ua)).json();
const lines = [...day.lines].sort((a, b) => (a.canonicalName === b.canonicalName ? (a.version < b.version ? -1 : a.version > b.version ? 1 : 0) : a.canonicalName < b.canonicalName ? -1 : 1));
const entries = sha256(lines.map((l) => `${l.canonicalName}\t${l.version}\t${l.contentHash}\n`).join(""));
say(entries === last.entriesHash, `${last.day}: entries_hash recomputes from ${lines.length} lines`);

try {
  const pem = await (await fetch(`${base}/.well-known/smallprint-chain-key.pub`, ua)).text();
  const key = createPublicKey(pem);
  const good = verify(null, Buffer.from(last.chainHash, "utf8"), key, Buffer.from(last.signature, "base64"));
  say(good, `${last.day}: Ed25519 signature verifies against the published key`);
} catch (e) {
  say(false, `signature check could not run: ${e.message}`);
}
console.log(ok ? `\nThe chain holds: ${rows.length} days, ${rows[0].day} to ${last.day}.` : "\nSomething did not recompute; see FAIL above.");
process.exit(ok ? 0 : 1);
