import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// the command names its version in --version and in its user agent from a constant; 0.1.0 shipped saying 0.0.15
// because nothing tied the two together (24 Sep 2026)
describe("the version the command reports", () => {
  it("is the version in package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const constant = /^const VERSION = "([^"]+)";/m.exec(main)?.[1];
    expect(constant).toBe(pkg.version);
  });
});
