// 内置启发式：「AI 币圈蓝标」养号农场（aifarm 分类）。
//
// 与关键词规则的区别：规则匹配的是文本模板；这类号的文本千变万化（AI 生成），
// 但**行为指纹**极其一致——注册不满三个月就刷出海量推文（日均 30+ 条，真人
// 做不到），简介里用「互 fo / 互关 / 浇朋友 / 走个面儿」类话术做互动农业。
// 三者同时成立才判定：单看任何一个都会误伤正常的高产作者或话痨。
//
// 精度优先：启发式只收窄到「年轻 + 非人发帖量 + 养号话术」三重确认，宁漏勿
// 误。被 X 停用的样本号（2026-10-26 实测：31 天 / 1,563 条 / 「欢迎互fo，
// 我们做最亲密的陌生人」）全部命中。AI 头像、回复语义等弱信号交给在线 AI
// 分类器（服务端 SYSTEM 提示词已覆盖 aifarm），本地不做猜测。
import type { Signals } from "./types";

/** 简介里的互动农业话术（强信号词，单独出现即算）。 */
const FARMING_PHRASES = [
  "浇朋友",
  "走个面儿",
  "蓝v互关",
  "互fo",
  "互fo关",
  "互关",
  "互粉",
  "最亲密的陌生人",
];

export function matchAifarmHeuristic(sig: Signals): string[] | null {
  const age = sig.accountAgeDays;
  const posts = sig.statusesCount;
  if (typeof age !== "number" || typeof posts !== "number" || age < 1) return null;
  // 非人发帖量：日均 ≥30 条，且账号足够年轻（<90 天）。老号即使高产也
  // 不在此列——多年积累日均 30 条是话痨，不是农场。
  if (age >= 90) return null;
  const perDay = posts / age;
  if (perDay < 30) return null;
  const bio = (sig.bio ?? "").toLowerCase();
  const name = (sig.displayName ?? "").toLowerCase();
  const phrase = FARMING_PHRASES.find((p) => bio.includes(p) || name.includes(p));
  if (!phrase) return null;
  return [
    `本地启发式 · AI 币圈蓝标：注册 ${age} 天发帖 ${posts} 条（日均 ${Math.round(perDay)}）+ 简介养号话术「${phrase}」`,
  ];
}
