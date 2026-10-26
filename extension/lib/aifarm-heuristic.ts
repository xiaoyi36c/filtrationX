// 内置启发式：「AI 币圈蓝标」养号农场（aifarm 分类）。v2。
//
// 与关键词规则的区别：规则匹配的是文本模板；这类号的文本千变万化（AI 生成），
// 但**行为指纹**极其一致——注册不满三个月就刷出海量推文（真人做不到），简介
// 或回复里用「互 fo / 互关 / 交个朋友 / 走个面儿」类话术做互动农业。命中后走
// 与关键词规则相同的标记/自动处理链路（分类 aifarm，默认仅标记）。
//
// 两条通道，均为宁漏勿误：
//   A. 三重确认：年轻(<90 天) + 日均 ≥30 条 + 养号话术。话术扫描范围不只
//      简介——昵称、触发回复、近期推文都算（农场常把话术只放在回复里）；
//      文本先归一化（去空白/零宽字符、f0→fo），拦住「互 fo」「互f0」式变体。
//   B. 无话术通道：注册 <30 天 + 日均 ≥60 条（比通道 A 倍增的硬阈值）+ 简介
//      带 币圈/web3/炒币/空投/炒股/数字游民/带单 垂直词。纯高频不判——新闻
//      实况、活动直播号存在，但它们既年轻不过 30 天又是这些垂直的比例极低。
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
const FARM_VERTICALS = [
  "币圈",
  "web3",
  "炒币",
  "空投",
  "炒股",
  "数字游民",
  "带单",
];

function volumePerDay(sig: Signals): { age: number; posts: number; perDay: number } | null {
  const age = sig.accountAgeDays;
  const posts = sig.statusesCount;
  if (typeof age !== "number" || typeof posts !== "number" || !Number.isFinite(age) || age < 1)
    return null;
  return { age, posts, perDay: posts / age };
}

export function matchAifarmHeuristic(sig: Signals): string[] | null {
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
