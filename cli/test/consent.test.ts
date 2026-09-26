import { describe, expect, it } from "vitest";
import { isYes, sendConsent } from "../src/consent";

const none = { noUpload: false, upload: false, yes: false, share: false, email: undefined };

describe("nothing leaves the machine until the person says so (decision 239)", () => {
  it("asks in a terminal, and sends nothing where there is no terminal to ask in", () => {
    expect(sendConsent(none, true)).toBe("ask");
    expect(sendConsent(none, false)).toBe("skip");
  });

  it("takes a flag that only makes sense with a send as the answer", () => {
    expect(sendConsent({ ...none, upload: true }, false)).toBe("send");
    expect(sendConsent({ ...none, yes: true }, false)).toBe("send");
    expect(sendConsent({ ...none, share: true }, true)).toBe("send");
    expect(sendConsent({ ...none, email: "you@example.com" }, false)).toBe("send");
    expect(sendConsent({ ...none, email: "" }, true)).toBe("ask");
  });

  it("--no-upload wins over everything", () => {
    expect(sendConsent({ ...none, noUpload: true, upload: true, yes: true, share: true, email: "you@example.com" }, true)).toBe("skip");
  });

  it("reads y and yes as yes, and anything else as no", () => {
    for (const a of ["y", "Y", "yes", " YES "]) expect(isYes(a)).toBe(true);
    for (const a of ["", "n", "no", "maybe", "yep"]) expect(isYes(a)).toBe(false);
  });
});
