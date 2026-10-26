// 内置 aifarm 启发式（lib/aifarm-heuristic.ts）的精度边界：
// 三重确认（年轻 + 非人发帖量 + 养号话术）缺一不可。
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

test("老号高产不命中（<90 天门槛）", () => {
  assert.equal(matchAifarmHeuristic(sig({ accountAgeDays: 400, statusesCount: 20000 })), null);
});

test("年轻但发帖量正常不命中", () => {
  assert.equal(matchAifarmHeuristic(sig({ statusesCount: 300 })), null);
});

test("缺发帖量数据不命中（宁漏勿误）", () => {
  assert.equal(matchAifarmHeuristic(sig({ statusesCount: undefined })), null);
});

test("高频年轻号但简介无养号话术不命中", () => {
  assert.equal(
    matchAifarmHeuristic(sig({ bio: "产品经理，记录日常与思考", displayName: "阿明" })),
    null,
  );
});

test("话术在昵称里也算", () => {
  const r = matchAifarmHeuristic(sig({ bio: "", displayName: "币圈互关哥" }));
  assert.ok(r);
});

test("浇朋友 / 走个面儿 / 串门类模板话术命中", () => {
  for (const bio of ["来我主页浇朋友", "有空走个面儿", "蓝v互关私我"]) {
    assert.ok(matchAifarmHeuristic(sig({ bio })), bio);
  }
});
