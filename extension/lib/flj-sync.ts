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
  /** 正面标签（positive_tags + positive_types）。 */
  pos: string[];
  /** 站点给的中文画像标签（score_detail.account_tags：福利博主/可线下…）。 */
  tags?: string[];
  /** 出现在哪些榜单分类（comments/latest/score/fushi/threshold/av）。 */
  cats?: string[];
  /** 互动级别：high / medium / low。 */
  engagement?: string;
  followers?: number;
  avatar?: string;
  /** 数据源已标记封禁（boomboom 的 is_suspended）——不用等关注队列去试，
   *  UI 直接打「✗ 失效」并从待关注里排除。 */
  dead?: boolean;
}

/** 榜单分类（/api/rankings/overview 的 id 集合）及中文名。 */
export const FLJ_CATEGORY_ZH: Record<string, string> = {
  comments: "最新爆料",
  latest: "最新检索",
  score: "评分最高",
  fushi: "风俗",
  threshold: "门槛",
  av: "AV女优",
};
/** overview 拉不到时的兜底分类表。 */
const FLJ_FALLBACK_CATEGORIES = Object.keys(FLJ_CATEGORY_ZH);
/** 额外数据源（与福利鉴分类并列展示）。boomboom = 女菩萨
 *  （nv-pu-sa.pages.dev）的 archive.json 接口。 */
export const FLJ_EXTRA_SOURCES: { id: string; label: string }[] = [
  { id: "boomboom", label: "女菩萨" },
  { id: "nsfw", label: "NSFW 导航" },
];
/** 全部 cats 值的中文名（含福利鉴分类与额外数据源）。 */
export function fljCatLabel(id: string): string {
  return FLJ_CATEGORY_ZH[id] ?? FLJ_EXTRA_SOURCES.find((s) => s.id === id)?.label ?? id;
}

// 三个数据源的标签字段形态不一：福利鉴有英文枚举（positive_tags）+ 中文
// 画像（account_tags）；nsfw.pet 的 tags 混着拼写错误的英文（welfre）和
// 语言码（ja/zh）；boomboom 没有标签。直接透传会把标签列变成英文噪音墙
// ——只显示能翻译或本身是中文的标签，其余视为噪音丢弃。
const FLJ_TAG_ZH: Record<string, string> = {
  verified_real: "实名",
  recommended: "推荐",
  trusted: "可信",
  praised: "好评",
  welfare: "福利",
  welfre: "福利", // nsfw.pet 源数据拼写
  welfere: "福利", // 同上变体
  stolen_photo: "盗图",
  fake_gender: "照骗",
  scam: "诈骗",
};

/** 标签 → 展示文案；返回 null 表示噪音标签，UI 不显示。纯函数，可测。 */
export function fljTagLabel(tag: string): string | null {
  const t = tag.trim();
  if (!t) return null;
  if (FLJ_TAG_ZH[t]) return FLJ_TAG_ZH[t]!;
  // 中文画像标签（福利博主/可线下/AV女優…）原样显示；纯 ASCII 的未知
  // 英文标签（语言码、站点杂项）不显示。
  return /[\u4e00-\u9fff]/.test(t) ? t : null;
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
      // 正面标签：positive_tags（英文枚举）+ positive_types（verified_real/
      // praised/recommended…），合并去重。
      const pos = [
        ...(Array.isArray(it.positive_tags)
          ? (it.positive_tags as unknown[]).filter((x): x is string => typeof x === "string")
          : []),
        ...(Array.isArray(detail.positive_types)
          ? (detail.positive_types as unknown[]).filter((x): x is string => typeof x === "string")
          : []),
      ].filter((x, i, a) => a.indexOf(x) === i);
      // 站点中文画像标签（福利博主/有门槛费/可线下/AV女優…）。
      const tags = Array.isArray(detail.account_tags)
        ? (detail.account_tags as unknown[]).filter((x): x is string => typeof x === "string")
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
        ...(tags.length ? { tags } : {}),
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

/** 两批名单合并：按 handle 去重、字段取并集/最高分，按评分降序输出。纯函数。 */
export function mergeWithExisting(prev: FljBlogger[], cur: FljBlogger[]): FljBlogger[] {
  const byH = new Map<string, FljBlogger>();
  for (const b of [...prev, ...cur]) {
    const x = byH.get(b.h);
    if (x) {
      if (!x.n && b.n) x.n = b.n;
      if ((b.score ?? -1) > (x.score ?? -1)) x.score = b.score;
      if (b.welfare) x.welfare = true;
      if (b.fushi) x.fushi = true;
      if (b.threshold) x.threshold = true;
      if (b.verifiedReal) x.verifiedReal = true;
      if (b.dead) x.dead = true;
      if ((b.followers ?? 0) > (x.followers ?? 0)) x.followers = b.followers;
      x.pos = [...new Set([...x.pos, ...b.pos])];
      x.neg = [...new Set([...x.neg, ...b.neg])];
      x.tags = [...new Set([...(x.tags ?? []), ...(b.tags ?? [])])];
      x.cats = [...new Set([...(x.cats ?? []), ...(b.cats ?? [])])];
      if (!x.avatar && b.avatar) x.avatar = b.avatar;
    } else {
      byH.set(b.h, { ...b });
    }
  }
  return [...byH.values()].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

/** 多分类结果合并：同一账号可出现在多个分类（overview 显示重叠很常见），
 *  按 handle 去重、记录 cats、字段取并集/最高分，按评分降序输出。纯函数。 */
export function mergeCategoryResults(
  results: { category: string; bloggers: FljBlogger[] }[],
): FljBlogger[] {
  const flat: FljBlogger[] = [];
  for (const { category, bloggers } of results) {
    for (const b of bloggers) {
      flat.push({ ...b, cats: [...new Set([...(b.cats ?? []), category])] });
    }
  }
  return mergeWithExisting([], flat);
}

/** 榜单分类总览（/api/rankings/overview）：取全部分类 id；失败用兜底表。 */
export async function fetchFljOverview(): Promise<{ id: string }[]> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const r = await fetch(`${FLJ_ORIGIN}/api/rankings/overview`, {
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const arr = (await r.json()) as unknown;
    if (Array.isArray(arr)) {
      const ids = arr
        .map((x) => (x && typeof x === "object" ? (x as { id?: unknown }).id : null))
        .filter((x): x is string => typeof x === "string");
      if (ids.length) return ids.map((id) => ({ id }));
    }
  } catch {
    // fall through to fallback
  }
  return FLJ_FALLBACK_CATEGORIES.map((id) => ({ id }));
}

/** 同步进度（UI 实时展示用）：phase=overview 拉分类表；categories 逐个拉
 *  全；snapshot 为目前已合并的去重名单（后台据此增量落库）。 */
export interface FljSyncProgress {
  phase: "overview" | "categories" | "done" | "error";
  done: number;
  totalCats: number;
  category: string | null;
  unique: number;
  snapshot: FljBlogger[];
}

/** 单个数据源的同步结果（UI 逐源显示成功条数 / 失败原因）。 */
export interface FljSourceResult {
  id: string;
  ok: boolean;
  count: number;
  error?: string;
}

/** 同步源勾选（UI 三选一/多选）：不传 = 全选（兼容旧调用）。 */
export interface FljSyncSelection {
  flj?: boolean;
  boomboom?: boolean;
  nsfw?: boolean;
}

/** 后台用：同步数据源——overview 拿福利鉴分类列表 → 每个分类翻页拉全 →
 *  两个额外源（boomboom / nsfw.pet）→ 合并去重。selected 控制勾选的站点，
 *  未勾选的整个跳过。任何源失败都不打断其余源，失败原因随 sources 返回
 *  （UI 必须展示，否则用户无从得知某源没拉到——2026-10-26 实测：两个新源
 *  静默失败，Archive 榜筛出空表）。 */
export async function fetchAllFljCategories(
  log = (_: string) => {},
  onProgress: (p: FljSyncProgress) => void = () => {},
  selected?: FljSyncSelection,
): Promise<{ bloggers: FljBlogger[]; errors: string[]; sources: FljSourceResult[] }> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const sel = selected ?? { flj: true, boomboom: true, nsfw: true };
  onProgress({ phase: "overview", done: 0, totalCats: 0, category: null, unique: 0, snapshot: [] });
  const cats = sel.flj === false ? [] : await fetchFljOverview();
  // 额外数据源（boomboom 归档榜 + nsfw.pet）与福利鉴分类并列。
  const plan: string[] = [
    ...cats.map((c) => c.id),
    ...(sel.boomboom === false ? [] : ["boomboom"]),
    ...(sel.nsfw === false ? [] : ["nsfw"]),
  ];
  onProgress({
    phase: "categories",
    done: 0,
    totalCats: plan.length,
    category: null,
    unique: 0,
    snapshot: [],
  });
  const results: { category: string; bloggers: FljBlogger[] }[] = [];
  const errors: string[] = [];
  const sources: FljSourceResult[] = [];
  let merged: FljBlogger[] = [];
  for (let i = 0; i < plan.length; i++) {
    const id = plan[i]!;
    onProgress({
      phase: "categories",
      done: i,
      totalCats: plan.length,
      category: id,
      unique: merged.length,
      snapshot: merged,
    });
    try {
      const bloggers =
        id === "boomboom"
          ? await fetchBoomboomArchive(log)
          : id === "nsfw"
            ? await fetchNsfwPet(log)
            : (await fetchFljRankings(id, log)).bloggers;
      results.push({ category: id, bloggers });
      sources.push({ id, ok: true, count: bloggers.length });
    } catch (e) {
      // 单个源失败不影响其余源，但必须把原因带出去给 UI 展示。
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${id}：${msg}`);
      sources.push({ id, ok: false, count: 0, error: msg });
    }
    merged = mergeCategoryResults(results);
    onProgress({
      phase: "categories",
      done: i + 1,
      totalCats: plan.length,
      category: id,
      unique: merged.length,
      snapshot: merged,
    });
    log(`分类 ${id}：+${sources[sources.length - 1]?.count ?? 0} 条（累计去重 ${merged.length}）`);
    await sleep(FLJ_PAGE_DELAY_MS + Math.floor(Math.random() * FLJ_PAGE_JITTER_MS));
  }
  return { bloggers: merged, errors, sources };
}

// ---- 额外数据源 ----

const FETCH_TIMEOUT_MS = 20_000;

async function fetchJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/** boomboom 归档榜解析（单文件 JSON 数组）：字段 screen_name/name/
 *  followers_count/avatar_url/verified/is_suspended。头像多为相对路径
 *  （/api/media?key=…），拼站点前缀。纯函数，可测。 */
export function parseBoomboomArchive(payload: unknown): FljBlogger[] {
  if (!Array.isArray(payload)) return [];
  const out: FljBlogger[] = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== "object") continue;
    const it = raw as Record<string, unknown>;
    const h = typeof it.screen_name === "string" ? it.screen_name.trim().toLowerCase() : "";
    if (!h || !/^[a-z0-9_]{1,15}$/.test(h)) continue;
    const av = typeof it.avatar_url === "string" ? it.avatar_url : "";
    // 源数据自己就标记了封禁号（is_suspended: 0/1 或 false/true）——直接
    // 预标 dead，省掉关注队列逐个去撞 403。
    const suspended = it.is_suspended === 1 || it.is_suspended === true;
    out.push({
      h,
      ...(typeof it.name === "string" && it.name ? { n: it.name } : {}),
      ...(typeof it.followers_count === "number" ? { followers: it.followers_count } : {}),
      ...(suspended ? { dead: true } : {}),
      neg: [],
      pos: [],
      ...(av ? { avatar: av.startsWith("http") ? av : `https://img.boomboom.nyc.mn${av}` } : {}),
    });
  }
  return out;
}

/** boomboom 归档榜（单文件 JSON，约 160 条）。 */
export async function fetchBoomboomArchive(log = (_: string) => {}): Promise<FljBlogger[]> {
  const out = parseBoomboomArchive(await fetchJson("https://img.boomboom.nyc.mn/data/archive.json"));
  log(`boomboom：${out.length} 条`);
  return out;
}

/** nsfw.pet 单页解析：{ data: { creators, meta: { total, has_more } } }，
 *  handle 去掉 @、统一小写。纯函数，可测。 */
export function parseNsfwPetPage(payload: unknown): {
  bloggers: FljBlogger[];
  hasMore: boolean;
  total: number;
} {
  const out: FljBlogger[] = [];
  let hasMore = false;
  let total = 0;
  const box = (payload ?? {}) as {
    data?: { creators?: unknown; meta?: { has_more?: unknown; total?: unknown } };
  };
  const creators = box.data?.creators;
  if (Array.isArray(creators)) {
    for (const raw of creators) {
      if (!raw || typeof raw !== "object") continue;
      const it = raw as Record<string, unknown>;
      const h = typeof it.handle === "string" ? it.handle.trim().replace(/^@/, "").toLowerCase() : "";
      if (!h || !/^[a-z0-9_]{1,15}$/.test(h)) continue;
      const av = typeof it.avatarUrl === "string" ? it.avatarUrl : "";
      out.push({
        h,
        ...(typeof it.name === "string" && it.name ? { n: it.name } : {}),
        ...(typeof it.followers === "number" ? { followers: it.followers } : {}),
        neg: [],
        pos: Array.isArray(it.tags)
          ? (it.tags as unknown[]).filter((x): x is string => typeof x === "string")
          : [],
        ...(av ? { avatar: av } : {}),
      });
    }
  }
  hasMore = box.data?.meta?.has_more === true;
  total = typeof box.data?.meta?.total === "number" ? (box.data.meta.total as number) : 0;
  return { bloggers: out, hasMore, total };
}

/** nsfw.pet 创作者榜（limit/offset 分页，total≈300）：has_more 为蛇形命名。 */
export async function fetchNsfwPet(log = (_: string) => {}): Promise<FljBlogger[]> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const out: FljBlogger[] = [];
  const seen = new Set<string>();
  const LIMIT = 50;
  const MAX_PAGES = 15; // 300 条 ≈ 6 页，留余量
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { bloggers: pageItems, hasMore } = parseNsfwPetPage(
      await fetchJson(
        `https://www.nsfw.pet/api/creators?sort=followers-desc&limit=${LIMIT}&offset=${offset}`,
      ),
    );
    for (const b of pageItems) {
      if (seen.has(b.h)) continue;
      seen.add(b.h);
      out.push(b);
    }
    log(`nsfw.pet 第 ${page + 1} 页：累计 ${out.length}`);
    if (!hasMore) break;
    offset += LIMIT;
    await sleep(FLJ_PAGE_DELAY_MS + Math.floor(Math.random() * FLJ_PAGE_JITTER_MS));
  }
  return out;
}

/** 后台用：拉取单个榜单分类的全部分页（顺序、带间隔），失败页跳过并继续。 */
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
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      const r = await fetch(`${FLJ_ORIGIN}/api/rankings?category=${encodeURIComponent(category)}&page=${page}`, {
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
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

/** 关注日志条目（UI 实时面板用）：每个目标一条，最新在前。 */
export interface FollowLogEntry {
  t: number;
  h?: string;
  n?: string;
  ok: boolean;
  note: string;
}

export interface FollowQueueState {
  items: { h: string; n?: string }[];
  cursor: number;
  done: number;
  failed: number;
  /** 本轮识别出的失效账号数（封禁/不存在，自动记入失效名单）。 */
  invalid: number;
  running: boolean;
  lastError: string | null;
  finishedAt: number | null;
  /** 滚动日志（最新在前，后台泵裁剪上限）。 */
  log?: FollowLogEntry[];
}

export const FOLLOW_QUEUE_KEY = "xss:follow-queue:v1";

export function emptyFollowQueue(): FollowQueueState {
  return {
    items: [],
    cursor: 0,
    done: 0,
    failed: 0,
    invalid: 0,
    running: false,
    lastError: null,
    finishedAt: null,
  };
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

// ---- 已关注记录（本机） ----
// 队列里每个关注成功的 handle 都记下来：UI 据此画「已关注占比」圆环、给
// 榜单行打 ✓ 已关注标记，并让新一轮队列自动跳过已关注的博主。注意这是
// 「通过本扩展关注过」的本机记录——在 X 端手动取关后这里不会回退，重新
// 关注会因 X 返回 403 而跳过，不影响使用。

export const FOLLOWED_KEY = "xss:flj:followed:v1";
const FOLLOWED_MAX = 20_000;

export async function getFollowedSet(): Promise<Set<string>> {
  try {
    const got = await chrome.storage.local.get(FOLLOWED_KEY);
    const v = got[FOLLOWED_KEY];
    return new Set(Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export async function addFollowed(handles: string[]): Promise<void> {
  const set = await getFollowedSet();
  let changed = false;
  for (const h of handles) {
    const k = h.trim().toLowerCase();
    if (k && !set.has(k)) {
      set.add(k);
      changed = true;
    }
  }
  if (!changed) return;
  // 超上限时丢最旧的（Set 保持插入序）。
  const arr = [...set];
  const trimmed = arr.length > FOLLOWED_MAX ? arr.slice(arr.length - FOLLOWED_MAX) : arr;
  await chrome.storage.local.set({ [FOLLOWED_KEY]: trimmed });
}

// ---- 失效名单（本机） ----
// 榜单数据混有已被 X 封禁 / 注销的账号（2026-10-26 用户实测：x.com/ariee_ziah
// 打开是 Account suspended）。关注队列一旦从 X 收到 63/50/108/404 这类明确
// 的「账号没了」错误码，就把 handle 记进来：UI 打「✗ 失效」标记、新队列自动
// 跳过——不再每轮白试一遍。账号恢复（解封/改名回归）可用 UI 的「清除记录」。

export const INVALID_KEY = "xss:flj:invalid:v1";
const INVALID_MAX = 20_000;

export async function getInvalidSet(): Promise<Set<string>> {
  try {
    const got = await chrome.storage.local.get(INVALID_KEY);
    const v = got[INVALID_KEY];
    return new Set(
      Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export async function addInvalid(handles: string[]): Promise<void> {
  const set = await getInvalidSet();
  let changed = false;
  for (const h of handles) {
    const k = h.trim().toLowerCase();
    if (k && !set.has(k)) {
      set.add(k);
      changed = true;
    }
  }
  if (!changed) return;
  const arr = [...set];
  const trimmed = arr.length > INVALID_MAX ? arr.slice(arr.length - INVALID_MAX) : arr;
  await chrome.storage.local.set({ [INVALID_KEY]: trimmed });
}

/** 账号可能解封/回归：清空失效名单，让下一轮队列重新尝试。 */
export async function clearInvalid(): Promise<void> {
  await chrome.storage.local.remove(INVALID_KEY);
}
