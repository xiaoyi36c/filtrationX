// flj.info（福利鉴）博主榜同步 + 一键关注队列状态（二开）。
//
// 数据源：https://flj.info/api/rankings?category=comments&page=N（GET，公开
// JSON，无需登录）。响应：{ items, total, page, pageSize }，每页 50 条。
// 条目核心字段：twitter_username / display_name / avatar_url / score /
// is_fushi（风俗业者）/ has_threshold（门槛费）/ is_welfare /
// negative_tags（stolen_photo、fake_gender、scam…）/ positive_tags
// （verified_real、recommended…）/ score_detail.{followers,engagement,bio}。
//
// 隐私：名单只存本机（chrome.storage.local）；关注动作走用户自己的 X 登录态
// （lib/x-action.ts 的 follow），flj.info 拿到的只有它自己的 API 请求。
//
// 关注队列（follow queue）：与一键拉黑同一套基建——后台泵 + 打开的 x.com
// 标签页执行 + 持久化进度 + 连续失败熔断。不同点：用户显式点了「开始关注」
// 才跑（绝不后台自动关注），每个目标之间 2-3 秒。

export interface FljBlogger {
  /** twitter_username，小写。 */
  h: string;
  /** display_name。 */
  n?: string;
  score?: number;
  /** 风俗业者。 */
  fushi?: boolean;
  /** 有门槛费。 */
  threshold?: boolean;
  /** 福利博主（score_detail.is_welfare）。 */
  welfare?: boolean;
  /** 已实名/可信（positive_tags 含 verified_real）。 */
  verifiedReal?: boolean;
  /** 负面标签：stolen_photo、fake_gender、scam… */
  neg: string[];
  /** 正面标签。 */
  pos: string[];
  /** 互动级别：high / medium / low。 */
  engagement?: string;
  followers?: number;
  avatar?: string;
}

export interface FljData {
  syncedAt: number | null;
  total: number;
  bloggers: FljBlogger[];
}

export const FLJ_KEY = "xss:flj:v1";
export const FLJ_ORIGIN = "https://flj.info";
export const FLJ_HOST_PATTERN = "https://flj.info/*";
const FLJ_PAGE_DELAY_MS = 700;
const FLJ_PAGE_JITTER_MS = 500;
/** 榜单同步的页数上限（141 条 = 3 页；留足余量，防 total 突增失控）。 */
const FLJ_MAX_PAGES = 20;

export function emptyFljData(): FljData {
  return { syncedAt: null, total: 0, bloggers: [] };
}

/** 容错解析一份 rankings 响应：坏行跳过，缺字段的账号跳过。纯函数，可测。 */
export function parseRankingsPayload(payload: unknown): {
  bloggers: FljBlogger[];
  total: number;
  page: number;
  pageSize: number;
} {
  const out: FljBlogger[] = [];
  let total = 0;
  let page = 1;
  let pageSize = 50;
  if (payload && typeof payload === "object" && Array.isArray((payload as { items?: unknown }).items)) {
    const box = payload as {
      items: unknown[];
      total?: unknown;
      page?: unknown;
      pageSize?: unknown;
    };
    total = typeof box.total === "number" ? box.total : 0;
    page = typeof box.page === "number" ? box.page : 1;
    pageSize = typeof box.pageSize === "number" ? box.pageSize : 50;
    for (const raw of box.items) {
      if (!raw || typeof raw !== "object") continue;
      const it = raw as Record<string, unknown>;
      const h = typeof it.twitter_username === "string" ? it.twitter_username.trim().toLowerCase() : "";
      if (!h || !/^[A-Za-z0-9_]{1,15}$/.test(h)) continue;
      const detail = (it.score_detail ?? {}) as Record<string, unknown>;
      const neg = Array.isArray(it.negative_tags)
        ? (it.negative_tags as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      const pos = Array.isArray(it.positive_tags)
        ? (it.positive_tags as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      out.push({
        h,
        ...(typeof it.display_name === "string" && it.display_name ? { n: it.display_name } : {}),
        ...(typeof it.score === "number" ? { score: it.score } : {}),
        ...(it.is_fushi === true ? { fushi: true } : {}),
        ...(it.has_threshold === true ? { threshold: true } : {}),
        ...(it.is_welfare === true || detail.is_welfare === true ? { welfare: true } : {}),
        ...(pos.includes("verified_real") ? { verifiedReal: true } : {}),
        neg,
        pos,
        ...(typeof detail.engagement === "string" ? { engagement: detail.engagement } : {}),
        ...(typeof detail.followers === "number" ? { followers: detail.followers } : {}),
        ...(typeof it.avatar_url === "string" && it.avatar_url ? { avatar: it.avatar_url } : {}),
      });
    }
  }
  return { bloggers: out, total, page, pageSize };
}

/** 从榜单构建关注队列：默认跳过有负面标签（scam/stolen_photo/fake_gender）
 *  的账号——关注之前先别被骗。纯函数，可测。 */
export function buildFollowQueue(
  bloggers: FljBlogger[],
  opts: { skipNegative: boolean; max: number },
): FljBlogger[] {
  const queue = bloggers.filter((b) => !(opts.skipNegative && b.neg.length > 0));
  return queue.slice(0, Math.max(0, opts.max));
}

export async function getFljData(): Promise<FljData> {
  try {
    const got = await chrome.storage.local.get(FLJ_KEY);
    const v = got[FLJ_KEY] as Partial<FljData> | undefined;
    if (!v || !Array.isArray(v.bloggers)) return emptyFljData();
    return { syncedAt: v.syncedAt ?? null, total: v.total ?? v.bloggers.length, bloggers: v.bloggers };
  } catch {
    return emptyFljData();
  }
}

export async function saveFljData(d: FljData): Promise<void> {
  await chrome.storage.local.set({ [FLJ_KEY]: d });
}

/** 后台用：拉取榜单全部分页（顺序、带间隔），失败页跳过并继续。 */
export async function fetchFljRankings(
  category = "comments",
  log = (_: string) => {},
): Promise<{ bloggers: FljBlogger[]; total: number; pages: number; errors: string[] }> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const bloggers: FljBlogger[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  let total = 0;
  let pages = 0;
  for (let page = 1; page <= FLJ_MAX_PAGES; page++) {
    let payload: unknown = null;
    try {
      const r = await fetch(`${FLJ_ORIGIN}/api/rankings?category=${encodeURIComponent(category)}&page=${page}`, {
        headers: { accept: "application/json" },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      payload = await r.json();
    } catch (e) {
      errors.push(`第 ${page} 页拉取失败：${e instanceof Error ? e.message : String(e)}`);
      if (page === 1) break; // 第一页就失败 = 站点不可用，别空转
      break;
    }
    const { bloggers: pageItems, total: t, pageSize } = parseRankingsPayload(payload);
    total = t || total;
    pages = page;
    for (const b of pageItems) {
      if (seen.has(b.h)) continue;
      seen.add(b.h);
      bloggers.push(b);
    }
    log(`第 ${page} 页：+${pageItems.length}（累计 ${bloggers.length}/${total}）`);
    if (page * pageSize >= total || pageItems.length === 0) break;
    await sleep(FLJ_PAGE_DELAY_MS + Math.floor(Math.random() * FLJ_PAGE_JITTER_MS));
  }
  return { bloggers, total, pages, errors };
}

// ---- 关注队列状态 ----

export interface FollowQueueState {
  items: { h: string; n?: string }[];
  cursor: number;
  done: number;
  failed: number;
  running: boolean;
  lastError: string | null;
  finishedAt: number | null;
}

export const FOLLOW_QUEUE_KEY = "xss:follow-queue:v1";

export function emptyFollowQueue(): FollowQueueState {
  return { items: [], cursor: 0, done: 0, failed: 0, running: false, lastError: null, finishedAt: null };
}

export async function getFollowQueue(): Promise<FollowQueueState> {
  try {
    const got = await chrome.storage.local.get(FOLLOW_QUEUE_KEY);
    const v = got[FOLLOW_QUEUE_KEY] as Partial<FollowQueueState> | undefined;
    if (!v || !Array.isArray(v.items)) return emptyFollowQueue();
    return { ...emptyFollowQueue(), ...v };
  } catch {
    return emptyFollowQueue();
  }
}

export async function saveFollowQueue(s: FollowQueueState): Promise<void> {
  await chrome.storage.local.set({ [FOLLOW_QUEUE_KEY]: s });
}
