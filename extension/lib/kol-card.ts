// KOL 浮卡 (二开, 上游计划目标 02 · M2)。
//
// 悬停在 @handle 上 → 浮卡展示账号可信度信号：账号年龄、粉丝/关注/推文
// 规模、互动效率（赞粉比、均赞/推）、认证与白名单标识，以及 M2 的采样
// 结论：原创比、主题集中度和综合可信分（四档着色）。
//
// 档案数据全部来自 X 自己已经加载进页面的内容（fiber → data-mxga-u 桥，
// 见 lib/x-user-bridge.ts），采样结论来自 lib/kol-signals.ts 的本地累积，
// 零网络请求。M3（可选 GraphQL 精确指标）仍未做。
//
// UI 骨架照搬 lib/ui.ts 的 popover：顶层单例 overlay（躲开 transformed
// 祖先的 fixed 定位问题）、视口翻转定位、rAF 跟随、120ms 延迟隐藏 +
// 卡片悬停保活、CSS 变量主题（明暗 + X 三主题）。

import { MIN_TWEETS_FOR_RATIO, type TrustResult } from "./kol-signals";
import type { PreciseMetrics } from "./x-graphql";
import { closeActiveBadgePopover, detectXTheme } from "./ui";

export interface KolCardData {
  handle: string;
  displayName?: string;
  verified?: boolean;
  accountAgeDays?: number;
  accountCreatedAt?: string;
  followersCount?: number;
  followingCount?: number;
  statusesCount?: number;
  favouritesCount?: number;
  whitelisted?: boolean;
  /** M2: sampled original-tweet ratio (0-1). */
  originalRatio?: number;
  /** M2: sampled tweet count behind originalRatio. */
  sampledTweets?: number;
  /** M2: topic concentration (0-1, higher = narrower). */
  topicFocus?: number;
  /** M2: 综合可信分（lib/kol-signals.ts trustAssessment）。 */
  trust?: TrustResult;
  /** M3: GraphQL 精确互动中位数（可选开关，缓存 3 天）。 */
  precise?: PreciseMetrics;
  viewerFollowing?: boolean;
}

const THEME = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui,-apple-system,"Segoe UI",sans-serif; }
:host {
  --surface: rgba(13,17,23,.94); --border: rgba(255,255,255,.10);
  --shadow: 0 8px 28px rgba(0,0,0,.45); --text: #E6EDF3; --muted: #8B949E;
  --brand: #0EA5E9; --danger: #EF4444; --warn: #F59E0B; --safe: #16A34A;
}
@media (prefers-color-scheme: light) {
  :host {
    --surface: rgba(255,255,255,.97); --border: rgba(15,23,42,.12);
    --shadow: 0 8px 28px rgba(15,23,42,.18); --text: #0F172A; --muted: #475569;
    --brand: #0369A1; --danger: #DC2626; --warn: #B45309; --safe: #15803D;
  }
}
:host([data-xss-theme="dark"]) {
  --surface: rgba(13,17,23,.94); --border: rgba(255,255,255,.10);
  --shadow: 0 8px 28px rgba(0,0,0,.45); --text: #E6EDF3; --muted: #8B949E;
  --brand: #0EA5E9; --danger: #EF4444; --warn: #F59E0B; --safe: #16A34A;
}
:host([data-xss-theme="light"]) {
  --surface: rgba(255,255,255,.97); --border: rgba(15,23,42,.12);
  --shadow: 0 8px 28px rgba(15,23,42,.18); --text: #0F172A; --muted: #475569;
  --brand: #0369A1; --danger: #DC2626; --warn: #B45309; --safe: #15803D;
}
.kolpop {
  position: fixed; z-index: 2147483001; width: 300px;
  background: var(--surface); border: 1px solid var(--border);
  border-left: 3px solid var(--accent, var(--muted));
  border-radius: 12px; box-shadow: var(--shadow);
  color: var(--text); -webkit-font-smoothing: antialiased;
  padding: 10px 12px; font-size: 12.5px; line-height: 1.45;
}
.kol-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.kol-name { font-weight: 600; font-size: 13.5px; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kol-name .h { color: var(--muted); font-weight: 400; }
.kol-flag { flex: none; font-size: 10.5px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid currentColor; }
.kol-flag.wl { color: var(--safe); }
.kol-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px 10px; }
.kv { min-width: 0; }
.kv .k { display: block; color: var(--muted); font-size: 11px; }
.kv b { font-size: 13px; font-variant-numeric: tabular-nums; }
.kv .s { display: block; color: var(--muted); font-size: 10.5px; }
.kv .na { color: var(--muted); font-weight: 400; }
.kol-rows { margin-top: 8px; }
.kol-row { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; }
.kol-row .k { color: var(--muted); }
.kol-foot { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--border);
  color: var(--muted); font-size: 10.5px; display: flex; justify-content: space-between; }
.kol-foot a { color: var(--brand); text-decoration: none; }
`;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- i18n (M4)：卡片语言跟随 X 的 UI 语言（<html lang>），默认中文 ----

type KolLocale = "zh" | "en" | "ja";

function detectKolLocale(): KolLocale {
  const lang = (document.documentElement.lang || "").toLowerCase();
  if (lang.startsWith("zh")) return "zh";
  if (lang.startsWith("ja")) return "ja";
  return "en";
}

interface KolStrings {
  age: string;
  followers: string;
  following: string;
  posts: string;
  likeRatio: string;
  perPost: string;
  trust: string;
  original: string;
  focus: string;
  whitelist: string;
  registered: string;
  viewProfile: string;
  /** M3：精确互动中位数行。 */
  median: string;
  likes: string;
  rts: string;
  replies: string;
  preciseN: (n: number) => string;
  tiers: Record<TrustResult["tier"], string>;
  /** 可信分四个子维度的短标签（分项透明度）。 */
  parts: { age: string; network: string; engagement: string; original: string };
  footer: string;
  sampledN: (n: number) => string;
  offline: string;
  coldStart: (a: number, b: number) => string;
  sampled: (n: number) => string;
}

const I18N: Record<KolLocale, KolStrings> = {
  zh: {
    age: "账号年龄",
    followers: "粉丝",
    following: "关注",
    posts: "推文",
    likeRatio: "赞粉比",
    perPost: "均赞/推",
    trust: "综合可信",
    original: "原创比",
    focus: "主题集中度",
    whitelist: "白名单",
    registered: "注册",
    viewProfile: "查看主页 ↗",
    median: "互动中位数",
    likes: "赞",
    rts: "转",
    replies: "评",
    preciseN: (n) => `（精确 ${n} 条）`,
    tiers: { safe: "靠谱", ok: "一般", warn: "存疑", risk: "高风险" },
    parts: { age: "年龄", network: "关注网", engagement: "互动", original: "原创" },
    footer: "档案实时",
    sampledN: (n) => ` + 采样${n}条`,
    offline: "不联网",
    coldStart: (a, b) => `采样不足 ${a}/${b} 条 · 浏览中累积`,
    sampled: (n) => `（采样 ${n} 条）`,
  },
  en: {
    age: "Age",
    followers: "Followers",
    following: "Following",
    posts: "Posts",
    likeRatio: "Likes/Fol.",
    perPost: "Likes/Post",
    trust: "Trust",
    original: "Original",
    focus: "Topic focus",
    whitelist: "Whitelist",
    registered: "joined",
    viewProfile: "View profile ↗",
    median: "Median engagement",
    likes: "L",
    rts: "RT",
    replies: "R",
    preciseN: (n) => ` (${n} precise)`,
    tiers: { safe: "solid", ok: "mixed", warn: "shaky", risk: "risky" },
    parts: { age: "age", network: "graph", engagement: "engage", original: "orig." },
    footer: "live profile",
    sampledN: (n) => ` + ${n} sampled`,
    offline: "offline",
    coldStart: (a, b) => `only ${a}/${b} sampled · builds as you browse`,
    sampled: (n) => ` (${n} sampled)`,
  },
  ja: {
    age: "アカウント年齢",
    followers: "フォロワー",
    following: "フォロー中",
    posts: "投稿",
    likeRatio: "いいね/フォロ",
    perPost: "いいね/投稿",
    trust: "総合信頼",
    original: "オリジナル率",
    focus: "話題集中度",
    whitelist: "ホワイトリスト",
    registered: "登録",
    viewProfile: "プロフィール ↗",
    median: "反応中央値",
    likes: "いいね",
    rts: "RT",
    replies: "返信",
    preciseN: (n) => `（${n}件精確）`,
    tiers: { safe: "信頼", ok: "普通", warn: "要注意", risk: "リスク" },
    parts: { age: "年齢", network: "関係", engagement: "反応", original: "オリ" },
    footer: "プロフ即時",
    sampledN: (n) => ` + ${n}サンプル`,
    offline: "通信なし",
    coldStart: (a, b) => `サンプル不足 ${a}/${b} · 閲覧中に蓄積`,
    sampled: (n) => `（${n}件サンプル）`,
  },
};

/** 12,345 → zh/ja "1.2万" style, en "12.3K" style. Locale follows X's UI. */
function fmtCount(n: number | undefined, loc: KolLocale): string | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  const trim = (s: string) => s.replace(/\.0$/, "");
  if (loc === "en") {
    if (n >= 1e6) return `${trim((n / 1e6).toFixed(1))}M`;
    if (n >= 1e3) return `${trim((n / 1e3).toFixed(1))}K`;
    return n.toLocaleString("en-US");
  }
  if (n >= 1e8) return `${trim((n / 1e8).toFixed(1))}亿`;
  if (n >= 1e4) return `${trim((n / 1e4).toFixed(1))}万`;
  return n.toLocaleString("zh-CN");
}

function fmtAge(days: number | undefined, loc: KolLocale): { main: string; since: string | null } | null {
  if (typeof days !== "number" || !Number.isFinite(days) || days < 0) return null;
  let main: string;
  if (loc === "en") {
    if (days < 60) main = `${days}d`;
    else if (days < 365) main = `${Math.round(days / 30)}mo`;
    else main = `${(days / 365).toFixed(1).replace(/\.0$/, "")}y`;
  } else if (loc === "ja") {
    if (days < 60) main = `${days} 日`;
    else if (days < 365) main = `${Math.round(days / 30)} ヶ月`;
    else main = `${(days / 365).toFixed(1).replace(/\.0$/, "")} 年`;
  } else {
    if (days < 60) main = `${days} 天`;
    else if (days < 365) main = `${Math.round(days / 30)} 个月`;
    else main = `${(days / 365).toFixed(1).replace(/\.0$/, "")} 年`;
  }
  return { main, since: null };
}

function fmtRatio(n: number | undefined, digits = 2): string | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return n.toFixed(digits);
}

let host: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;
let pop: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let raf = 0;
let anchor: HTMLElement | null = null;

function root(): ShadowRoot {
  if (shadow?.host.isConnected) return shadow;
  host = document.createElement("div");
  host.setAttribute("data-xss-kol", "");
  host.setAttribute("data-xss-theme", detectXTheme());
  host.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483001;";
  document.documentElement.appendChild(host);
  shadow = host.attachShadow({ mode: "open" });
  const st = document.createElement("style");
  st.textContent = THEME;
  shadow.appendChild(st);
  return shadow;
}

function close(): void {
  clearTimeout(hideTimer);
  cancelAnimationFrame(raf);
  pop?.remove();
  pop = null;
  anchor = null;
  window.removeEventListener("scroll", onScroll, true);
  document.removeEventListener("pointerdown", onOutsidePointerDown, true);
}

function onScroll(): void {
  close();
}

function onOutsidePointerDown(event: PointerEvent): void {
  if (!pop) return;
  const path = event.composedPath();
  if ((anchor && path.includes(anchor)) || path.includes(pop)) return;
  hide(true);
}

function hide(force = false): void {
  if (!force && pop?.matches(":hover")) {
    scheduleHide();
    return;
  }
  close();
}

function scheduleHide(): void {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => hide(), 120);
}

function render(data: KolCardData): string {
  const loc = detectKolLocale();
  const t = I18N[loc];
  const name = data.displayName?.trim();
  const age = fmtAge(data.accountAgeDays, loc);
  const since =
    data.accountCreatedAt && !Number.isNaN(Date.parse(data.accountCreatedAt))
      ? (() => {
          const d = new Date(data.accountCreatedAt);
          return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")} ${t.registered}`;
        })()
      : null;
  const followers = fmtCount(data.followersCount, loc);
  const following = fmtCount(data.followingCount, loc);
  const statuses = fmtCount(data.statusesCount, loc);
  const favRatio =
    typeof data.favouritesCount === "number" && typeof data.followersCount === "number" && data.followersCount > 0
      ? fmtRatio(data.favouritesCount / data.followersCount)
      : null;
  const perTweet =
    typeof data.favouritesCount === "number" && typeof data.statusesCount === "number" && data.statusesCount > 0
      ? fmtRatio(data.favouritesCount / data.statusesCount, 1)
      : null;
  const na = `<b class="na">—</b>`;
  const kv = (k: string, v: string | null, s?: string | null) =>
    `<div class="kv"><span class="k">${k}</span>${v ? `<b>${v}</b>` : na}${s ? `<span class="s">${s}</span>` : ""}</div>`;
  // M2 采样行：数据未到位就不渲染（冷启动行除外——说明原因比静默好）。
  const TIER_COLOR: Record<TrustResult["tier"], string> = {
    safe: "var(--safe)",
    ok: "var(--brand)",
    warn: "var(--warn)",
    risk: "var(--danger)",
  };
  // 分项透明度：四个子维度分都亮出来，用户能看出综合分从哪来、缺什么。
  const partsLine = data.trust
    ? [
        [t.parts.age, data.trust.parts.age],
        [t.parts.network, data.trust.parts.network],
        [t.parts.engagement, data.trust.parts.engagement],
        [t.parts.original, data.trust.parts.original],
      ]
        .map(([k, v]) => `${k} ${v}`)
        .join(" · ")
    : "";
  const m2rows = [
    data.trust
      ? `<div class="kol-row"><span class="k">${t.trust}</span><span style="color:${TIER_COLOR[data.trust.tier]}"><b>${data.trust.score}</b>/100 · ${t.tiers[data.trust.tier]}</span></div>${partsLine ? `<div class="kol-row"><span class="k"></span><span class="k" style="font-size:10.5px">${partsLine}</span></div>` : ""}`
      : "",
    // M3：精确互动中位数（存在即优先展示——这是刷不动的真值）。
    data.precise
      ? `<div class="kol-row"><span class="k">${t.median}</span><span>${t.likes} ${data.precise.medianLikes} · ${t.rts} ${data.precise.medianRts} · ${t.replies} ${data.precise.medianReplies}<span class="k">${t.preciseN(data.precise.tweets)}</span></span></div>`
      : "",
    typeof data.originalRatio === "number"
      ? `<div class="kol-row"><span class="k">${t.original}</span><span>${(data.originalRatio * 100).toFixed(0)}%<span class="k">${data.precise ? t.preciseN(data.precise.tweets) : t.sampled(data.sampledTweets ?? 0)}</span></span></div>`
      : "",
    typeof data.topicFocus === "number"
      ? `<div class="kol-row"><span class="k">${t.focus}</span><span>${(data.topicFocus * 100).toFixed(0)}%</span></div>`
      : "",
    // 冷启动：采样还没攒够时说明原因，而不是静默少两行让人以为坏了。
    typeof data.originalRatio !== "number" && typeof data.sampledTweets === "number"
      ? `<div class="kol-row"><span class="k">${t.original} · ${t.focus}</span><span class="k">${t.coldStart(data.sampledTweets, MIN_TWEETS_FOR_RATIO)}</span></div>`
      : "",
  ]
    .filter(Boolean)
    .join("");
  return `
  <div class="kol-head">
    <span class="kol-name">${esc(name || `@${data.handle}`)} <span class="h">@${esc(data.handle)}</span>${data.verified ? " ✓" : ""}</span>
    ${data.whitelisted ? `<span class="kol-flag wl">${t.whitelist}</span>` : ""}
  </div>
  <div class="kol-grid">
    ${kv(t.age, age ? age.main : null, age ? since : null)}
    ${kv(t.followers, followers)}
    ${kv(t.following, following)}
    ${kv(t.posts, statuses)}
    ${kv(t.likeRatio, favRatio)}
    ${kv(t.perPost, perTweet)}
  </div>
  ${m2rows ? `<div class="kol-rows">${m2rows}</div>` : ""}
  <div class="kol-foot"><span>filtrationX · ${t.footer}${typeof data.sampledTweets === "number" ? t.sampledN(data.sampledTweets) : ""} · ${t.offline}</span><a href="https://x.com/${encodeURIComponent(data.handle)}" target="_blank" rel="noopener">${t.viewProfile}</a></div>`;
}

/** Show (or move/re-render) the card anchored to `el`. Idempotent per frame. */
export function showKolCard(el: HTMLElement, data: KolCardData): void {
  // 与徽标的「手动处理」菜单互斥：卡一出现就收掉它，两个浮层不再叠罗汉。
  closeActiveBadgePopover();
  const shadowRoot = root();
  if (!pop) {
    pop = document.createElement("div");
    pop.className = "kolpop";
    pop.setAttribute("data-xss-theme", detectXTheme());
    pop.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    pop.addEventListener("mouseleave", scheduleHide);
    shadowRoot.appendChild(pop);
  }
  const TIER_ACCENT: Record<TrustResult["tier"], string> = {
    safe: "var(--safe)",
    ok: "var(--brand)",
    warn: "var(--warn)",
    risk: "var(--danger)",
  };
  pop.style.setProperty(
    "--accent",
    data.whitelisted
      ? "var(--safe)"
      : data.trust
        ? TIER_ACCENT[data.trust.tier]
        : (data.accountAgeDays ?? Infinity) < 30
          ? "var(--warn)"
          : "var(--brand)",
  );
  pop.innerHTML = render(data);
  anchor = el;
  const place = (r: DOMRect) => {
    if (!pop) return;
    const W = pop.offsetWidth || 300;
    const H = pop.offsetHeight || 140;
    // 右侧优先（handle 在行首），放不下翻到左侧；垂直方向上下翻转。
    let left = r.right + 8;
    if (left + W > window.innerWidth - 8) left = r.left - W - 8;
    if (left < 8) left = Math.min(Math.max(8, r.left), window.innerWidth - W - 8);
    let top = r.top;
    if (top + H > window.innerHeight - 8) top = Math.max(8, r.top + r.height - H);
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.top = `${Math.max(8, top)}px`;
  };
  place(el.getBoundingClientRect());
  cancelAnimationFrame(raf);
  const track = () => {
    if (!pop || !anchor) return;
    const r = anchor.getBoundingClientRect();
    if (!anchor.isConnected || (!r.width && !r.height)) {
      close();
      return;
    }
    place(r);
    raf = requestAnimationFrame(track);
  };
  raf = requestAnimationFrame(track);
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  document.addEventListener("pointerdown", onOutsidePointerDown, true);
}

export function hideKolCard(force = false): void {
  hide(force);
}

/** True while the card is actually on screen. The content script's "same row
 *  already open" hover guard consults this — kolHandle alone goes stale the
 *  moment the card closes, which used to block every re-hover of the same
 *  account until a different handle was hovered in between. */
export function kolCardOpen(): boolean {
  return !!pop;
}

export function scheduleHideKolCard(): void {
  scheduleHide();
}
