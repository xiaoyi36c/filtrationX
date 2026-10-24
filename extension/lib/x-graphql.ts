// UserTweets GraphQL 读封装 (二开, 上游计划目标 02 · M3)。
//
// 这是 P2 唯一动 X 登录会话配额的部分，因此所有防线全部拉满：
//
//   - 设置页开关默认关（settings.kolGraphqlEnabled），用户显式打开才生效；
//   - hover-intent 已触发、卡片已显示之后才按需拉一次（不批量扫）；
//   - lib/read-limiter.ts 全局串行 + 400ms 最小间隔 + 429 冷却 10 分钟；
//   - 结果缓存 3 天（storage），命中缓存完全不发请求；
//   - 查询 ID 失效（X 轮换 queryId）→ 本会话静默禁用，刷新页面重试。
//
// 抓最近 20 条后计算：单条互动中位数（赞/转/评）vs 粉丝数（真「交互
// 质量」，刷不动），以及官方 retweeted 标记的精确原创比。

import { HttpError, ReadLimiter } from "./read-limiter";
import { X_PUBLIC_BEARER } from "./x-action";

const STORE_KEY = "xss:kol:gql:v1";
const DAY = 86_400_000;
const TTL = 3 * DAY;
export const TWEETS_TO_FETCH = 20;

// X 会轮换 queryId；失效时响应为 400（Bad GraphQL query），本会话禁用。
const QUERY_ID = "V7H0Ap8H4_kVPHuPHslKQg";

const FEATURES: Record<string, boolean> = {
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: false,
  rweb_video_timestamps_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_screen_enabled: false,
};

/** 全模块共享一个限速器：跨账号也串行。 */
export const readLimiter = new ReadLimiter(400, 600_000);

export interface PreciseMetrics {
  /** 实际解析到的推文条数（<=20）。 */
  tweets: number;
  medianLikes: number;
  medianReplies: number;
  medianRts: number;
  /** 精确原创比（官方 retweeted 标记，0-1）。 */
  originalRatio: number;
  ts: number;
}

interface PreciseEntry extends PreciseMetrics {
  userId: string;
  handle: string;
}

// ---- 纯函数（测试覆盖）----

export interface RawTweetRow {
  likes: number;
  replies: number;
  rts: number;
  isRetweet: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: X 的 GraphQL 响应结构深且多变
type GqlNode = any;

/** 从 UserTweets 响应里抽出每条推文的互动计数。容错：任何结构变化都
 *  返回已收集的部分（调用方按 no_data 处理），绝不抛出。 */
export function parseUserTweets(json: unknown): RawTweetRow[] {
  const rows: RawTweetRow[] = [];
  const push = (res: GqlNode) => {
    const tweet =
      res && res.__typename === "TweetWithVisibilityResults" ? res.tweet : res;
    const legacy = tweet?.legacy;
    if (!legacy) return;
    rows.push({
      likes: typeof legacy.favorite_count === "number" ? legacy.favorite_count : 0,
      replies: typeof legacy.reply_count === "number" ? legacy.reply_count : 0,
      rts: typeof legacy.retweet_count === "number" ? legacy.retweet_count : 0,
      isRetweet: !!legacy.retweeted_status_result,
    });
  };
  try {
    const j = json as GqlNode;
    const result = j?.data?.user?.result;
    const instructions =
      result?.timeline_v2?.timeline?.instructions ?? result?.timeline?.timeline?.instructions;
    if (!Array.isArray(instructions)) return rows;
    for (const ins of instructions) {
      if (ins?.type !== "TimelineAddEntries") continue;
      for (const entry of ins.entries ?? []) {
        const id: string = typeof entry?.entryId === "string" ? entry.entryId : "";
        if (id.startsWith("tweet-")) {
          push(entry?.content?.itemContent?.tweet_results?.result);
        } else if (id.startsWith("profile-conversation-")) {
          for (const it of entry?.content?.items ?? []) {
            push(it?.item?.itemContent?.tweet_results?.result);
          }
        }
      }
    }
  } catch {
    /* 结构变化 → 已收集的部分照常返回 */
  }
  return rows;
}

function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[m] ?? 0)
    : Math.round(((sorted[m - 1] ?? 0) + (sorted[m] ?? 0)) / 2);
}

/** 中位数 + 精确原创比。空数组返回 null（no_data）。 */
export function computeMetrics(rows: RawTweetRow[]): PreciseMetrics | null {
  if (!rows.length) return null;
  const med = (xs: number[]) => median([...xs].sort((a, b) => a - b));
  const originals = rows.filter((r) => !r.isRetweet).length;
  return {
    tweets: rows.length,
    medianLikes: med(rows.map((r) => r.likes)),
    medianReplies: med(rows.map((r) => r.replies)),
    medianRts: med(rows.map((r) => r.rts)),
    originalRatio: originals / rows.length,
    ts: Date.now(),
  };
}
// ---- 缓存（storage，TTL 3 天，key=userId）----

const cacheKeyOf = (userId: string) => `${STORE_KEY}:${userId}`;

export async function getCachedPrecise(userId: string): Promise<PreciseMetrics | null> {
  if (!userId) return null;
  try {
    const k = cacheKeyOf(userId);
    const got = await chrome.storage.local.get(k);
    const e = got[k] as PreciseEntry | undefined;
    if (!e) return null;
    if (Date.now() - e.ts > TTL) {
      void chrome.storage.local.remove(k);
      return null;
    }
    const { userId: _u, handle: _h, ...metrics } = e;
    return metrics;
  } catch {
    return null;
  }
}

async function setCachedPrecise(userId: string, handle: string, m: PreciseMetrics): Promise<void> {
  try {
    await chrome.storage.local.set({
      [cacheKeyOf(userId)]: { ...m, userId, handle } satisfies PreciseEntry,
    });
  } catch {
    /* non-fatal */
  }
}

/** 清空精确缓存（设置页「清空采样」一并调用）。 */
export async function clearPreciseCache(): Promise<void> {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all as Record<string, unknown>).filter((k) =>
      k.startsWith(`${STORE_KEY}:`),
    );
    if (keys.length) await chrome.storage.local.remove(keys);
  } catch {
    /* non-fatal */
  }
}

// ---- 网络层 ----

// 查询 ID 失效 → 本会话禁用（刷新页面重试），避免每 hover 白打一发 400。
let unsupportedThisSession = false;

export type PreciseResult =
  | { ok: true; metrics: PreciseMetrics }
  | {
      ok: false;
      error:
        | "no_ct0"
        | "rate_limited"
        | "unsupported"
        | "no_data"
        | `http_${number}`
        | "network";
    };

export async function fetchPreciseMetrics(
  userId: string,
  handle: string,
): Promise<PreciseResult> {
  if (unsupportedThisSession) return { ok: false, error: "unsupported" };
  const ct0 = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)?.[1] ?? "";
  if (!ct0) return { ok: false, error: "no_ct0" };
  if (readLimiter.cooling) return { ok: false, error: "rate_limited" };
  const variables = encodeURIComponent(
    JSON.stringify({
      userId,
      count: TWEETS_TO_FETCH,
      includePromotedContent: false,
      withQuickPromoteEligibilityTweetFields: false,
    }),
  );
  const features = encodeURIComponent(JSON.stringify(FEATURES));
  const url = `https://x.com/i/api/graphql/${QUERY_ID}/UserTweets?variables=${variables}&features=${features}`;
  try {
    return await readLimiter.run(async () => {
      const resp = await fetch(url, {
        headers: {
          authorization: X_PUBLIC_BEARER,
          "x-csrf-token": ct0,
          "x-twitter-auth-type": "OAuth2Session",
          "x-twitter-active-user": "yes",
          accept: "application/json",
        },
        credentials: "include",
      });
      if (resp.status === 429) throw new HttpError(429, "rate limited");
      if (resp.status === 400 || resp.status === 404) {
        // queryId 失效或 features 校验不过 → 本会话禁用。
        unsupportedThisSession = true;
        throw new HttpError(resp.status, "unsupported query");
      }
      if (!resp.ok) throw new HttpError(resp.status, `http ${resp.status}`);
      const metrics = computeMetrics(parseUserTweets(await resp.json()));
      if (!metrics) return { ok: false, error: "no_data" } as PreciseResult;
      await setCachedPrecise(userId, handle, metrics);
      return { ok: true, metrics } as PreciseResult;
    });
  } catch (e) {
    if (e instanceof HttpError) {
      return { ok: false, error: `http_${e.status}` as const };
    }
    return { ok: false, error: "network" as const };
  }
}
