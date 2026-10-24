import assert from "node:assert/strict";
import test from "node:test";
import { HttpError, ReadLimiter } from "../lib/read-limiter";
import { computeMetrics, parseUserTweets, type RawTweetRow } from "../lib/x-graphql";

test("read limiter serializes calls with a minimum interval", async () => {
  const lim = new ReadLimiter(40, 60_000);
  const starts: number[] = [];
  const t0 = Date.now();
  await Promise.all([
    lim.run(async () => void starts.push(Date.now() - t0)),
    lim.run(async () => void starts.push(Date.now() - t0)),
    lim.run(async () => void starts.push(Date.now() - t0)),
  ]);
  assert.equal(starts.length, 3);
  assert.ok(starts[1]! - starts[0]! >= 30, `call2 waited: ${starts[1]! - starts[0]!}`);
  assert.ok(starts[2]! - starts[1]! >= 30, `call3 waited: ${starts[2]! - starts[1]!}`);
});

test("read limiter enters cooldown on 429 and refuses until it passes", async () => {
  const lim = new ReadLimiter(5, 120);
  let calls = 0;
  await assert.rejects(
    lim.run(async () => {
      calls += 1;
      throw new HttpError(429, "rate limited");
    }),
    (e: HttpError) => e.status === 429,
  );
  assert.ok(lim.cooling);
  await assert.rejects(lim.run(async () => (calls += 1)), /rate_limited/);
  assert.equal(calls, 1, "no request fires during cooldown");
  await new Promise((r) => setTimeout(r, 140));
  assert.ok(!lim.cooling, "cooldown expires");
  assert.equal(await lim.run(async () => calls + 1), 2);
});

test("read limiter keeps the chain alive after a failure", async () => {
  const lim = new ReadLimiter(1, 60_000);
  await assert.rejects(lim.run(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await lim.run(async () => "ok"), "ok");
});

function tweet(entryId: string, likes: number, replies: number, rts: number, isRt = false) {
  return {
    entryId,
    content: {
      itemContent: {
        tweet_results: {
          result: {
            __typename: "Tweet",
            legacy: {
              favorite_count: likes,
              reply_count: replies,
              retweet_count: rts,
              ...(isRt ? { retweeted_status_result: { result: { legacy: {} } } } : {}),
            },
          },
        },
      },
    },
  };
}

test("parseUserTweets handles tweet entries, conversation modules and junk", () => {
  const rows = parseUserTweets({
    data: {
      user: {
        result: {
          timeline_v2: {
            timeline: {
              instructions: [
                {
                  type: "TimelineAddEntries",
                  entries: [
                    tweet("tweet-1", 10, 2, 1),
                    { entryId: "cursor-bottom-0", content: {} },
                    {
                      entryId: "profile-conversation-9",
                      content: {
                        entryType: "TimelineTimelineModule",
                        items: [
                          // 模块内条目的形状：{ item: { itemContent: … } }
                          { item: { itemContent: { tweet_results: { result: { __typename: "Tweet", legacy: { favorite_count: 4, reply_count: 0, retweet_count: 0 } } } } } },
                          { item: {} },
                          { item: { itemContent: { tweet_results: { result: { __typename: "Tweet", legacy: { favorite_count: 8, reply_count: 1, retweet_count: 2, retweeted_status_result: { result: { legacy: {} } } } } } } } },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { likes: 10, replies: 2, rts: 1, isRetweet: false });
  assert.equal(rows[2]!.isRetweet, true);
  assert.deepEqual(parseUserTweets({ data: null }), []);
  assert.deepEqual(parseUserTweets(undefined), []);
});

test("computeMetrics: medians (odd/even) and precise original ratio", () => {
  const rows: RawTweetRow[] = [
    { likes: 5, replies: 1, rts: 0, isRetweet: false },
    { likes: 9, replies: 2, rts: 3, isRetweet: false },
    { likes: 20, replies: 4, rts: 6, isRetweet: true },
    { likes: 100, replies: 8, rts: 10, isRetweet: false },
  ];
  const m = computeMetrics(rows)!;
  assert.equal(m.tweets, 4);
  assert.equal(m.medianLikes, 15); // sorted [5,9,20,100] -> (9+20)/2 rounded
  assert.equal(m.originalRatio, 0.75);
});