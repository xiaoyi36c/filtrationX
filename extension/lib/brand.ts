// Single source of truth for the fork's public identity, mirrored loosely
// from the upstream `services/edge/src/brand.ts`. filtrationX 二开 branding:
// product identity points at THIS fork; governance / privacy / appeals keep
// pointing at the upstream repo because the public list and its review
// process still live there.
export const BRAND = {
  /** Full product name shown in title bars / hero / about. */
  name: "X SPAM FILTER",
  /** Short acronym for compact surfaces (popup header, content-script badges). */
  acronym: "filtrationX",
  /** Single-line positioning. */
  tagline: "本地优先，帮你拦 X 上的垃圾",
  /** This fork's GitHub repo URL (no trailing slash). */
  repo: "https://github.com/xiaoyi36c/filtrationX",
  /** This fork's releases page. */
  release: "https://github.com/xiaoyi36c/filtrationX/releases/latest",
  /** The upstream project this fork is based on. */
  upstreamRepo: "https://github.com/foru17/make-x-great-again",
  /** Chrome Web Store listing of the upstream build (kept for reference). */
  chromeWebStore:
    "https://chromewebstore.google.com/detail/make-x-great-again/aeoldnecphbkkckeedfgfcdcekkljdea",
  /** Mozilla Add-ons (AMO) listing of the upstream build. */
  firefoxAddons: "https://addons.mozilla.org/firefox/addon/make-x-great-again/",
  /** TestFlight invite — upstream Apple platforms build. */
  testFlight: "https://testflight.apple.com/join/SeH4raps",
  /** Public Worker base URL (custom domain). Extension can override in settings. */
  edgeBase: "https://x.zuoluo.tv",
  /** Governance doc inside the upstream repo. */
  governance:
    "https://github.com/foru17/make-x-great-again/blob/main/GOVERNANCE.md",
  /** Privacy doc inside the upstream repo. */
  privacy:
    "https://github.com/foru17/make-x-great-again/blob/main/docs/PRIVACY.md",
  /** Appeal / removal request entry (used by content-script bubble). */
  appealNewIssue:
    "https://github.com/foru17/make-x-great-again/issues/new?template=appeal.yml",
  /** Generic issue tracker URL of the upstream repo (rebind fallback etc.). */
  issues: "https://github.com/foru17/make-x-great-again/issues",
  /** Owner display name. */
  owner: "xiaoyi36c",
  /** License id. */
  license: "AGPL-3.0",
} as const;
