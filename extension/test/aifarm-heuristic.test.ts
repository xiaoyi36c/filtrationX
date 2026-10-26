// 内置 aifarm 启发式 v2（lib/aifarm-heuristic.ts）的精度边界：
// 通道 A = 年轻 + 日均≥30 + 话术（简介/昵称/回复/推文，归一化匹配）；
// 通道 B = 年轻(<30 天) + 日均≥60 + 币圈/web3/炒股类垂直简介。
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchAifarmHeuristic } from "../lib/aifarm-heuristic";
import type { Signals } from "../lib/types";

function sig(over: Partial<Signals>): Signals {
  return {
    handle: "Kyousuke567",
    recentTweets: [],
    accountAgeDays: 31,
    statusesCount: 1563,
    bio: "03年211本硕勇闯X！爱好游戏、篮球、健身 欢迎互fo，我们做最亲密的陌生人",
    ...over,
  } as Signals;
}

test("2026-10-26 实测停用样本号命中（年轻 + 日均50 + 互fo话术）", () => {
  const r = matchAifarmHeuristic(sig({}));
  assert.ok(r, "screenshot sample must hit");
  const text = r?.[0] ?? "";
  assert.match(text, /AI 币圈蓝标/);
  assert.match(text, /互fo/);
});

test("归一化拦住变体：互 fo / 互f0 / 交个朋友", () => {
  assert.ok(matchAifarmHeuristic(sig({ bio: "欢迎 互 fo" })), "空白变体");
  assert.ok(matchAifarmHeuristic(sig({ bio: "互f0，走个面儿" })), "f0 变体");
  assert.ok(matchAifarmHeuristic(sig({ bio: "来我主页交个朋友" })), "交个朋友");
});

test("话术在回复里也算（简介干净）", () => {
  const r = matchAifarmHeuristic(
    sig({ bio: "记录日常", triggeringComment: "兄弟有空来浇朋友啊😂" }),
  );
  assert.ok(r);
});

test("通道 B：无话术但 <30 天日均 60+ 且币圈垂直简介", () => {
  const r = matchAifarmHeuristic(
    sig({ accountAgeDays: 20, statusesCount: 1300, bio: "专注 web3 与 AI 一级市场" }),
  );
  assert.ok(r);
  assert.match(r?.[0] ?? "", /垂直词/);
});

test("老号高产不命中（<90 天门槛）", () => {
  assert.equal(matchAifarmHeuristic(sig({ accountAgeDays: 400, statusesCount: 20000 })), null);
});

test("年轻但发帖量正常不命中", () => {
  assert.equal(matchAifarmHeuristic(sig({ statusesCount: 300 })), null);
});

test("缺发帖量数据不命中（宁漏勿误）", () => {
  assert.equal(matchAifarmHeuristic(sig({ statusesCount: undefined })), null);
});

test("高频年轻号但无话术、简介非农场垂直不命中", () => {
  assert.equal(
    matchAifarmHeuristic(sig({ bio: "产品经理，记录日常与思考", displayName: "阿明" })),
    null,
  );
  // 通道 B 边界：日均不足 60 也不走 B
  assert.equal(
    matchAifarmHeuristic(
      sig({ accountAgeDays: 20, statusesCount: 1000, bio: "web3 学习笔记" }),
    ),
    null,
  );
});

test("话术在昵称里也算", () => {
  const r = matchAifarmHeuristic(sig({ bio: "", displayName: "币圈互关哥" }));
  assert.ok(r);
});

// ---- 通道 C：问候模板刷屏（agent 自动回复，不限年龄）----

test("主页近采样 ≥40% 问候模板 → 命中（老号也判）", () => {
  const wall = Array.from({ length: 8 }, (_, i) => `你好呀，我是小助手${i}，很高兴认识你！`);
  wall.push("今天天气不错", "吃了吗朋友们");
  const r = matchAifarmHeuristic(
    sig({ accountAgeDays: 500, statusesCount: 900, recentTweets: wall }),
  );
  assert.ok(r, "greeting flood must hit regardless of age");
  assert.match(r?.[0] ?? "", /问候模板/);
});

test("近重复开场白 ≥4 条 → 命中", () => {
  const wall = [
    "你好呀，我是小八见，很高兴认识你！",
    "你好呀，我是小八见，很高兴认识你！",
    "你好呀，我是小八见，很高兴认识你！😊",
    "你好呀，我是小八见，很高兴认识你！哈哈",
    "今天天气不错",
    "周末愉快",
  ];
  const r = matchAifarmHeuristic(
    sig({ accountAgeDays: 120, statusesCount: 2000, recentTweets: wall }),
  );
  assert.ok(r);
  assert.match(r?.[0] ?? "", /模板/);
});

test("回复区模板记忆复现 ≥2 次 + 问候语 → 命中", () => {
  const r = matchAifarmHeuristic(
    sig({
      accountAgeDays: 200,
      statusesCount: 500,
      recentTweets: [],
      triggeringComment: "你好呀，我是小八见，很高兴认识你！",
      templateRepeats: 3,
    }),
  );
  assert.ok(r);
});

test("正常内容主页不误判（问候偶发 + 多样内容）", () => {
  const wall = [
    "你好呀，我是新人博主，很高兴认识你",
    "今天试了新餐厅，人均一百",
    "读完了《置身事内》，推荐",
    "健身第 30 天打卡",
    "这部电影文艺片值得二刷",
    "周末爬山去了",
    "路由器终于换了，WiFi 满速",
  ];
  assert.equal(
    matchAifarmHeuristic(sig({ accountAgeDays: 500, statusesCount: 900, recentTweets: wall })),
    null,
  );
});

test("采样不足 6 条不判通道 C（宁漏勿误）", () => {
  assert.equal(
    matchAifarmHeuristic(
      sig({
        accountAgeDays: 500,
        statusesCount: 900,
        recentTweets: [
          "你好呀，我是小八见，很高兴认识你！",
          "你好呀，我是小八见，很高兴认识你！",
          "你好呀，我是小八见，很高兴认识你！",
        ],
      }),
    ),
    null,
  );
});

test("完全相同的问候语刷屏（去重取消后的真实墙）→ 命中", () => {
  // 2026-10-26 实测：profileTweets 原先对完全相同文本去重，30 条一模一样的
  // 问候语只剩 1 条，通道 C 永远凑不够样本。现在的真实形态应直接命中。
  const wall = Array.from({ length: 10 }, () => "你好呀，我是小八见，很高兴认识你！");
  const r = matchAifarmHeuristic(
    sig({ accountAgeDays: 400, statusesCount: 3000, recentTweets: wall }),
  );
  assert.ok(r);
  assert.match(r?.[0] ?? "", /问候模板|模板/);
});

test("日更系列长文同前缀不误判（前缀通道仅限短文本）", () => {
  const digest = Array.from(
    { length: 8 },
    (_, i) =>
      `早报：今日要闻速览第 ${i + 1} 期。全球市场综述与科技动态，aily 摘要包括宏观政策、行业变化与公司公告的完整分析，正文很长很长很长。`,
  );
  assert.equal(
    matchAifarmHeuristic(sig({ accountAgeDays: 400, statusesCount: 900, recentTweets: digest })),
    null,
  );
});

test("短模板非问候语刷屏 → 前缀通道命中", () => {
  const wall = Array.from(
    { length: 6 },
    () => "家人们谁懂啊，这个瓜也太离谱了吧",
  );
  const r = matchAifarmHeuristic(
    sig({ accountAgeDays: 150, statusesCount: 4000, recentTweets: wall }),
  );
  assert.ok(r);
  assert.match(r?.[0] ?? "", /模板/);
});

// ---- 通道 D：互关农场（不限年龄）----

test("2026-10-26 互关农场样本（4.8 年老号 + 对称网络 + 置顶回关话术）→ 命中", () => {
  const r = matchAifarmHeuristic(
    sig({
      handle: "Qiyaqiyoo",
      accountAgeDays: 1750,
      statusesCount: 24000,
      followersCount: 5953,
      followingCount: 5714,
      isVerified: true,
      bio: "饺子每天都巡逻回关蓝v推友，组织放心",
      recentTweets: ["点进你的朋友圈，是脆皮捏捏，是超长蛋挞", "在穷人和士人之间选择了做一个又穷又土的人。"],
    }),
  );
  assert.ok(r, "follow-back farm must hit regardless of age");
  assert.match(r?.[0] ?? "", /互关结构/);
  assert.match(r?.[0] ?? "", /回关/);
});

test("对称大网络但简介干净、无话术 → 不命中（防误伤正常互粉用户）", () => {
  assert.equal(
    matchAifarmHeuristic(
      sig({
        accountAgeDays: 1750,
        statusesCount: 24000,
        followersCount: 5953,
        followingCount: 5714,
        isVerified: true,
        bio: "插画师，接稿请私信",
        recentTweets: ["new painting, oil on canvas", "commissions open this month"],
      }),
    ),
    null,
  );
});

test("互关结构 + 蓝标 + 24h 可见 10 条 → 命中（话术缺席的多维度叠加）", () => {
  const r = matchAifarmHeuristic(
    sig({
      accountAgeDays: 1000,
      statusesCount: 9000,
      followersCount: 2100,
      followingCount: 2300,
      isVerified: true,
      bio: "日常记录",
      recentPosts24h: 12,
    }),
  );
  assert.ok(r);
  assert.match(r?.[0] ?? "", /24h/);
});

test("24h 爆发但非对称网络或未开会员 → 不命中", () => {
  assert.equal(
    matchAifarmHeuristic(
      sig({
        accountAgeDays: 1000,
        statusesCount: 9000,
        followersCount: 90000,
        followingCount: 300,
        isVerified: true,
        recentPosts24h: 12,
        bio: "日常记录",
      }),
    ),
    null,
  );
  assert.equal(
    matchAifarmHeuristic(
      sig({
        accountAgeDays: 1000,
        statusesCount: 9000,
        followersCount: 2100,
        followingCount: 2300,
        recentPosts24h: 12,
        bio: "日常记录",
      }),
    ),
    null,
  );
});

test("小号互粉（不足 800）不判互关农场", () => {
  assert.equal(
    matchAifarmHeuristic(
      sig({
        accountAgeDays: 100,
        statusesCount: 300,
        followersCount: 120,
        followingCount: 130,
        bio: "互关互fo",
      }),
    ),
    null,
  );
});
