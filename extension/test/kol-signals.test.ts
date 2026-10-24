import assert from "node:assert/strict";
import test from "node:test";
import {
  clearKolSignals,
  kolSignalsFor,
  kolSignalsStats,
  MIN_TWEETS_FOR_RATIO,
  type KolSignalEntry,
  noteKolSample,
  tokenize,
  trustAssessment,
  warmKolSignals,
} from "../lib/kol-signals";

function installChrome() {
  const root = globalThis as unknown as { chrome?: unknown };
  const previous = root.chrome;
  const bag: Record<string, unknown> = {};
  root.chrome = {
    storage: {
      local: {
        get: async (k: string) => ({ [k]: bag[k] }),
        set: async (obj: Record<string, unknown>) => Object.assign(bag, obj),
        remove: async (...keys: string[]) => {
          for (const k of keys) delete bag[k];
        },
      },
    },
  };
  return {
    bag,
    restore() {
      if (previous === undefined) delete root.chrome;
      else root.chrome = previous;
    },
  };
}

test("tokenize: latin words and CJK bigrams, noise dropped", () => {
  assert.deepEqual(tokenize("crypto airdrop now!!"), ["crypto", "airdrop", "now"]);
  assert.ok(tokenize("区块链空投").includes("区块"));
  assert.ok(tokenize("区块链空投").includes("链空"));
  assert.deepEqual(tokenize("a 42 x"), ["42"], "single letters dropped, multi-digit numbers kept");
  assert.ok(tokenize("Free NFT giveaway 100x").includes("100"), "multi-digit numbers kept");
});

test("sampling dedupes by statusId and computes originalRatio", () => {
  for (let i = 0; i < MIN_TWEETS_FOR_RATIO + 1; i++) {
    noteKolSample({ handle: "koldup", statusId: `${100 + i}`, original: true, text: `post number ${i} about fishing` });
  }
  // same tweet re-scanned → no double count
  noteKolSample({ handle: "koldup", statusId: "100", original: true, text: "post number 0 about fishing" });
  const r = kolSignalsFor("KolDup");
  assert.equal(r.sampledTweets, MIN_TWEETS_FOR_RATIO + 1);
  assert.equal(r.originalRatio, 1);
});

test("retweets count against the retweeter via rt: ids", () => {
  noteKolSample({ handle: "rter", statusId: "rt:900", original: false });
  noteKolSample({ handle: "rter", statusId: "rt:900", original: false });
  noteKolSample({ handle: "rter", statusId: "rt:901", original: false });
  for (const extra of [902, 903, 904]) {
    noteKolSample({ handle: "rter", statusId: `rt:${extra}`, original: false });
  }
  const r = kolSignalsFor("rter");
  assert.equal(r.sampledTweets, 5, "duplicate rt:900 counted once");
  assert.equal(r.originalRatio, 0);
});

test("topic focus separates a one-topic account from a chatty one", () => {
  for (let i = 0; i < 10; i++) {
    noteKolSample({
      handle: "monotopic",
      statusId: `m${i}`,
      original: true,
      text: "比特币行情分析 今日比特币走势 比特币涨跌",
    });
  }
  const chatTopics = [
    "今天天气晴朗适合出门散步",
    "新上映的电影剧情非常精彩",
    "晚餐做了意大利面味道不错",
    "周末去山里徒步风景很好",
    "最近在读一本历史书很入迷",
    "这款新手机拍照效果真不错",
    "昨晚的演唱会现场太燃了",
    "健身房里练背才是王道",
    "旅行攻略做了一大堆",
    "猫咪今天又打翻了花瓶",
  ];
  chatTopics.forEach((text, i) => {
    noteKolSample({ handle: "chatty", statusId: `c${i}`, original: true, text });
  });
  const mono = kolSignalsFor("monotopic").topicFocus;
  const chat = kolSignalsFor("chatty").topicFocus;
  assert.ok(mono !== undefined && chat !== undefined);
  assert.ok(mono > chat, `monotopic (${mono}) should focus more than chatty (${chat})`);
  assert.ok(mono > 0.5);
});

test("insufficient samples report nothing; trust falls back to neutral", () => {
  assert.deepEqual(kolSignalsFor("neverseen"), {});
  noteKolSample({ handle: "few", statusId: "f1", original: true, text: "只有一条" });
  assert.equal(kolSignalsFor("few").originalRatio, undefined);
  const t = trustAssessment({ accountAgeDays: 400, followersCount: 5000, followingCount: 100 });
  assert.ok(t.score > 50, "mature healthy account scores above neutral");
});

test("trust assessment bands: farm / like-farm / dead-engagement / solid", () => {
  // follow-back farm: follows 5000, followed by 300
  const farm = trustAssessment({ accountAgeDays: 400, followersCount: 300, followingCount: 5000 });
  assert.ok(farm.tier === "warn" || farm.tier === "risk");
  // like-farming: 30k likes vs 1k followers — engagement signal alone drags
  // it below the "ok" bar (age/network still score neutral-ish).
  const liker = trustAssessment({ accountAgeDays: 400, followersCount: 1000, favouritesCount: 30000 });
  assert.ok(liker.score < 55, `expected below ok, got ${liker.score}`);
  const likerYoung = trustAssessment({
    accountAgeDays: 20,
    followersCount: 1000,
    favouritesCount: 30000,
    originalRatio: 0.1,
  });
  assert.equal(likerYoung.tier, "risk", "like-farm + young + repost-only → risk");
  // brand-new account — the age signal alone drags it out of the safe band
  const fresh = trustAssessment({ accountAgeDays: 3, followersCount: 10, followingCount: 5 });
  assert.ok(fresh.score < 55, `expected warn band, got ${fresh.score}`);
  // healthy established account with enough samples
  const solid = trustAssessment({
    accountAgeDays: 1500,
    followersCount: 8000,
    followingCount: 300,
    statusesCount: 4200,
    favouritesCount: 20000,
    originalRatio: 0.95,
  });
  assert.ok(solid.score >= 75, `expected safe, got ${solid.score}`);
  // M4 transparency: per-dimension parts ride along and neutral = 50
  assert.equal(solid.parts.age, 85);
  assert.equal(solid.parts.original, 80);
  const blank = trustAssessment({});
  assert.ok(blank.score >= 45 && blank.score <= 60, `neutral-ish, got ${blank.score}`);
  assert.equal(blank.parts.age, 50);
  assert.equal(blank.parts.network, 50);
  assert.equal(blank.parts.engagement, 50);
  assert.equal(blank.parts.original, 50);
});

test("storage roundtrip: warm reloads live entries, drops expired", async () => {
  const env = installChrome();
  try {
    const DAY = 86_400_000;
    const now = Date.now();
    const live: KolSignalEntry = {
      handle: "liveacct",
      total: 8,
      original: 6,
      seen: [],
      tokens: { 区块: 4, 链空: 2 },
      tokenTotal: 6,
      updatedAt: now - DAY,
    };
    const expired: KolSignalEntry = { ...live, handle: "oldacct", updatedAt: now - 10 * DAY };
    const stored: Record<string, unknown> = JSON.parse(
      JSON.stringify({ liveacct: live, oldacct: expired }),
    );
    // Simulate a JSON-parsed "__proto__" key (own property, not the setter).
    Object.defineProperty(stored, "__proto__", { value: live, enumerable: true });
    env.bag["xss:kol:v1"] = stored;
    await warmKolSignals();
    const r = kolSignalsFor("liveacct");
    assert.equal(r.sampledTweets, 8);
    assert.equal(r.originalRatio, 0.75);
    assert.equal(kolSignalsFor("oldacct").originalRatio, undefined, "expired entry ignored");
  } finally {
    env.restore();
  }
});

test("stats and clear work against storage (options-page side)", async () => {
  const env = installChrome();
  try {
    const DAY = 86_400_000;
    const now = Date.now();
    const entry = (handle: string, total: number, updatedAt: number): KolSignalEntry => ({
      handle,
      total,
      original: Math.floor(total / 2),
      seen: [],
      tokens: {},
      tokenTotal: 0,
      updatedAt,
    });
    env.bag["xss:kol:v1"] = {
      "a": entry("a", 9, now - DAY),
      "b": entry("b", 3, now),
    };
    const s = await kolSignalsStats();
    assert.equal(s.accounts, 2);
    assert.equal(s.samples, 12);
    assert.equal(s.labeled, 1, "only the 9-sample account reached the reportable bar");
    assert.equal(s.latestTs, now);
    await clearKolSignals();
    assert.equal(env.bag["xss:kol:v1"], undefined);
    const after = await kolSignalsStats();
    assert.equal(after.accounts, 0);
    assert.equal(after.samples, 0);
  } finally {
    env.restore();
  }
});
