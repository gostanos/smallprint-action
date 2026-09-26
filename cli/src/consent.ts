/**
 * Whether `check` may send the inventory (decision 239): nothing leaves the machine until the person says so. In a
 * terminal the command shows what it would send and asks; with no terminal to ask in, it sends nothing and says how
 * to opt in. A flag that only makes sense with a send (--upload, --yes, --share, --email) is the answer given up front.
 */
export interface ConsentFlags {
  noUpload: boolean;
  upload: boolean;
  yes: boolean;
  share: boolean;
  email: string | undefined;
}

export type Consent = "send" | "ask" | "skip";

export function sendConsent(f: ConsentFlags, isTTY: boolean): Consent {
  if (f.noUpload) return "skip";
  if (f.upload || f.yes || f.share || (f.email && f.email.length > 0)) return "send";
  return isTTY ? "ask" : "skip";
}

/** The answers that mean yes at the question. */
export const isYes = (answer: string): boolean => /^y(es)?$/i.test(answer.trim());
