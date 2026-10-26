// Spam category taxonomy — mirrors the server's SPAM_CATEGORIES
// (services/edge/src/index.ts). Categories are assigned server-side by the
// LLM / maintainer-curated keyword rules and shipped inside the bundled
// blacklist; the extension only consumes them (no local guessing).

export type SpamCategory = "porn" | "crypto" | "gambling" | "resource" | "marketing" | "other";

export const SPAM_CATEGORIES: readonly SpamCategory[] = [
  "porn",
  "crypto",
  "gambling",
  "resource",
  "marketing",
  "other",
];

/** 1-char codes used by the lite blocklist format (schema v2). */
const CODE_TO_CATEGORY: Record<string, SpamCategory> = {
  p: "porn",
  c: "crypto",
  g: "gambling",
  r: "resource",
  m: "marketing",
  o: "other",
};

export function categoryFromCode(code: string | undefined): SpamCategory {
  return (code && CODE_TO_CATEGORY[code]) || "other";
}

export const CATEGORY_ZH: Record<SpamCategory, string> = {
  porn: "色情招揽",
  crypto: "币圈投放",
  gambling: "博彩推广",
  resource: "网盘资源",
  marketing: "营销引流",
  other: "其它",
};

export function isSpamCategory(v: unknown): v is SpamCategory {
  return typeof v === "string" && (SPAM_CATEGORIES as readonly string[]).includes(v);
}
