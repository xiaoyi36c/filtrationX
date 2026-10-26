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
