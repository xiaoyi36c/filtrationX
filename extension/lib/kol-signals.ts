// KOL 浮卡 · L2 本地累积画像 (二开, 上游计划目标 02 · M2)。
//
// M1 的指标全部来自单页 fiber 档案；「原创比」和「主题集中度」需要跨页面
// 证据。本模块在浏览过程中按作者累积采样（复用 cache.ts 的思路，但换成
// 单键 map + 惰性过期，因为每次扫描都要读写很多小条目）：
//
//   - scan() 对每条可见推文记一笔：可见作者 = 原创（statusId 去重）；
//     socialContext 的转推行把这笔记给转推者（非原创）。
//   - 推文文本经本地分词（CJK 二元组 + 拉丁词）累积文档频率，期望共现
//     换算成主题集中度。只存计数，不存原文——延续隐私红线。
//
// 全部本地计算，不上传任何数据。写入用防抖合并（一次 scan tick 可能采
// 几十条），storage 不可用时静默退化为纯内存。

const STORE_KEY = "xss:kol:v1";
const DAY = 86_400_000;

/** 条目 3 天没更新即视为过期（惰性：读取时判定，flush 时清理）。 */
const TTL = 3 * DAY;
/** 存储条目上限（按 updatedAt 淘汰最旧的），防 storage 无限膨胀。 */
const MAX_ENTRIES = 600;
/** 单账号最多计数的推文数（够了，再多样本也不会改变结论多少）。 */
const MAX_TOTAL = 200;
/** 去重环：记住最近看过的 statusId，防止同一推文被反复扫描重复计数。 */
const SEEN_MAX = 40;
/** 单条推文最多贡献的 token 数。 */
const TOKENS_PER_TWEET = 40;
/** 报告原创比所需的最小样本。 */
export const MIN_TWEETS_FOR_RATIO = 5;
/** 报告主题集中度所需的最小 token 量。 */
const MIN_TOKENS_FOR_FOCUS = 20;

export interface KolSignalEntry {
  handle: string;
  userId?: string;
  displayName?: string;
  /** 已采样的推文总数（原创 + 转推）。 */
  total: number;
  /** 其中原创（可见作者即作者本人的）条数。 */
  original: number;
  /** 最近计过数的 statusId 环（转推用 rt: 前缀区分）。 */
  seen: string[];
  /** 主题词的文档频率：出现过该词的推文条数（只存计数不存原文）。 */
  tokens: Record<string, number>;
  /** Σ tokens[df] —— 全部「推文 × 去重词」 incidences。 */
  tokenTotal: number;
  updatedAt: number;
}

type SignalMap = Map<string, KolSignalEntry>;

let signals: SignalMap | null = null;
let loaded = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function keyOf(handle: string): string {
  return handle.trim().replace(/^@+/, "").toLowerCase();
}

export async function warmKolSignals(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const got = await chrome.storage.local.get(STORE_KEY);
    const raw = got[STORE_KEY] as Record<string, KolSignalEntry> | undefined;
    if (!raw) return;
    const now = Date.now();
    for (const [key, entry] of Object.entries(raw)) {
      // JSON.parse 不触发 setter，但读回来的键仍要挡一层原型名。
      if (key === "__proto__" || key === "constructor" || key === "toString") continue;
      if (!entry || typeof entry !== "object" || typeof entry.handle !== "string") continue;
      if (now - (entry.updatedAt ?? 0) > TTL) continue; // 惰性过期
      signals = signals ?? new Map();
      signals.set(key, entry);
    }
  } catch {
    /* storage 不可用 → 纯内存 */
  }
}

function scheduleFlush(): void {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flushKolSignals(), 2000);
}

export async function flushKolSignals(): Promise<void> {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  if (!signals) return;
  const now = Date.now();
  // 清过期 + 淘汰最旧，把总量压在上限内。
  for (const [key, e] of signals) {
    if (now - e.updatedAt > TTL) signals.delete(key);
  }
  if (signals.size > MAX_ENTRIES) {
    const oldest = [...signals.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [key] of oldest.slice(0, signals.size - MAX_ENTRIES)) signals.delete(key);
  }
  const out: Record<string, KolSignalEntry> = {};
  for (const [key, e] of signals) out[key] = e;
  try {
    await chrome.storage.local.set({ [STORE_KEY]: out });
  } catch {
    /* non-fatal */
  }
}

export interface KolSample {
  handle: string;
  userId?: string;
  displayName?: string;
  /** 去重用的推文 id（转推传 rt:<sid> 区分同一条的不同转发者）。 */
  statusId: string;
  /** true=可见作者的原创内容；false=转推（非原创）。 */
  original: boolean;
  /** 原创推文文本，仅用于本地分词，不落原文。 */
  text?: string;
}

/** 记一笔采样。同步 + 内存操作（scan 热路径），storage 写入防抖合并。 */
export function noteKolSample(s: KolSample): void {
  const key = keyOf(s.handle);
  if (!key || !s.statusId) return;
  signals = signals ?? new Map();
  const e =
    signals.get(key) ??
    ({
      handle: key,
      total: 0,
      original: 0,
      seen: [],
      tokens: {},
      tokenTotal: 0,
      updatedAt: 0,
    } as KolSignalEntry);
  if (s.userId && !e.userId) e.userId = s.userId;
  if (s.displayName && !e.displayName) e.displayName = s.displayName;
  if (e.seen.includes(s.statusId)) {
    e.updatedAt = Date.now();
    signals.set(key, e);
    scheduleFlush();
    return;
  }
  e.seen.push(s.statusId);
  if (e.seen.length > SEEN_MAX) e.seen.splice(0, e.seen.length - SEEN_MAX);
  if (e.total < MAX_TOTAL) {
    e.total += 1;
    if (s.original) e.original += 1;
    if (s.original && s.text) {
      // 一条推文内同一词只记一次（文档频率，不是原始词频）——主题集中度
      // 度量的是「词覆盖了多少条推文」，不是词在某条里出现多密。
      let n = 0;
      for (const tok of new Set(tokenize(s.text))) {
        e.tokens[tok] = (e.tokens[tok] ?? 0) + 1;
        e.tokenTotal += 1;
        if (++n >= TOKENS_PER_TWEET) break;
      }
    }
  }
  e.updatedAt = Date.now();
  signals.set(key, e);
  scheduleFlush();
}

export interface KolSignalsRead {
  originalRatio?: number;
  sampledTweets?: number;
  topicFocus?: number;
}

/** 读某账号的采样结论。结论字段样本不足就不返回（卡片渲染冷启动提示）；
 *  sampledTweets 只要采过就返回，供卡片标注数据源与冷启动进度。 */
export function kolSignalsFor(handle: string): KolSignalsRead {
  const e = signals?.get(keyOf(handle));
  if (!e) return {};
  const out: KolSignalsRead = {};
  if (e.total > 0) out.sampledTweets = e.total;
  if (e.total >= MIN_TWEETS_FOR_RATIO) {
    out.originalRatio = e.original / e.total;
  }
  const focus = topicFocusOf(e);
  if (focus !== undefined) out.topicFocus = focus;
  return out;
}

// ---- 设置页：采样数据统计与清空 (M4) ----

export interface KolSignalsStats {
  /** 有采样记录的账号数。 */
  accounts: number;
  /** 累计采样的推文条数（全部账号相加）。 */
  samples: number;
  /** 样本量达到可报告原创比的账号数。 */
  labeled: number;
  /** 最近一次采样时间（epoch ms，0 = 无）。 */
  latestTs: number;
}

/** 读存储侧统计——设置页与内容脚本不在一个上下文，内存 map 看不到，
 *  必须直接读 chrome.storage。 */
export async function kolSignalsStats(): Promise<KolSignalsStats> {
  const out: KolSignalsStats = { accounts: 0, samples: 0, labeled: 0, latestTs: 0 };
  try {
    const got = await chrome.storage.local.get(STORE_KEY);
    const raw = got[STORE_KEY] as Record<string, KolSignalEntry> | undefined;
    if (!raw) return out;
    for (const [key, e] of Object.entries(raw)) {
      if (key === "__proto__" || key === "constructor" || key === "toString") continue;
      if (!e || typeof e !== "object") continue;
      out.accounts += 1;
      out.samples += e.total ?? 0;
      if ((e.total ?? 0) >= MIN_TWEETS_FOR_RATIO) out.labeled += 1;
      if ((e.updatedAt ?? 0) > out.latestTs) out.latestTs = e.updatedAt ?? 0;
    }
  } catch {
    /* storage 不可用 → 全零 */
  }
  return out;
}

/** 清空全部采样画像（设置页入口）。内容脚本的内存 map 由下面的
 *  storage.onChanged 监听同步清空，不会在下次 flush 时写回。 */
export async function clearKolSignals(): Promise<void> {
  try {
    await chrome.storage.local.remove(STORE_KEY);
  } catch {
    /* non-fatal */
  }
}

// 设置页清空后同步内容脚本内存：不监听的话，防抖中的 flush 会把旧数据
// 原样写回，「清空」就成了摆设。自己的 flush 也会触发本监听——重建出的
// map 与内存一致，等价于 no-op。
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(STORE_KEY in changes)) return;
    const next = changes[STORE_KEY]?.newValue as Record<string, KolSignalEntry> | undefined;
    if (!next || Object.keys(next).length === 0) {
      signals = new Map();
      return;
    }
    const m = new Map<string, KolSignalEntry>();
    for (const [k, e] of Object.entries(next)) {
      if (k === "__proto__" || k === "constructor" || k === "toString") continue;
      if (!e || typeof e !== "object" || typeof e.handle !== "string") continue;
      m.set(k, e);
    }
    signals = m;
  });
} catch {
  /* 测试环境无 chrome — 静默 */
}

/** 本地分词：拉丁词（≥3 字符）+ CJK 滑动二元组。够用来区分「满屏同一话术
 *  / 同一话题」与「什么都聊」，不需要真分词器。 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(/[a-z][a-z0-9_']{2,}|[\u4e00-\u9fff]+|\d{2,}/g)) {
    const t = m[0];
    if (/[\u4e00-\u9fff]/.test(t)) {
      if (t.length < 2) continue;
      for (let i = 0; i + 2 <= t.length; i++) out.push(t.slice(i, i + 2));
    } else {
      out.push(t);
    }
  }
  return out;
}

/** 主题集中度：随机抽两条推文的「期望共享词数」相对单条平均词量的占比。
 *  1 = 每两条推文都在讲同一套词（同一话题/话术），0 = 词几乎不重复
 *  （什么都聊）。样本不足时返回 undefined。 */
function topicFocusOf(e: KolSignalEntry): number | undefined {
  if (e.total < MIN_TWEETS_FOR_RATIO || e.tokenTotal < MIN_TOKENS_FOR_FOCUS) return undefined;
  const total = e.total;
  let shared = 0;
  for (const df of Object.values(e.tokens)) {
    const p = df / total; // 两条随机推文都含该词的概率
    shared += p * p;
  }
  const avgTokens = e.tokenTotal / total;
  if (avgTokens <= 0) return undefined;
  return Math.max(0, Math.min(1, shared / avgTokens));
}

// ---- 综合可信分 ----

export type TrustTier = "safe" | "ok" | "warn" | "risk";

export interface TrustInput {
  accountAgeDays?: number;
  followersCount?: number;
  followingCount?: number;
  statusesCount?: number;
  favouritesCount?: number;
  originalRatio?: number;
}

export interface TrustResult {
  score: number; // 0-100
  tier: TrustTier;
  /** 四个子维度分（0-100），卡片分项透明度用（M4）：缺数据的维度 = 50。 */
  parts: { age: number; network: number; engagement: number; original: number };
}

function ageScore(d: number | undefined): number {
  if (typeof d !== "number" || !Number.isFinite(d)) return 50;
  if (d < 7) return 5;
  if (d < 30) return 25;
  if (d < 90) return 50;
  if (d < 365) return 70;
  return 85;
}

/** 关注网络形态：互粉失衡（海量关注、极少粉丝）是 follow-back 农场。 */
function networkScore(followers?: number, following?: number): number {
  if (typeof followers !== "number" || typeof following !== "number" || followers < 0 || following < 0)
    return 50;
  if (following === 0 && followers === 0) return 50;
  const r = followers / Math.max(1, following);
  if (following > 2000 && followers < following * 0.5) return 10;
  if (r >= 1) return 75;
  if (r >= 0.3) return 55;
  if (r >= 0.1) return 35;
  return 12;
}

/** 互动形态：赞远超粉丝 = 阈值刷赞；大号几乎没有获赞 = 买粉死号。 */
function engagementScore(fav?: number, followers?: number, statuses?: number): number {
  if (typeof fav !== "number" || typeof followers !== "number" || followers <= 0) return 50;
  if (fav / followers > 20) return 10;
  if (
    typeof statuses === "number" &&
    statuses > 0 &&
    followers > 1000 &&
    fav / statuses < 0.05
  )
    return 35;
  return 70;
}

function originalScore(r: number | undefined): number {
  if (typeof r !== "number") return 50;
  if (r >= 0.8) return 80;
  if (r >= 0.5) return 60;
  if (r >= 0.2) return 35;
  return 10;
}

/** 综合可信分：年龄 30% + 关注网络 25% + 互动形态 25% + 原创比 20%。
 *  缺数据的维度回中性 50，不奖不罚。parts 把各维度分原样带出。 */
export function trustAssessment(input: TrustInput): TrustResult {
  const age = ageScore(input.accountAgeDays);
  const network = networkScore(input.followersCount, input.followingCount);
  const engagement = engagementScore(input.favouritesCount, input.followersCount, input.statusesCount);
  const original = originalScore(input.originalRatio);
  const score = Math.round(0.3 * age + 0.25 * network + 0.25 * engagement + 0.2 * original);
  const tier: TrustTier = score >= 75 ? "safe" : score >= 55 ? "ok" : score >= 35 ? "warn" : "risk";
  return { score, tier, parts: { age, network, engagement, original } };
}
