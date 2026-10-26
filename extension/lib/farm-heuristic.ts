// 内置启发式：养号/互关农场与电商促销刷屏（v4）。
//
// 历史说明：曾单独设「AI 币圈蓝标」（aifarm）分类，后按真实功能并入既有
// 分类——检测规则全部保留，只是归属变了：
//   - 简介带 币圈/web3/炒股/副业/秘籍 等搞钱画像 → crypto（币圈投放）
//   - 纯互关/养号/营销行为（无搞钱画像）      → marketing（营销引流）
//
// 与关键词规则的区别：规则匹配的是文本模板；这类号的文本千变万化（AI 生成），
// 但**行为指纹**极其一致。四条通道，均为宁漏勿误：
//
//   A. 年轻(<90 天) + 日均 ≥30 条 + 养号话术（简介/昵称/回复/推文，归一化
//      匹配：去空白零宽、f0→fo，拦「互 fo」「互f0」变体）。
//   B. 无话术通道：注册 <30 天 + 日均 ≥60 条（阈值倍增）+ 简介 带
//      币圈/web3/炒股/数字游民等农场垂直词。纯高频不判——新闻实况、活动
//      直播号存在，但它们既年轻不过 30 天又是这些垂直的比例极低。
//   C. 问候模板刷屏（agent 自动回复指纹，不限年龄）：主页近 6 条以上采样里
//      ≥40% 是「你好呀我是xx / 很高兴认识你」式问候模板，或 ≥4 条短文本
//      共享同一归一化前缀；本机模板记忆里同一文本出现 ≥2 次且是问候语也算。
//   D. 互关农场（不限年龄）：对称大网络（粉丝与关注都过 800、比值 0.5-2）
//      叠加 回关/互关话术、或 蓝标+24h 爆发、或 蓝标/超大网络+搞钱副业简介。
//
// AI 头像、回复语义等弱信号交给在线 AI 分类器，本地不做猜测。
import type { SpamCategory } from "./category";
import type { Signals } from "./types";

/** 归一化：小写、去空白与零宽字符、常见变体字归一。 */
function norm(s: string | undefined | null): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[\s\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/f0/g, "fo")
    .replace(/ｏ/g, "o")
    .replace(/ｆ/g, "f");
}

/** 互动农业话术（归一化后的形态）。回关/巡逻来自互关农场样本
 *  （2026-10-26 @Qiyaqiyoo：置顶推「每天都巡逻回关蓝v推友」）。 */
const FARMING_PHRASES = [
  "交个朋友",
  "浇朋友",
  "走个面儿",
  "见个面",
  "蓝v互关",
  "蓝v互",
  "互fo",
  "互关",
  "互粉",
  "互相关注",
  "回关",
  "巡逻回关",
  "最亲密的陌生人",
];

/** 币圈/AI 农场垂直词（通道 B 的简介要求；也是 crypto/marketing 归类的
 *  依据之一）。 */
const FARM_VERTICALS = ["币圈", "web3", "炒币", "空投", "炒股", "数字游民", "带单"];

/** 搞钱副业简介词：副业/秘籍/股票类自我标榜是蓝标互关团的常见简介画像，
 *  也是归入 crypto 的信号之一。 */
const MONEY_MARKERS = [
  "副业",
  "搞钱",
  "秘籍",
  "网赚",
  "躺赚",
  "被动收入",
  "兼职",
  "理财",
  "炒股",
  "股票",
];

/** agent 问候开场白（对归一化文本匹配：小写、无空白）。 */
const GREETING_RE =
  /你好[呀哈啊~～!！。,，]*([^。]{0,14})?(我是|我叫|认识你|见到你|交个朋友)|很高兴(认识|见到)你|(我是|我叫).{1,16}[，,].{0,10}(很高兴|认识你|请多指教)|交个朋友好吗/;

function volumePerDay(sig: Signals): { age: number; posts: number; perDay: number } | null {
  const age = sig.accountAgeDays;
  const posts = sig.statusesCount;
  if (typeof age !== "number" || typeof posts !== "number" || !Number.isFinite(age) || age < 1)
    return null;
  return { age, posts, perDay: posts / age };
}

/** 养号/互关农场命中归入哪个分类：简介/昵称/近期推文带币圈、web3、炒股、
 *  秘籍、搞钱等画像 → crypto（币圈投放，这类号的最终目的是卖币卖课）；
 *  纯互关/涨粉行为 → marketing（营销引流）。 */
export function farmCategoryOf(sig: Signals): SpamCategory {
  const texts = [sig.bio, sig.displayName, ...(sig.recentTweets ?? []).slice(0, 10)]
    .map(norm)
    .filter(Boolean);
  const moneyish = [...FARM_VERTICALS, "秘籍", "搞钱", "网赚", "躺赚"];
  return moneyish.some((m) => texts.some((t) => t.includes(m))) ? "crypto" : "marketing";
}

/** 通道 C：主页时间线的问候模板占比 / 近重复前缀。返回证据文案或 null。 */
function greetingFlood(recentTweets: string[] | undefined): string | null {
  const raw = recentTweets ?? [];
  // 样本门槛按原始条数计（过滤后的短文本不计入分母，但别让它们把样本量
  // 跌破 6 而漏判）。
  if (raw.length < 6) return null;
  const texts = raw
    .map((t) => norm(t).replace(/[\u{1F300}-\u{1FAFF}\u{1F900}-\u{1F9FF}\uFE0F]/gu, ""))
    .filter((t) => t.length >= 8);
  if (texts.length < 4) return null;
  const greeted = texts.filter((t) => GREETING_RE.test(t)).length;
  if (greeted / texts.length >= 0.4) return `问候模板占主页近期采样 ${greeted}/${texts.length} 条`;
  const groups = new Map<string, number>();
  // 前缀通道只看短文本（≤60 字）：agent 问候回复都是短句；「早报/日更系列」
  // 类账号每期同前缀但都是长文，不算模板刷屏。
  for (const t of texts) {
    if (t.length > 60) continue;
    const k = t.slice(0, 12);
    groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  const [prefix, n] = [...groups.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  if (n >= 4) return `同一开场白模板重复 ${n}/${texts.length} 条`;
  return null;
}

export function matchFarmHeuristic(sig: Signals): string[] | null {
  // 通道 D：互关农场（不限年龄）。对称大网络（粉丝与关注都过 800、比值
  // 0.5-2，互关团的典型形状）+ 养号证据。单看对称结构会误伤正常的互粉
  // 用户，单看话术会被老号年龄门槛挡住——两者相乘才是「饺子每天都巡逻
  // 回关蓝v推友」这类号的形状。
  const fw = sig.followersCount;
  const fg = sig.followingCount;
  const symmetric =
    typeof fw === "number" &&
    typeof fg === "number" &&
    fw >= 800 &&
    fg >= 800 &&
    fw / fg >= 0.5 &&
    fw / fg <= 2;
  if (symmetric) {
    const texts = [sig.bio, sig.displayName, ...(sig.recentTweets ?? []).slice(0, 10)]
      .map(norm)
      .filter(Boolean);
    const phrase = FARMING_PHRASES.find((p) => texts.some((t) => t.includes(p)));
    if (phrase) {
      return [
        `本地启发式 · 互关农场：互关结构（粉丝 ${fw}/关注 ${fg}）+ 养号话术「${phrase}」`,
      ];
    }
    // 蓝标会员 + 24h 内主页可见 ≥10 条（X 虚拟列表只渲染 10-20 行，10 条
    // 意味着整页都是今天发的）——多维度叠加时话术可以缺席。
    if (sig.isVerified && (sig.recentPosts24h ?? 0) >= 10) {
      return [
        `本地启发式 · 互关农场：互关结构（粉丝 ${fw}/关注 ${fg}）+ 蓝标 + 24h 可见发帖 ${sig.recentPosts24h} 条`,
      ];
    }
    // 蓝标 + 搞钱副业简介（2026-10-26 @ImYanBoss 样本：8k/8.7k 对称互关 +
    // 蓝标 + 「副业探索 | 股票研究 | 根据 Mi 姐秘籍做了个网站」——不写回关
    // 话术的变种）。蓝标字段在部分页面的 fiber 形状下可能取不到，因此超大
    // 对称网络（两侧 ≥5000）不依赖蓝标——那个规模的对称互关本身就是农场
    // 形状，正常用户极少经营 5k+ 的 1:1 关注网。
    if (sig.isVerified || (fw >= 5000 && fg >= 5000)) {
      const money = MONEY_MARKERS.find((m) => texts.some((t) => t.includes(m)));
      if (money) {
        return [
          `本地启发式 · 互关农场：互关结构（粉丝 ${fw}/关注 ${fg}）${sig.isVerified ? " + 蓝标" : ""} + 搞钱副业简介「${money}」`,
        ];
      }
      // 诊断：互关结构成立但三变体都差一条腿时打到控制台，便于用户回报
      // 校准（只在 profile 页头打，频率低）。
      console.debug(
        "[MXGA] farm heuristic near-miss",
        sig.handle,
        JSON.stringify({
          followers: fw,
          following: fg,
          verified: sig.isVerified ?? false,
          age: sig.accountAgeDays,
          posts24h: sig.recentPosts24h,
          bio: (sig.bio ?? "").slice(0, 80),
        }),
      );
    }
  }

  // 通道 C：问候模板刷屏（agent 自动回复），行为指纹不依赖年龄/发帖量。
  const flood = greetingFlood(sig.recentTweets);
  if (flood) {
    return [`本地启发式 · 养号农场：${flood}`];
  }
  // 通道 C'：回复区表面的同一问候模板复现（本机模板记忆计数）。
  if (
    (sig.templateRepeats ?? 0) >= 2 &&
    sig.triggeringComment &&
    GREETING_RE.test(norm(sig.triggeringComment))
  ) {
    return [
      `本地启发式 · 养号农场：同一问候模板在本机已复现 ${sig.templateRepeats} 次`,
    ];
  }

  const v = volumePerDay(sig);
  if (!v) return null;
  const { age, posts, perDay } = v;
  if (age >= 90) return null; // 多年积累的高日均是话痨，不是农场

  // 通道 B：无话术但超高频 + 农场垂直简介（阈值比通道 A 倍增）。
  if (age < 30 && perDay >= 60) {
    const bio = norm(sig.bio);
    const vertical = FARM_VERTICALS.find((k) => bio.includes(k));
    if (vertical) {
      return [
        `本地启发式 · 养号农场：注册 ${age} 天发帖 ${posts} 条（日均 ${Math.round(perDay)}）+ 简介垂直词「${vertical}」`,
      ];
    }
  }

  // 通道 A：年轻 + 高频 + 养号话术（简介/昵称/触发回复/近期推文任一）。
  if (perDay < 30) return null;
  const texts = [
    sig.bio,
    sig.displayName,
    sig.triggeringComment,
    ...(sig.recentTweets ?? []).slice(0, 10),
  ]
    .map(norm)
    .filter(Boolean);
  const phrase = FARMING_PHRASES.find((p) => texts.some((t) => t.includes(p)));
  if (!phrase) return null;
  return [
    `本地启发式 · 养号农场：注册 ${age} 天发帖 ${posts} 条（日均 ${Math.round(perDay)}）+ 养号话术「${phrase}」`,
  ];
}

// ---- 营销引流（marketing 分类）：电商优惠券/带货刷屏 ----

/** 带货/优惠券标记词。命中密度（而非单条）定罪：正常用户偶尔提一句
 *  「淘宝买的」不算，整面推文都是促销才算。 */
const PROMO_MARKERS = [
  "优惠券",
  "领券",
  "大促",
  "捡漏",
  "内部价",
  "秒杀",
  "粉丝福利",
  "带货",
  "上车",
  "进裙",
  "拼多多",
  "天猫",
  "京东",
  "淘宝",
];

/** 营销引流启发式：
 *  - 主页通道：近期采样 ≥6 条里 ≥60% 含带货标记——正常卖家偶尔发新品
 *    达不到这个密度，纯促销墙（11.11 大促刷屏型）直接命中。
 *  - 回复通道：新号（<90 天）回复带货话术（≥2 个标记，或 1 个标记 +
 *    链接）——回复区塞优惠券是营销号的标准行为，老号偶发不判。 */
export function matchPromoFlood(sig: Signals): string[] | null {
  const raw = sig.recentTweets ?? [];
  if (raw.length >= 6) {
    const texts = raw.map(norm);
    const promo = texts.filter((t) => PROMO_MARKERS.some((m) => t.includes(m))).length;
    if (promo / raw.length >= 0.6) {
      return [`本地启发式 · 营销引流：主页近期采样 ${promo}/${raw.length} 条为带货/优惠券内容`];
    }
  }
  const comment = norm(sig.triggeringComment ?? "");
  if (comment) {
    const markers = PROMO_MARKERS.filter((m) => comment.includes(m));
    const hasLink = /https?:|t\.co|\.(cn|com|net)/.test(comment);
    const young = typeof sig.accountAgeDays === "number" && sig.accountAgeDays < 90;
    if (young && (markers.length >= 2 || (markers.length === 1 && hasLink))) {
      return [
        `本地启发式 · 营销引流：新号回复带货话术${markers.length ? `「${markers[0]}」` : "（含推广链接）"}`,
      ];
    }
  }
  return null;
}
