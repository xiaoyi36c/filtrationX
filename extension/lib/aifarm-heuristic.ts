// 内置启发式：「AI 币圈蓝标」养号农场（aifarm 分类）。v3。
//
// 与关键词规则的区别：规则匹配的是文本模板；这类号的文本千变万化（AI 生成），
// 但**行为指纹**极其一致。三条通道，均为宁漏勿误：
//
//   A. 年轻(<90 天) + 日均 ≥30 条 + 养号话术（简介/昵称/回复/推文，归一化
//      匹配：去空白零宽、f0→fo，拦「互 fo」「互f0」变体）。
//   B. 无话术通道：注册 <30 天 + 日均 ≥60 条（阈值倍增）+ 简介 带
//      币圈/web3/炒币/空投/炒股/数字游民/带单 垂直词。纯高频不判——新闻
//      实况、活动直播号存在，但它们既年轻不过 30 天又是这些垂直的比例极低。
//   C. 问候模板刷屏（agent 自动回复指纹，不限年龄）：主页近 6 条以上采样里
//      ≥40% 是「你好呀我是xx / 很高兴认识你」式问候模板，或 ≥4 条共享同一
//      归一化前缀（近重复）。真人不至于用同一套开场白回答一半的时间线；
//      另外本机模板记忆里同一文本出现 ≥2 次且是问候语也算。
//
// AI 头像、回复语义等弱信号交给在线 AI 分类器（服务端 SYSTEM 提示词已覆盖
// aifarm），本地不做猜测。
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

/** 互动农业话术（归一化后的形态）。 */
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
  "最亲密的陌生人",
];

/** 币圈/AI 农场垂直词（仅用于无话术的通道 B）。 */
const FARM_VERTICALS = ["币圈", "web3", "炒币", "空投", "炒股", "数字游民", "带单"];

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
  for (const t of texts) {
    const k = t.slice(0, 12);
    groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  const [prefix, n] = [...groups.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  if (n >= 4) return `同一开场白模板重复 ${n}/${texts.length} 条`;
  return null;
}

export function matchAifarmHeuristic(sig: Signals): string[] | null {
  // 通道 C：问候模板刷屏（agent 自动回复），行为指纹不依赖年龄/发帖量。
  const flood = greetingFlood(sig.recentTweets);
  if (flood) {
    return [`本地启发式 · AI 币圈蓝标：${flood}`];
  }
  // 通道 C'：回复区表面的同一问候模板复现（本机模板记忆计数）。
  if (
    (sig.templateRepeats ?? 0) >= 2 &&
    sig.triggeringComment &&
    GREETING_RE.test(norm(sig.triggeringComment))
  ) {
    return [
      `本地启发式 · AI 币圈蓝标：同一问候模板在本机已复现 ${sig.templateRepeats} 次`,
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
        `本地启发式 · AI 币圈蓝标：注册 ${age} 天发帖 ${posts} 条（日均 ${Math.round(perDay)}）+ 简介垂直词「${vertical}」`,
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
    `本地启发式 · AI 币圈蓝标：注册 ${age} 天发帖 ${posts} 条（日均 ${Math.round(perDay)}）+ 养号话术「${phrase}」`,
  ];
}
