// flj.info（福利鉴）榜单解析 + 关注队列构建（lib/flj-sync.ts）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFollowQueue, parseRankingsPayload } from "../lib/flj-sync";

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
      score_detail: { followers: 123456, engagement: "high", bio: "hi" },
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
  assert.equal(good?.welfare, true);
  assert.equal(good?.verifiedReal, true);
  assert.equal(good?.followers, 123456);
  assert.equal(good?.neg.length, 0);
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
