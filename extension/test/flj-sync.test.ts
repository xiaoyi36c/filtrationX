// flj.info（福利鉴）榜单解析 + 关注队列构建（lib/flj-sync.ts）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFollowQueue,
  fljTagLabel,
  mergeCategoryResults,
  parseBoomboomArchive,
  parseNsfwPetPage,
  parseRankingsPayload,
} from "../lib/flj-sync";

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

test("parseBoomboomArchive：handle/name/粉丝/相对头像拼接", () => {
  const out = parseBoomboomArchive([
    {
      id: "1090649930031456257",
      screen_name: "Anaimiya",
      name: "Naimi奶咪",
      avatar_url: "/api/media?key=avatars%2FAnaimiya_400x400.jpg",
      followers_count: 4327960,
      verified: 1,
      is_suspended: 0,
    },
    { screen_name: "bad handle!" },
    null,
  ]);
  assert.equal(out.length, 1);
  const b = out[0]!;
  assert.equal(b.h, "anaimiya");
  assert.equal(b.n, "Naimi奶咪");
  assert.equal(b.followers, 4327960);
  assert.equal(b.avatar, "https://img.boomboom.nyc.mn/api/media?key=avatars%2FAnaimiya_400x400.jpg");
  assert.equal(b.dead, undefined); // 未标记封禁
  assert.equal(parseBoomboomArchive("nope").length, 0);
});

test("parseBoomboomArchive：is_suspended 预标 dead（0/1 与 true/false 两种形态）", () => {
  const out = parseBoomboomArchive([
    { screen_name: "dead_one", is_suspended: 1 },
    { screen_name: "dead_two", is_suspended: true },
    { screen_name: "alive_one", is_suspended: 0 },
    { screen_name: "alive_two", is_suspended: false },
  ]);
  const byH = new Map(out.map((x) => [x.h, x]));
  assert.equal(byH.get("dead_one")?.dead, true);
  assert.equal(byH.get("dead_two")?.dead, true);
  assert.equal(byH.get("alive_one")?.dead, undefined);
  assert.equal(byH.get("alive_two")?.dead, undefined);
});

test("parseNsfwPetPage：data.creators + meta.has_more/total", () => {
  const { bloggers, hasMore, total } = parseNsfwPetPage({
    data: {
      creators: [
        {
          handle: "@hi_nxxg",
          name: "𝑵",
          followers: 435912,
          verified: true,
          avatarUrl: "https://image.nsfw.pet/avatars/hi_nxxg/x.jpg",
          tags: [],
        },
        { handle: "hi_nxxg" }, // 重复 handle 由 fetch 层去重，解析层照收
      ],
      meta: { total: 299, limit: 20, offset: 40, has_more: true },
    },
  });
  assert.equal(bloggers.length, 2);
  assert.equal(bloggers[0]?.h, "hi_nxxg"); // 去掉 @、小写
  assert.equal(bloggers[0]?.followers, 435912);
  assert.equal(hasMore, true);
  assert.equal(total, 299);
  assert.equal(parseNsfwPetPage(null).bloggers.length, 0);
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

test("mergeCategoryResults：数据源预标 dead 跨分类保留", () => {
  const merged = mergeCategoryResults([
    { category: "boomboom", bloggers: [{ h: "xxx", neg: [], pos: [], dead: true }] },
    { category: "comments", bloggers: [{ h: "xxx", neg: [], pos: [] }] },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.dead, true);
  assert.deepEqual(merged[0]?.cats, ["boomboom", "comments"]);
});

test("fljTagLabel：已知英文/拼写变体翻译成中文，中文原样，噪音返回 null", () => {
  // flj 英文枚举
  assert.equal(fljTagLabel("verified_real"), "实名");
  assert.equal(fljTagLabel("recommended"), "推荐");
  assert.equal(fljTagLabel("praised"), "好评");
  // nsfw.pet 拼写变体
  assert.equal(fljTagLabel("welfre"), "福利");
  assert.equal(fljTagLabel("welfare"), "福利");
  // flj 中文画像标签原样
  assert.equal(fljTagLabel("福利博主"), "福利博主");
  assert.equal(fljTagLabel("可线下"), "可线下");
  // 噪音：语言码 / 未知英文 / 空
  assert.equal(fljTagLabel("ja"), null);
  assert.equal(fljTagLabel("zh"), null);
  assert.equal(fljTagLabel("verified"), null);
  assert.equal(fljTagLabel(""), null);
  // 负面枚举也能翻
  assert.equal(fljTagLabel("stolen_photo"), "盗图");
});
