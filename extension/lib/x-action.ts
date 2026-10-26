// First-party X account actions (mute / block) driven by the user's own
// logged-in session. Used ONLY when the user opts into "X 静音" or "X 拉黑"
// mode (settings.actionMode); the default "local" mode never calls this.
//
// We call X's own legacy v1.1 endpoints — the same ones x.com's web client
// uses — with the page's `ct0` CSRF cookie + the site's public bearer. No
// request ever touches our own backend; nothing is collected. Both endpoints
// are paced through a single global queue (Web Locks, cross-tab) with jitter,
// periodic cooldowns and 429 back-off so bulk cleanup can't hammer X or trip
// its automation heuristics.
//
// Recovered and generalized from the pre-v0.5.0 block implementation.

export type XActionKind = "mute" | "block" | "unblock" | "follow" | "unfollow";

export interface XActionAttempt {
  ok: boolean;
  status?: number;
  retryable?: boolean;
  retryAfterMs?: number;
  /** 账号已失效（被 X 封禁 / 不存在）——一次性失败，标记后永远跳过。 */
  invalid?: boolean;
  /** 已达关注上限（错误码 161）——与账号无关，队列应立即停止。 */
  followLimit?: boolean;
  /** Human-readable failure cause. Diagnostic only — never sent anywhere.
   *  Without this a failed mute/block is completely silent (the caller just
   *  returns false), which makes "auto-block does nothing" undebuggable. */
  reason?: string;
}

// X web's long-standing public bearer (same one the site itself sends).
const FALLBACK_X_BEARER =
  "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
/** Exported for the blocks-list sync (lib/blocks-sync.ts) — same public
 *  credential, GET side. */
export const X_PUBLIC_BEARER = FALLBACK_X_BEARER;

const ENDPOINT: Record<XActionKind, string> = {
  block: "/i/api/1.1/blocks/create.json",
  mute: "/i/api/1.1/mutes/users/create.json",
  // 误操作恢复（二开）：解除拉黑，走同一套限速队列。
  unblock: "/i/api/1.1/blocks/destroy.json",
  // 福利鉴博主一键关注（二开）：与 mute/block 同一套 ct0 限速队列。
  follow: "/i/api/1.1/friendships/create.json",
  unfollow: "/i/api/1.1/friendships/destroy.json",
};

// Pacing — shared across both action kinds (both are write actions against
// the same account-mutation rate budget). 2026-10-25 提速：1200+700 → 800+400
// （应用户要求；阶梯冷却与 429 退避不变，仍是主要的安全阀）。
const ACTION_DELAY_MS = 800;
const ACTION_JITTER_MS = 400;
const SHORT_COOLDOWN_EVERY = 45;
const SHORT_COOLDOWN_MS = 8_000;
const LONG_COOLDOWN_EVERY = 120;
const LONG_COOLDOWN_MS = 60_000;
const RATE_LIMIT_COOLDOWN_MS = 45_000;
const TRANSIENT_COOLDOWN_MS = 8_000;
const LS_LAST_ACTION = "mxga:last-x-action";
const LS_ACTION_ROUND = "mxga:x-action-round";

interface ActionRound {
  count: number;
  cooldownUntil: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Safely stringify a thrown value. Reading `.message` on an object from a
 *  foreign JS compartment can itself throw in Firefox, so guard both the
 *  property read and the String() coercion. */
function errText(e: unknown): string {
  try {
    const m = (e as { message?: unknown } | null)?.message;
    if (typeof m === "string" && m) return m;
    return String(e);
  } catch {
    return "unknown error";
  }
}

function ct0() {
  try {
    return document.cookie.match(/ct0=([^;]+)/)?.[1] ?? "";
  } catch {
    return "";
  }
}

function apiOrigin() {
  return location.hostname.endsWith("twitter.com")
    ? "https://twitter.com"
    : "https://x.com";
}

function normalizeHandle(handle?: string) {
  return String(handle ?? "")
    .trim()
    .replace(/^@+/, "");
}

function storageNumber(key: string) {
  try {
    return Number(localStorage.getItem(key) || 0) || 0;
  } catch {
    return 0;
  }
}

function setStorageNumber(key: string, value: number) {
  try {
    localStorage.setItem(key, String(Math.max(0, Math.floor(value))));
  } catch {
    /* localStorage can be blocked; per-tab pacing still applies */
  }
}

function readRound(): ActionRound {
  try {
    const raw = JSON.parse(
      localStorage.getItem(LS_ACTION_ROUND) || "{}",
    ) as Partial<ActionRound>;
    return {
      count: Math.max(0, Number(raw.count || 0) || 0),
      cooldownUntil: Math.max(0, Number(raw.cooldownUntil || 0) || 0),
    };
  } catch {
    return { count: 0, cooldownUntil: 0 };
  }
}

function writeRound(round: ActionRound) {
  try {
    localStorage.setItem(
      LS_ACTION_ROUND,
      JSON.stringify({
        count: Math.max(0, Number(round.count || 0) || 0),
        cooldownUntil: Math.max(0, Number(round.cooldownUntil || 0) || 0),
      }),
    );
  } catch {
    /* non-fatal */
  }
}

function nextCooldown(count: number) {
  if (count > 0 && count % LONG_COOLDOWN_EVERY === 0) return LONG_COOLDOWN_MS;
  if (count > 0 && count % SHORT_COOLDOWN_EVERY === 0) return SHORT_COOLDOWN_MS;
  return 0;
}

function parseRetryAfterMs(value: string | null) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function recordBackoff(ms: number) {
  if (ms <= 0) return;
  const round = readRound();
  writeRound({
    ...round,
    cooldownUntil: Math.max(round.cooldownUntil, Date.now() + ms),
  });
}

function recordFailure(attempt: XActionAttempt) {
  if (attempt.status === 429) {
    recordBackoff(attempt.retryAfterMs ?? RATE_LIMIT_COOLDOWN_MS);
  } else if (attempt.retryable) {
    recordBackoff(TRANSIENT_COOLDOWN_MS);
  }
}

function recordSuccess() {
  const round = readRound();
  const count = round.count + 1;
  const cooldownMs = nextCooldown(count);
  writeRound({
    count,
    cooldownUntil: cooldownMs ? Date.now() + cooldownMs : 0,
  });
}

async function waitForSlot() {
  while (true) {
    const round = readRound();
    const cooldownRemaining = round.cooldownUntil - Date.now();
    if (cooldownRemaining > 0) {
      await sleep(Math.min(1000, cooldownRemaining));
      continue;
    }
    const lastAt = storageNumber(LS_LAST_ACTION);
    const jitter = Math.floor(Math.random() * ACTION_JITTER_MS);
    const remaining = lastAt + ACTION_DELAY_MS + jitter - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(1000, remaining));
  }
  setStorageNumber(LS_LAST_ACTION, Date.now());
}

// Serialization for X write actions.
//
// We deliberately do NOT use the Web Locks API (navigator.locks). In a Firefox
// content script the LockManager belongs to the page's JS compartment, so
// `locks.request()` returns a FOREIGN-compartment Promise. Every way of
// consuming such a promise — `await`, `.then()`, `.catch()`, and even
// `Promise.resolve()` — has to read its `then` property, which throws:
//     Error: Permission denied to access property "then"
// Promise.resolve() does NOT help: it only short-circuits when the value's
// constructor is the *same* Promise object, which is false across
// compartments. It just converts the synchronous throw into a rejection that
// then surfaces as "[MXGA] 自动拉黑处理异常 … property \"then\"".
//
// A local promise chain gives the same serialization inside this context.
// Cross-tab pacing is already handled by waitForSlot(), which coordinates
// through localStorage timestamps.
let mutexChain: Promise<unknown> = Promise.resolve();

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutexChain.then(fn, fn);
  // Keep the chain alive across failures (otherwise one rejection would poison
  // every later action); the caller still sees `run`'s own rejection.
  mutexChain = run.catch(() => {});
  return run;
}

interface XhrResult {
  status: number;
  header(name: string): string | null;
  /** 响应体文本。X 的 4xx 都带 JSON errors[{code,message}]，错误码是区分
   *  「已关注」和「账号封禁/不存在」的唯一途径。 */
  text(): string;
}

/**
 * POST via XMLHttpRequest rather than fetch.
 *
 * fetch() in a Firefox content script can return a Promise created in the
 * page's JS compartment, which cannot be consumed (see withLock above —
 * reading `.then` throws "Permission denied to access property \"then\"").
 * XHR is callback-based, so we construct the Promise ourselves, in OUR
 * compartment, and never touch a foreign one.
 */
function xhrRequest(
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  body: string | null,
  timeoutMs: number,
): Promise<XhrResult> {
  return new Promise<XhrResult>((resolve, reject) => {
    let xhr: XMLHttpRequest;
    try {
      xhr = new XMLHttpRequest();
    } catch (e) {
      reject(e);
      return;
    }
    try {
      xhr.open(method, url, true);
      // Send the x.com session cookies (ct0 among them). Same-origin from the
      // content script's point of view, so no CORS preflight.
      xhr.withCredentials = true;
      xhr.timeout = timeoutMs;
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.onload = () =>
        resolve({
          status: xhr.status,
          header: (name: string) => {
            try {
              return xhr.getResponseHeader(name);
            } catch {
              return null;
            }
          },
          text: () => {
            try {
              return xhr.responseText ?? "";
            } catch {
              return "";
            }
          },
        });
      xhr.onerror = () => reject(new Error("网络错误"));
      xhr.ontimeout = () => reject(new Error(`请求超时（${timeoutMs}ms）`));
      xhr.onabort = () => reject(new Error("请求被中止"));
      if (body != null) xhr.send(body);
      else xhr.send();
    } catch (e) {
      // e.g. the page CSP blocks the request, or open()/send() throws.
      reject(e);
    }
  });
}

function xhrPost(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<XhrResult> {
  return xhrRequest("POST", url, headers, body, timeoutMs);
}

export interface UserLookupResult {
  status: number;
  /** true=存在 false=确认不存在/封禁 null=无法判断（限流/网络等）。 */
  exists: boolean | null;
  /** 查看者是否已在关注该账号（200 响应里带出的关注关系）。 */
  following?: boolean;
  reason?: string;
}

// GraphQL UserByScreenName：X 网页端自己的查询（比 v1.1 users/show 可靠，
// 响应带 legacy.following 关注关系）。queryId 会被 X 轮换——400/404 时本
// 会话禁用 GraphQL，回落 v1.1。
const USER_BY_SCREEN_NAME_QUERY_ID = "xc18f1gVKEgFMZrqI6ciaw";
let gqlLookupDisabled = false;

const GQL_USER_FEATURES: Record<string, boolean> = {
  hidden_profile_subscriptions_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_directive_enabled: false,
};

/** GraphQL UserByScreenName 单次查询。 */
async function gqlUserByScreenName(name: string): Promise<UserLookupResult> {
  const csrf = ct0();
  if (!csrf) return { status: 0, exists: null, reason: "未取到 ct0" };
  const params = new URLSearchParams({
    variables: JSON.stringify({ screen_name: name }),
    features: JSON.stringify(GQL_USER_FEATURES),
    fieldToggles: JSON.stringify({ withAuxiliaryUserLabels: false }),
  });
  const res = await xhrRequest(
    "GET",
    `${apiOrigin()}/i/api/graphql/${USER_BY_SCREEN_NAME_QUERY_ID}/UserByScreenName?${params}`,
    { authorization: FALLBACK_X_BEARER, "x-csrf-token": csrf, accept: "application/json" },
    null,
    15_000,
  );
  // queryId 失效或 features 校验不过 → 本会话禁用 GraphQL。
  if (res.status === 400 || res.status === 404) {
    return { status: res.status, exists: null, reason: "unsupported" };
  }
  if (res.status === 429) return { status: 429, exists: null, reason: "rate limited" };
  if (res.status !== 200) {
    return { status: res.status, exists: null, reason: `HTTP ${res.status}` };
  }
  try {
    const box = JSON.parse(res.text()) as {
      data?: {
        user?: {
          result?: { reason?: string; rest_id?: string; legacy?: { following?: boolean } };
        };
      };
    };
    const result = box.data?.user?.result;
    if (!result) return { status: 200, exists: false, reason: "账号不存在" };
    if (result.reason === "Suspended") {
      return { status: 200, exists: false, reason: "账号已被 X 封禁（Account suspended）" };
    }
    // 受保护账号的关注是「待通过」状态（Pending）：此时 following=false 但
    // follow_request_sent=true——语义上等同已关注（不用再尝试）。
    const followed =
      result.legacy?.following === true || result.legacy?.follow_request_sent === true;
    return {
      status: 200,
      exists: true,
      ...(followed ? { following: true } : {}),
    };
  } catch {
    return { status: 200, exists: null, reason: "响应解析失败" };
  }
}

/**
 * 只读查询账号是否存在（GraphQL UserByScreenName，v1.1 兜底）。
 *
 * 用途：follow 返回 429 时，X 对「不存在账号」和「已在关注列表的重复关注」
 * 都常统一返回 429，状态码无法区分——写队列据此核实。注意 404 的歧义：
 * 端点下线的路由 404 ≠ 账号不存在，只有明确的用户错误码（63/50/108）或
 * GraphQL 的 result 缺失才算「确认不存在」。
 */
export async function lookupUser(handle: string): Promise<UserLookupResult> {
  return withLock(async () => {
    const name = normalizeHandle(handle);
    if (!name || !/^[A-Za-z0-9_]{1,15}$/.test(name)) {
      return { status: 0, exists: false, reason: "handle 非法" };
    }
    if (!gqlLookupDisabled) {
      try {
        const r = await gqlUserByScreenName(name);
        if (r.reason === "unsupported") {
          gqlLookupDisabled = true;
        } else {
          return r;
        }
      } catch {
        /* GraphQL 异常 → 回落 v1.1 */
      }
    }
    const csrf = ct0();
    if (!csrf) return { status: 0, exists: null, reason: "未取到 ct0" };
    try {
      const res = await xhrRequest(
        "GET",
        `${apiOrigin()}/i/api/1.1/users/show.json?screen_name=${encodeURIComponent(name)}`,
        { authorization: FALLBACK_X_BEARER, "x-csrf-token": csrf, accept: "application/json" },
        null,
        15_000,
      );
      if (res.status === 200) {
        // 200 响应体里带查看者的关注关系；受保护账号的待通过请求同样算。
        try {
          const u = JSON.parse(res.text()) as {
            following?: boolean;
            pending_follow_request_sent?: boolean;
          };
          const followed = u.following === true || u.pending_follow_request_sent === true;
          return { status: 200, exists: true, ...(followed ? { following: true } : {}) };
        } catch {
          return { status: 200, exists: true };
        }
      }
      const cls = classifyActionBody(res.status, res.text());
      // 只信明确的用户错误码；路由 404（端点下线）/限流一律「无法判断」。
      if (cls.kind === "invalid" && res.status !== 404) {
        return {
          status: res.status,
          exists: false,
          ...(cls.reason ? { reason: cls.reason } : {}),
        };
      }
      return {
        status: res.status,
        exists: null,
        ...(cls.reason ? { reason: cls.reason } : { reason: `HTTP ${res.status}` }),
      };
    } catch (e) {
      return { status: 0, exists: null, reason: errText(e) };
    }
  });
}

/**
 * 从 X 的错误响应里识别「账号已失效」等终态（纯函数，可测）。
 *
 * 榜单数据混有已被封禁 / 注销的账号——对它们调用 friendships/create 会得到
 * 403/404 + JSON errors[{code,message}]，此前被笼统当成「可能已关注」，导致
 * 失效账号每轮队列都重试一遍、失败计数虚高。错误码含义：
 *   63  = User has been suspended（Account suspended 页）
 *   50  = User not found
 *   108 = Cannot find specified user
 *   161 = 关注数达到上限（跟账号无关，继续跑没有意义）
 * HTTP 404 同样说明账号没了。invalid=true 的账号应被永久记录、跳过；
 * follow-limit=true 时调用方应立即停止队列。
 */
export function classifyActionBody(
  status: number,
  bodyText: string,
): { kind: "invalid" | "follow-limit" | "other"; invalid: boolean; reason?: string } {
  let code: number | null = null;
  let message = "";
  try {
    const box = JSON.parse(bodyText) as { errors?: { code?: unknown; message?: unknown }[] };
    const e0 = Array.isArray(box?.errors) ? box.errors[0] : undefined;
    if (e0 && typeof e0.code === "number") code = e0.code;
    if (e0 && typeof e0.message === "string") message = e0.message;
  } catch {
    /* 响应体不是 JSON（HTML 错误页等）→ 只按状态码判断 */
  }
  // 161 = follow limit reached：跟具体账号无关，剩余队列继续跑必然全败。
  if (code === 161) {
    return {
      kind: "follow-limit",
      invalid: false,
      reason: "已达到 X 的关注上限（改天再试，或先取关一些账号）",
    };
  }
  if (code === 63 || code === 50 || code === 108 || status === 404) {
    return {
      kind: "invalid",
      invalid: true,
      reason:
        code === 63 || /suspend/i.test(message)
          ? "账号已被 X 封禁（Account suspended）"
          : "账号不存在（已注销或从未存在）",
    };
  }
  return { kind: "other", invalid: false };
}

/** Single first-party mute/block call. Returns ok/false + retry hints. */
async function rawAction(
  kind: XActionKind,
  userId?: string,
  handle?: string,
): Promise<XActionAttempt> {
  try {
    const csrf = ct0();
    if (!csrf) {
      return {
        ok: false,
        retryable: false,
        reason: "未取到 ct0（未登录 X，或浏览器阻止了 content script 读取 cookie）",
      };
    }
    const screenName = normalizeHandle(handle);
    const body = new URLSearchParams();
    // Prefer the immutable numeric user_id: handles rename, and a wrongly
    // extracted pseudo-handle 404s silently — the id never lies.
    if (userId && /^\d+$/.test(userId)) body.set("user_id", userId);
    else if (screenName) body.set("screen_name", screenName);
    else
      return {
        ok: false,
        retryable: false,
        reason: "既无合法 user_id 也无 screen_name，无法定位账号",
      };
    let res: XhrResult;
    try {
      res = await xhrPost(
        `${apiOrigin()}${ENDPOINT[kind]}`,
        {
          authorization: FALLBACK_X_BEARER,
          "x-csrf-token": csrf,
          "x-twitter-auth-type": "OAuth2Session",
          "x-twitter-active-user": "yes",
          "content-type": "application/x-www-form-urlencoded",
        },
        body.toString(),
        15_000,
      );
    } catch (e) {
      return { ok: false, retryable: true, reason: `请求异常：${errText(e)}` };
    }
    const status = res.status;
    const ok = status >= 200 && status < 300;
    const cls = classifyActionBody(status, res.text());
    const retryable =
      cls.kind !== "invalid" &&
      (status === 408 || status === 425 || status === 429 || status >= 500);
    return {
      ok,
      status,
      retryAfterMs: parseRetryAfterMs(res.header("retry-after")),
      retryable,
      invalid: cls.invalid,
      followLimit: cls.kind === "follow-limit",
      // 失效账号给出具体原因（封禁/不存在）；其余 403/401 仍是 CSRF/会话类
      // 提示——「可能已关注」的老语义保持不变。
      reason: ok ? undefined : (cls.reason ?? `X 返回 HTTP ${status}`),
    };
  } catch (e) {
    return { ok: false, retryable: true, reason: `请求异常：${errText(e)}` };
  }
}

/** Paced, cross-tab-serialized mute/block. This is the entry point. */
export async function performXAction(
  kind: XActionKind,
  userId?: string,
  handle?: string,
  shouldProceed: () => boolean = () => true,
): Promise<XActionAttempt> {
  return withLock(async () => {
    if (!shouldProceed()) return { ok: false, retryable: false };
    await waitForSlot();
    // Whitelist/settings may change while waiting for a cross-tab slot.
    if (!shouldProceed()) return { ok: false, retryable: false };
    const attempt = await rawAction(kind, userId, handle);
    if (attempt.ok) recordSuccess();
    else recordFailure(attempt);
    return attempt;
  });
}

/** Short delay before a retry, given an attempt's status. 0 = don't retry. */
export function retryDelayForAttempt(attempt: XActionAttempt, tries: number) {
  if (!attempt.retryable) return 0;
  if (attempt.status === 429) {
    return Math.min(60_000, attempt.retryAfterMs ?? RATE_LIMIT_COOLDOWN_MS);
  }
  return Math.min(12_000, 900 * 2 ** Math.max(0, tries - 1));
}
