// What a first name and an address name may look like. Shared by the menu machine (to answer at once)
// and by users.ts (the check that counts). No I/O.
// Callers: ussd/machine.ts, users.ts.

/** 2 to 16 characters: letters first, then letters, spaces, apostrophes or hyphens. No digits, no line breaks. */
export const NAME_RE = /^\p{L}[\p{L}' -]{1,15}$/u;

/** 3 to 20 characters: lower-case letters, digits and dashes, not starting or ending with a dash. */
export const ALIAS_RE = /^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/;

/** Names a scammer would love to own as an address: support@, agent@, melax@. */
const RESERVED = new Set(["melax", "admin", "administrateur", "support", "aide", "help", "agent", "agents", "service", "securite", "security", "info", "contact", "bank", "banque", "wave", "orange", "orange-money", "free-money", "bceao", "root", "postmaster", "abuse"]);

export function isReservedAlias(alias: string): boolean {
  return RESERVED.has(alias) || alias.startsWith("melax-") || alias.endsWith("-melax");
}
