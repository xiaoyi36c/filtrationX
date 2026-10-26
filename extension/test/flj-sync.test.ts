// flj.info（福利鉴）榜单解析 + 关注队列构建（lib/flj-sync.ts）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFollowQueue, mergeCategoryResults, parseRankingsPayload } from "../lib/flj-sync";

const SAMPLE = {
  items: [
    {
      twitter_username: "GoodGirl",
      display_name: "Good Girl",
      score: 88.5,
      is_fushi: false,
      has_threshold: false,
      is_welfare: true,
      negative_tags: [],
      positive_tags: ["verified_real", "recommended"],
      score_detail: {
        followers: 123456,
        engagement: "high",
        bio: "hi",
        is_welfare: true,
        positive_types: ["praised"],
        account_tags: ["福利博主", "可线下"],
      },
      avatar_url: "https://pbs.twimg.com/profile_images/x.jpg",
    },
    {
      twitter_username: "Scam_Bot",
      display_name: "骗子",
      score: 12,
      is_fushi: true,
      has_threshold: true,
      negative_tags: ["scam", "stolen_photo"],
      positive_tags: [],
      score_detail: { followers: 900, engagement: "low" },
    },
    { twitter_username: "bad handle with spaces" }, // 非法 handle → 跳过
    { display_name: "no handle" }, // 缺 handle → 跳过
    null, // 坏行 → 跳过
  ],
  total: 141,
  page: 1,
  pageSize: 50,
};

test("parseRankingsPayload：字段映射 + 坏行容错", () => {
  const { bloggers, total, page, pageSize } = parseRankingsPayload(SAMPLE);
  assert.equal(bloggers.length, 2);
  assert.equal(total, 141);
  assert.equal(page, 1);
  assert.equal(pageSize, 50);
  const [good, scam] = bloggers;
  assert.equal(good?.h, "goodgirl"); // handle 统一小写
  assert.equal(good?.n, "Good Girl");
  assert.equal(good?.welfare, true); // score_detail.is_welfare
  assert.equal(good?.verifiedReal, true);
  assert.equal(good?.followers, 123456);
  assert.equal(good?.neg.length, 0);
  assert.deepEqual(good?.pos, ["verified_real", "recommended", "praised"]);
  assert.deepEqual(good?.tags, ["福利博主", "可线下"]);
  assert.equal(scam?.h, "scam_bot");
  assert.equal(scam?.fushi, true);
  assert.equal(scam?.threshold, true);
  assert.deepEqual(scam?.neg, ["scam", "stolen_photo"]);
});

test("parseRankingsPayload：非对象/缺 items 返回空", () => {
  assert.equal(parseRankingsPayload(null).bloggers.length, 0);
  assert.equal(parseRankingsPayload({}).bloggers.length, 0);
  assert.equal(parseRankingsPayload({ items: "nope" }).bloggers.length, 0);
});

test("buildFollowQueue：默认排除负面标签，max 截断", () => {
  const parsed = parseRankingsPayload(SAMPLE).bloggers;
  const q = buildFollowQueue(parsed, { skipNegative: true, max: 10 });
  assert.deepEqual(
    q.map((b) => b.h),
    ["goodgirl"],
  );
  // 关闭排除 → 两条都进队列
  const q2 = buildFollowQueue(parsed, { skipNegative: false, max: 10 });
  assert.equal(q2.length, 2);
  // max 截断
  const q3 = buildFollowQueue(parsed, { skipNegative: false, max: 1 });
  assert.equal(q3.length, 1);
});

test("mergeCategoryResults：跨分类去重、cats 记录、并集合并、按评分降序", () => {
  const merged = mergeCategoryResults([
    {
      category: "comments",
      bloggers: [
        { h: "aaa", n: "甲", score: 80, neg: [], pos: ["recommended"] },
        { h: "bbb", n: "乙", score: 95, neg: [], pos: [] },
      ],
    },
    {
      category: "score",
      bloggers: [
        { h: "aaa", score: 85, neg: [], pos: ["praised"], tags: ["福利博主"] },
        { h: "ccc", n: "丙", score: 70, neg: [], pos: [] },
      ],
    },
    { category: "fushi", bloggers: [{ h: "ddd", n: "丁", score: 60, fushi: true, neg: [], pos: [] }] },
  ]);
  assert.equal(merged.length, 4);
  // 评分降序
  assert.deepEqual(
    merged.map((b) => b.h),
    ["bbb", "aaa", "ccc", "ddd"],
  );
  const aaa = merged.find((b) => b.h === "aaa");
  assert.deepEqual(aaa?.cats, ["comments", "score"]);
  assert.equal(aaa?.score, 85); // 取最高分
  assert.deepEqual(aaa?.pos, ["recommended", "praised"]);
  assert.deepEqual(aaa?.tags, ["福利博主"]);
  assert.equal(merged.find((b) => b.h === "aaa")?.n, "甲"); // 名字保留
});
