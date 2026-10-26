import type { SpamCategory } from "./category";
import type { LocalDataMutation } from "./local-data";

export type Label = "spam" | "porn_bot" | "likely_spam" | "uncertain" | "legit";

export interface Verdict {
  label: Label;
  confidence: number;
  reasons: string[];
  /** Spam category from the edge classifier (optional: legacy cached
   *  verdicts predate the field). Local heuristics stamp it at render time. */
  category?: SpamCategory;
}

export interface CurationRecord {
  userId: string;
  handle: string;
  verdict: Verdict;
  reviewStatus: string;
  model: string;
}

/** Signals scraped passively from the rendered DOM. */
export interface Signals {
  isProfile: boolean;
  userId?: string;
  handle: string;
  displayName: string;
  bio: string;
  hasDefaultAvatar: boolean;
  /** Where hasDefaultAvatar came from: "profile" = X's own
   *  default_profile_image flag (reliable); "dom" = no <img> found in the
   *  rendered row (unreliable — lazy-loading fails on real avatars). */
  avatarSource?: "profile" | "dom";
  avatarUrl?: string;
  /** Extra profile facts X already holds in the page (fiber / bridge). */
  isVerified?: boolean;
  statusesCount?: number;
  mediaCount?: number;
  favouritesCount?: number;
  location?: string;
  recentTweets: string[];
  triggeringComment?: string;
  threadTopic?: string;
  /** X's own registration timestamp, ISO-8601. Only the profile object in
   *  X's React state carries this — the rendered DOM shows a coarse join
   *  month — so its presence is a reliable tell for whether the MAIN-world
   *  bridge (lib/x-user-bridge.ts) is delivering profile signals at all. */
  accountCreatedAt?: string;
  accountAgeDays?: number;
  followersCount?: number;
  followingCount?: number;
  /** Profile-surface only: how many of the account's own rendered posts on
   *  its profile page carry a <time> within the last 24h. Bounded by what X
   *  has virtualized into the DOM (~10-20 rows) — a floor, not a total.
   *  Feeds the aifarm 24h-burst lane. */
  recentPosts24h?: number;
  /** The tweet texts above are X machine-translations, not the author's own
   *  words (original unavailable in the DOM). Consumers must not treat the
   *  surface language as an author signal. */
  tweetsTranslated?: boolean;
  /** Viewer ↔ author relationship, read from X's own user object (fiber /
   *  MAIN-world bridge) or the follow button. The edge ignores any account
   *  the viewer already has a relationship with; the client uses
   *  viewerFollowing to feed the local whitelist (settings.followingWhitelist). */
  viewerFollowing?: true;
  viewerBlocking?: true;
  viewerMuting?: true;
  viewerFollowRequestSent?: true;
  viewerIsSelf?: true;
  /** Where on X the article was rendered. The classifier's core boundary —
   *  reply-section advertising bot vs. an account posting on its own
   *  timeline — is undecidable without it. */
  surface?: Surface;
  /** The article is a reply (X's "Replying to @…" line, or a non-focal
   *  article on a /status/ page). */
  isReply?: boolean;
  /** Handle the reply is addressed to, when X shows it. */
  replyToHandle?: string;
  /** Author of the focal (root) tweet on a /status/ page. */
  rootAuthorHandle?: string;
  /** How many EARLIER times this browser saw this exact comment text from
   *  this author (lib/template-memory.ts). Only the count leaves the device. */
  templateRepeats?: number;
}

export type Surface = "home" | "thread" | "profile" | "search" | "notifications" | "other";

/** Background messages. "list-sync" triggers the public blocklist download
 *  (read-only GET of the official artifact; nothing is uploaded). */
export type BgRequest =
  | { type: "local-data"; mutation: LocalDataMutation }
  | { type: "health" }
  | { type: "stats" }
  | { type: "records" }
  | { type: "list-sync"; force?: boolean }
  // GitHub Device Flow (whitelist self-service login). Runs in the
  // background: github.com's device endpoints don't serve CORS, so the
  // fetches need the optional github.com host permission granted first.
  | { type: "gh_start" }
  | { type: "gh_poll"; deviceCode: string }
  // The content script only receives a boolean; the GitHub token stays in
  // extension-local storage and is read by the background worker.
  | { type: "auth_status" }
  // Content script asks the background to open the options page (e.g. a report
  // needs GitHub authorization the user hasn't granted yet).
  | { type: "open_options" }
  // GitHub-authenticated online AI detection for accounts that missed the
  // local public list, persistent verdict cache, and local keyword rules.
  | { type: "classify"; sig: Signals }
  // Official-rule hit telemetry (anonymous; see lib/rule-telemetry.ts). The
  // content script only forwards the hit — queueing/dedup/flush live in the
  // background so one spam wave never turns into a request storm.
  | { type: "rule-hit"; hit: { pattern: string; handle: string; xUserId?: string; category?: string } }
  // 举报: the authenticated POST to /v1/report MUST run in the background —
  // a content-script fetch is bound by x.com's CORS/CSP, whereas the SW shares
  // the extension origin the whitelist-apply flow already reports from.
  | { type: "report"; sig: Signals; category?: SpamCategory }
  // 黑名单一键拉黑 (二开, lib/block-queue.ts): the options page starts a
  // bounded, strictly-paced run; the background owns the persisted queue and
  // dispatches one item at a time to an open x.com tab's content script.
  | { type: "block_queue_start"; limit: number }
  | { type: "block_queue_stop" }
  | { type: "block_queue_pause"; paused: boolean }
  | { type: "block_queue_status" }
  // An x.com content script announces itself as the executor tab on load.
  | { type: "block_queue_hello" }
  // X 原生拉黑列表同步 (二开, lib/blocks-sync.ts): manual paged pull of the
  // user's own blocks via an open x.com tab, relayed by the background.
  | { type: "blocks_sync_start" }
  | { type: "blocks_sync_status" }
  // 误操作恢复：options 页发起，经 background 中继到 x.com 执行器 tab
  // 调用 blocks/destroy（同一套限速队列）。
  | { type: "x_unblock_exec"; u: string; h: string }
  // 福利鉴博主同步 + 一键关注 (二开, lib/flj-sync.ts)：榜单从 flj.info 拉
  // （公开 JSON，无需登录，仅存本机）；关注队列与一键拉黑同一套基建，
  // 用户显式点「开始关注」才跑。
  | { type: "flj_sync_start" }
  | { type: "flj_status" }
  | { type: "follow_queue_start"; max: number; skipNegative?: boolean }
  | { type: "follow_queue_stop" }
  | { type: "follow_queue_status" }
  // x.com 执行器收到的一个关注目标（后台泵逐个派发）。
  | { type: "follow_queue_exec"; item: { h: string; n?: string } };

export interface BgResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** flj_sync_start：同步是否已在进行中（幂等启动）。 */
  syncing?: boolean;
}
