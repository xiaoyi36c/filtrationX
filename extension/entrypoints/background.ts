// Background service worker: owns the remote blocklist sync (download-only —
// a public artifact GET; nothing about the user is ever uploaded) and serves
// local health/stats lookups for the popup.
import { syncIfStale, syncList } from "../lib/list-sync";
import type { BgRequest, BgResponse } from "../lib/types";

// ---- GitHub Device Flow (v0.4's login interaction, restored for the
// whitelist self-service). Public device-flow client id — NOT a secret
// (device flow has no client secret by design). The fetches live in the
// background because github.com's device endpoints don't serve CORS; the
// options page requests the optional github.com host permission first.
const GH_CLIENT_ID = "Ov23liP2AbdNePTyKUEA";

async function ghStart() {
  // scope "read:user repo" (二开): beyond identity lookup the token now also
  // drives the user's OWN repo keyword-file sync (lib/gh-repo.ts, Contents
  // API). Legacy tokens with read:user keep working for everything except
  // the sync — the options page surfaces a "权限不足，请重新登录" hint.
  const r = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: GH_CLIENT_ID, scope: "read:user repo" }),
  });
  return (await r.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval: number;
  };
}

async function ghPoll(deviceCode: string) {
  const r = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: GH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const j = (await r.json()) as { access_token?: string; error?: string };
  if (!j.access_token) return { pending: j.error ?? "pending" };
  const { setGh } = await import("../lib/auth");
  const u = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${j.access_token}`, accept: "application/vnd.github+json" },
  });
  const user = (await u.json()) as { login?: string };
  await setGh(j.access_token, user.login ?? "github");
  return { login: user.login ?? "github" };
}

const SYNC_ALARM = "xss:list-sync";
// Two-way custom-rules ↔ user's-own-GitHub-repo sync (lib/gh-repo.ts). Same
// 6h cadence as the list sync: a rule edited in the repo file lands on the
// device within the hour-cycle; a rule added locally is pushed immediately
// (the options page does that on save when autoSync is on).
const RULES_SYNC_ALARM = "xss:rules-sync";
const RULES_SYNC_PERIOD_MIN = 360;
// Block-queue watchdog (lib/block-queue.ts): the pump normally self-schedules
// with setTimeout, but MV3 can reap the SW mid-run — this alarm re-enters
// pumpBlockQueue() for the persisted, unfinished queue.
const BLOCK_QUEUE_ALARM = "xss:block-queue";
// Anonymous official-rule-hit telemetry flush (lib/rule-telemetry.ts owns the
// queue/dedup; this alarm just drains it). 30min keeps a lost eager-flush
// from stranding rows for long while staying far from a request storm.
const RULE_HITS_ALARM = "xss:rule-hits";
const RULE_HITS_PERIOD_MIN = 30;
// 6h cadence matches the server's mirror cron; the artifact itself only
// changes when the confirmed set changes, and version-match syncs are a
// single small meta GET.
const SYNC_PERIOD_MIN = 360;

// ---- Blacklist one-click block queue (二开, lib/block-queue.ts) ----
// The background owns the persisted queue and the pacing; execution happens
// in an open x.com tab (only a page holds the ct0 cookie performXAction
// needs). The pump is deliberately SLOW: one item per PUMP_INTERVAL_MS +
// jitter, on top of x-action's own slot pacing, cooldowns and 429 backoff —
// "操作不能太快" is the whole point (X 风控).
let blockQueuePumping = false;
const blockQueueSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pumpBlockQueue(): Promise<void> {
  if (blockQueuePumping) return;
  blockQueuePumping = true;
  try {
    for (;;) {
      const {
        getBlockQueue,
        saveBlockQueue,
        getGoneMap,
        BLOCK_QUEUE_WORKER_KEY,
        MAX_FAIL_STREAK,
        PUMP_INTERVAL_MS,
        PUMP_JITTER_MS,
      } = await import("../lib/block-queue");
      const q = await getBlockQueue();
      if (!q.running || q.paused) return;
      if (q.cursor >= q.items.length) {
        q.running = false;
        q.needTab = false;
        await saveBlockQueue(q);
        return;
      }
      // gone 缓存里的死号（已封禁/注销）瞬时跳过：不发请求、不占节流间隔。
      const gone = await getGoneMap();
      while (q.cursor < q.items.length) {
        const it = q.items[q.cursor]!;
        if (!gone[it.u] && !gone[it.h]) break;
        q.cursor++;
        q.done++;
      }
      if (q.cursor >= q.items.length) {
        q.running = false;
        q.needTab = false;
        await saveBlockQueue(q);
        return;
      }
      const worker = (await chrome.storage.local.get(BLOCK_QUEUE_WORKER_KEY))[
        BLOCK_QUEUE_WORKER_KEY
      ] as { tabId?: number | null } | undefined;
      let res: import("../lib/block-queue").BlockQueueExecResult | null = null;
      if (worker?.tabId) {
        try {
          res = (await chrome.tabs.sendMessage(worker.tabId, {
            type: "block_queue_exec",
            item: q.items[q.cursor],
          })) as import("../lib/block-queue").BlockQueueExecResult;
        } catch {
          res = null; // tab closed / SW of the page gone
        }
      }
      if (!res) {
        // No executor available: park and wait for the next worker hello.
        q.needTab = true;
        q.paused = true;
        q.lastError = "等待一个打开的 x.com 标签页来执行拉黑";
        await saveBlockQueue(q);
        return;
      }
      q.cursor++;
      // skipped = the tab refused (whitelist/protected/self) — not a failure.
      if (res.ok || res.skipped) {
        q.done++;
        q.failStreak = 0;
        q.lastError = null;
      } else {
        q.failed++;
        q.failStreak++;
        q.lastError = res.status ? `X 返回 ${res.status}` : "动作未执行";
      }
      if (!res.ok && !res.skipped && q.failStreak >= MAX_FAIL_STREAK) {
        q.running = false;
        q.paused = false;
        q.lastError = "连续失败过多，已停止——请确认 x.com 仍处于登录状态后重试";
        await saveBlockQueue(q);
        return;
      }
      await saveBlockQueue(q);
      await blockQueueSleep(PUMP_INTERVAL_MS + Math.floor(Math.random() * PUMP_JITTER_MS));
    }
  } finally {
    blockQueuePumping = false;
  }
}

async function blockQueueWatchdog(): Promise<void> {
  const { getBlockQueue } = await import("../lib/block-queue");
  const q = await getBlockQueue();
  if (q.running && !q.paused) void pumpBlockQueue();
}

// ---- 福利鉴博主同步 + 一键关注队列 (二开, lib/flj-sync.ts) ----
// 榜单同步：后台直接 fetch flj.info（公开 JSON，无需登录），页间带间隔。
// 关注队列：与一键拉黑同一套基建——后台泵 + 打开的 x.com 标签页执行 + 持久
// 化进度 + 限流熔断。区别：用户显式点「开始关注」才会跑（绝不自动关注）；
// 已关注/找不到账号这类一次性失败只计数跳过，熔断只看限流类失败。
let fljSyncRunning = false;
let followQueuePumping = false;
const FOLLOW_PUMP_INTERVAL_MS = 1800;
const FOLLOW_PUMP_JITTER_MS = 800;
const FOLLOW_MAX_FAIL_STREAK = 5;

async function pumpFollowQueue(): Promise<void> {
  if (followQueuePumping) return;
  followQueuePumping = true;
  try {
    let failStreak = 0;
    for (;;) {
      const { getFollowQueue, saveFollowQueue } = await import("../lib/flj-sync");
      const { BLOCK_QUEUE_WORKER_KEY } = await import("../lib/block-queue");
      const q = await getFollowQueue();
      if (!q.running) return;
      if (q.cursor >= q.items.length) {
        q.running = false;
        q.finishedAt = Date.now();
        await saveFollowQueue(q);
        return;
      }
      const worker = (await chrome.storage.local.get(BLOCK_QUEUE_WORKER_KEY))[
        BLOCK_QUEUE_WORKER_KEY
      ] as { tabId?: number | null } | undefined;
      type FollowExecResult = { ok?: boolean; retryable?: boolean; skipped?: boolean; status?: number };
      let res: FollowExecResult | null = null;
      if (worker?.tabId) {
        try {
          res = (await chrome.tabs.sendMessage(worker.tabId, {
            type: "follow_queue_exec",
            item: q.items[q.cursor],
          })) as FollowExecResult;
        } catch {
          res = null;
        }
      }
      if (!res) {
        q.running = false;
        q.finishedAt = Date.now();
        q.lastError = "需要打开一个 x.com 标签页来执行关注——打开后重新点「开始关注」会从断点继续";
        await saveFollowQueue(q);
        return;
      }
      q.cursor++;
      if (res.ok || res.skipped) {
        q.done++;
        q.lastError = null;
        failStreak = 0;
      } else {
        q.failed++;
        q.lastError = res.status ? `X 返回 ${res.status}（可能已关注）` : "关注未执行";
        // 熔断只看限流类失败（retryable = 429/5xx 等）；「已关注」这类
        // 一次性失败只计数跳过，别把整个队列打断。
        if (res.retryable) failStreak++;
      }
      if (failStreak >= FOLLOW_MAX_FAIL_STREAK) {
        q.running = false;
        q.finishedAt = Date.now();
        q.lastError = "连续限流失败过多，已停止——稍后再试";
        await saveFollowQueue(q);
        return;
      }
      await saveFollowQueue(q);
      await blockQueueSleep(FOLLOW_PUMP_INTERVAL_MS + Math.floor(Math.random() * FOLLOW_PUMP_JITTER_MS));
    }
  } finally {
    followQueuePumping = false;
  }
}

// ---- X 原生拉黑列表同步 (二开, lib/blocks-sync.ts) ----
// Manual paged pull of the user's own blocks via an open x.com tab. Read-only
// GETs with a short inter-page delay; the accumulated list is checkpointed to
// storage after every page so a reaped SW loses at most one page.
let blocksSyncRunning = false;

async function runBlocksSync(): Promise<void> {
  if (blocksSyncRunning) return;
  blocksSyncRunning = true;
  try {
    let rateLimitRetries = 0;
    for (;;) {
      const {
        getXBlocksData,
        saveXBlocksData,
        getXBlocksSyncState,
        saveXBlocksSyncState,
        X_BLOCKS_MAX_USERS,
        X_BLOCKS_PAGE_DELAY_MS,
        X_BLOCKS_PAGE_JITTER_MS,
      } = await import("../lib/blocks-sync");
      const { BLOCK_QUEUE_WORKER_KEY } = await import("../lib/block-queue");
      const st = await getXBlocksSyncState();
      if (!st.running) return;
      const worker = (await chrome.storage.local.get(BLOCK_QUEUE_WORKER_KEY))[
        BLOCK_QUEUE_WORKER_KEY
      ] as { tabId?: number | null } | undefined;
      if (!worker?.tabId) {
        st.lastError = "等待一个打开的 x.com 标签页";
        await saveXBlocksSyncState(st);
        return; // resumes on the next worker hello / watchdog tick
      }
      let res: { users?: { u: string; h: string }[]; next_cursor?: string; error?: string } | null =
        null;
      try {
        res = (await chrome.tabs.sendMessage(worker.tabId, {
          type: "blocks_sync_fetch",
          cursor: st.nextCursor ?? "-1",
        })) as { users?: { u: string; h: string }[]; next_cursor?: string; error?: string };
      } catch {
        res = null;
      }
      if (!res || res.error) {
        // 限流不算失败：等一分钟原地重试同一游标（最多 3 次），游标保留，
        // 用户之后再点「重新同步」也能从断点继续。
        if (res?.error === "rate_limited" && rateLimitRetries < 3) {
          rateLimitRetries++;
          st.lastError = null;
          await saveXBlocksSyncState(st);
          await blockQueueSleep(60_000);
          continue;
        }
        st.running = false;
        st.finishedAt = Date.now();
        st.lastError = !res ? "x.com 标签页不可用，请打开 x.com 后重试" : (res.error ?? "unknown");
        await saveXBlocksSyncState(st);
        return;
      }
      rateLimitRetries = 0;
      st.pages++;
      const data = await getXBlocksData();
      // 按 u/h 去重（含历史遗留的重复项）：blocks/list 按拉黑时间倒序，
      // 从头重拉的旧实现把重复账号一次次追加进来，count 因此虚高。
      const seen = new Set<string>();
      data.users = data.users.filter((x) => {
        const k = x.u || x.h;
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      for (const u of res.users ?? []) {
        if (data.users.length >= X_BLOCKS_MAX_USERS) break;
        const k = u.u || u.h;
        if (!k || seen.has(k)) continue;
        seen.add(k);
        data.users.push({ u: u.u, h: u.h });
      }
      data.syncedAt = Date.now();
      await saveXBlocksData(data);
      st.fetched = data.users.length;
      const next = String(res.next_cursor ?? "0");
      if (next === "0" || data.users.length >= X_BLOCKS_MAX_USERS) {
        st.running = false;
        st.finishedAt = Date.now();
        st.nextCursor = null;
        st.lastError = null;
        await saveXBlocksSyncState(st);
        return;
      }
      st.nextCursor = next;
      await saveXBlocksSyncState(st);
      await blockQueueSleep(X_BLOCKS_PAGE_DELAY_MS + Math.floor(Math.random() * X_BLOCKS_PAGE_JITTER_MS));
    }
  } finally {
    blocksSyncRunning = false;
  }
}

async function blocksSyncWatchdog(): Promise<void> {
  const { getXBlocksSyncState } = await import("../lib/blocks-sync");
  const st = await getXBlocksSyncState();
  if (st.running) void runBlocksSync();
}

export default defineBackground(() => {
  const ensureAlarm = () => {
    try {
      chrome.alarms.create(SYNC_ALARM, {
        periodInMinutes: SYNC_PERIOD_MIN,
        delayInMinutes: 1,
      });
      chrome.alarms.create(RULE_HITS_ALARM, {
        periodInMinutes: RULE_HITS_PERIOD_MIN,
        delayInMinutes: 5,
      });
      chrome.alarms.create(RULES_SYNC_ALARM, {
        periodInMinutes: RULES_SYNC_PERIOD_MIN,
        delayInMinutes: 2,
      });
      chrome.alarms.create(BLOCK_QUEUE_ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
    } catch {
      /* non-fatal */
    }
  };

  chrome.runtime.onInstalled.addListener(() => {
    ensureAlarm();
    void syncList(true); // fresh install / update → fetch immediately
  });
  chrome.runtime.onStartup.addListener(() => {
    ensureAlarm();
    void syncIfStale();
  });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === SYNC_ALARM) void syncList();
    if (a.name === RULE_HITS_ALARM) {
      void import("../lib/rule-telemetry").then(({ flushRuleHits }) => flushRuleHits());
    }
    if (a.name === RULES_SYNC_ALARM) {
      void import("../lib/gh-repo")
        .then(({ syncRulesIfConfigured }) =>
          import("../lib/local-rules").then(({ saveCustomRules }) =>
            syncRulesIfConfigured(saveCustomRules),
          ),
        )
        .then((out) => {
          if (out && !out.ok) console.warn("[mxga] rules repo sync:", out.error);
        });
    }
    if (a.name === BLOCK_QUEUE_ALARM) {
      void blockQueueWatchdog();
      void blocksSyncWatchdog();
    }
  });

  chrome.runtime.onMessage.addListener(
    (msg: BgRequest, s: chrome.runtime.MessageSender, sendResponse: (r: BgResponse) => void) => {
      (async () => {
        try {
          if (msg.type === "local-data") {
            const { handleLocalDataMutation } = await import("../lib/local-data-background");
            sendResponse({ ok: true, data: await handleLocalDataMutation(msg.mutation) });
          } else if (msg.type === "health") {
            const { indexSize, warmLocalIndex } = await import("../lib/local-index");
            const { getStoredList } = await import("../lib/list-sync");
            await warmLocalIndex();
            const stored = await getStoredList();
            sendResponse({
              ok: true,
              data: {
                records: stored?.count ?? indexSize(),
                listVersion: stored?.version ?? null,
                listFetchedAt: stored?.fetchedAt ?? null,
              },
            });
          } else if (msg.type === "list-sync") {
            sendResponse({ ok: true, data: await syncList(!!msg.force) });
          } else if (msg.type === "stats") {
            const { getStats } = await import("../lib/stats");
            sendResponse({ ok: true, data: await getStats() });
          } else if (msg.type === "records") {
            sendResponse({ ok: true, data: { records: [] } });
          } else if (msg.type === "rule-hit") {
            const { enqueueRuleHit, flushRuleHits } = await import("../lib/rule-telemetry");
            const pressured = await enqueueRuleHit(msg.hit);
            if (pressured) void flushRuleHits();
            sendResponse({ ok: true });
          } else if (msg.type === "gh_start") {
            sendResponse({ ok: true, data: await ghStart() });
          } else if (msg.type === "gh_poll") {
            sendResponse({ ok: true, data: await ghPoll(msg.deviceCode) });
          } else if (msg.type === "auth_status") {
            const { getGhToken } = await import("../lib/auth");
            sendResponse({ ok: true, data: { authenticated: !!(await getGhToken()) } });
          } else if (msg.type === "open_options") {
            chrome.runtime.openOptionsPage();
            sendResponse({ ok: true });
          } else if (msg.type === "classify") {
            const { getGhToken } = await import("../lib/auth");
            const { edgeBase } = await import("../lib/list-sync");
            const { postOnlineClassification } = await import("../lib/online-detection");
            sendResponse(
              await postOnlineClassification({
                base: await edgeBase(),
                token: (await getGhToken()) || null,
                sig: msg.sig,
              }),
            );
          } else if (msg.type === "report") {
            // Authenticated POST /v1/report from the SHARED extension origin
            // (same path the whitelist-apply flow uses), not the content
            // script — x.com's CORS/CSP would otherwise block it.
            const { getGhToken } = await import("../lib/auth");
            const { edgeBase } = await import("../lib/list-sync");
            const token = await getGhToken();
            if (!token) {
              sendResponse({ ok: false, error: "no_token" });
            } else {
              const base = await edgeBase();
              const res = await fetch(`${base}/v1/report`, {
                method: "POST",
                headers: {
                  authorization: `Bearer ${token}`,
                  "content-type": "application/json",
                },
                // The reporter's own category claim rides along as
                // reportCategory (edge: stored in the report evidence and
                // used as the queued row's category when nothing else set one).
                body: JSON.stringify({
                  ...msg.sig,
                  ...(msg.category ? { reportCategory: msg.category } : {}),
                }),
              });
              let body: unknown = {};
              try {
                body = await res.json();
              } catch {
                /* non-JSON error page */
              }
              sendResponse({ ok: true, data: { status: res.status, body } });
            }
          } else if (msg.type === "block_queue_hello") {
            // An x.com tab announced itself as the executor. Remember it and
            // unpark a queue that was waiting for a tab.
            const { BLOCK_QUEUE_WORKER_KEY, getBlockQueue, saveBlockQueue } = await import(
              "../lib/block-queue"
            );
            await chrome.storage.local.set({
              [BLOCK_QUEUE_WORKER_KEY]: { tabId: s.tab?.id ?? null, at: Date.now() },
            });
            const q = await getBlockQueue();
            if (q.running && q.paused && q.needTab) {
              q.paused = false;
              q.needTab = false;
              q.lastError = null;
              await saveBlockQueue(q);
              void pumpBlockQueue();
            }
            sendResponse({ ok: true });
          } else if (msg.type === "block_queue_start") {
            const { getStoredList, getStoredWhitelist } = await import("../lib/list-sync");
            const { getBlocklist } = await import("../lib/store");
            const { buildBlockQueueItems, getBlockQueue, saveBlockQueue } = await import(
              "../lib/block-queue"
            );
            const skip = new Set<string>();
            for (const r of await getBlocklist()) if (r.id) skip.add(r.id);
            for (const [uid, handle] of (await getStoredWhitelist())?.entries ?? []) {
              if (uid) skip.add(uid);
              skip.add(handle.toLowerCase());
            }
            const items = buildBlockQueueItems(
              (await getStoredList())?.entries ?? [],
              msg.limit,
              skip,
            );
            if (!items.length) {
              sendResponse({ ok: false, error: "名单中没有可执行的新条目（可能都已处理过）" });
            } else {
              const q = await getBlockQueue();
              q.items = items;
              q.cursor = 0;
              q.done = 0;
              q.failed = 0;
              q.failStreak = 0;
              q.running = true;
              q.paused = false;
              q.needTab = false;
              q.lastError = null;
              q.startedAt = Date.now();
              await saveBlockQueue(q);
              sendResponse({ ok: true, data: { total: items.length } });
              void pumpBlockQueue();
            }
          } else if (msg.type === "block_queue_stop") {
            const { getBlockQueue, saveBlockQueue } = await import("../lib/block-queue");
            const q = await getBlockQueue();
            q.running = false;
            q.paused = false;
            q.needTab = false;
            await saveBlockQueue(q);
            sendResponse({ ok: true });
          } else if (msg.type === "block_queue_pause") {
            const { getBlockQueue, saveBlockQueue } = await import("../lib/block-queue");
            const q = await getBlockQueue();
            q.paused = msg.paused;
            if (!msg.paused) {
              q.needTab = false;
              q.lastError = null;
            }
            await saveBlockQueue(q);
            sendResponse({ ok: true });
            if (!msg.paused) void pumpBlockQueue();
          } else if (msg.type === "block_queue_status") {
            const { getBlockQueue } = await import("../lib/block-queue");
            sendResponse({ ok: true, data: await getBlockQueue() });
          } else if (msg.type === "flj_sync_start") {
            if (fljSyncRunning) {
              sendResponse({ ok: true, syncing: true });
            } else {
              fljSyncRunning = true;
              sendResponse({ ok: true, syncing: true });
              void (async () => {
                const { fetchAllFljCategories, getFljData, saveFljData } = await import("../lib/flj-sync");
                try {
                  const { bloggers } = await fetchAllFljCategories((m) =>
                    console.debug("[MXGA] flj", m),
                  );
                  const prev = await getFljData();
                  await saveFljData({
                    syncedAt: bloggers.length ? Date.now() : prev.syncedAt,
                    total: bloggers.length,
                    bloggers: bloggers.length ? bloggers : prev.bloggers,
                  });
                } catch (e) {
                  console.warn("[MXGA] flj sync failed", e);
                } finally {
                  fljSyncRunning = false;
                }
              })();
            }
          } else if (msg.type === "flj_status") {
            const { getFljData } = await import("../lib/flj-sync");
            sendResponse({ ok: true, data: { flj: await getFljData(), syncing: fljSyncRunning } });
          } else if (msg.type === "follow_queue_start") {
            const { getFljData, buildFollowQueue, getFollowQueue, saveFollowQueue } = await import(
              "../lib/flj-sync"
            );
            const data = await getFljData();
            if (!data.bloggers.length) {
              sendResponse({ ok: false, error: "先同步福利鉴榜单" });
            } else {
              const items = buildFollowQueue(data.bloggers, {
                skipNegative: msg.skipNegative !== false,
                max: msg.max ?? 50,
              });
              if (!items.length) {
                sendResponse({ ok: false, error: "筛选后没有可关注的博主" });
              } else {
                const q = await getFollowQueue();
                q.items = items.map((b) => ({ h: b.h, ...(b.n ? { n: b.n } : {}) }));
                q.cursor = 0;
                q.done = 0;
                q.failed = 0;
                q.running = true;
                q.lastError = null;
                q.finishedAt = null;
                await saveFollowQueue(q);
                sendResponse({ ok: true, data: { total: items.length } });
                void pumpFollowQueue();
              }
            }
          } else if (msg.type === "follow_queue_stop") {
            const { getFollowQueue, saveFollowQueue } = await import("../lib/flj-sync");
            const q = await getFollowQueue();
            q.running = false;
            q.finishedAt = Date.now();
            await saveFollowQueue(q);
            sendResponse({ ok: true });
          } else if (msg.type === "follow_queue_status") {
            const { getFollowQueue } = await import("../lib/flj-sync");
            sendResponse({ ok: true, data: await getFollowQueue() });
          } else if (msg.type === "blocks_sync_start") {
            const { getXBlocksSyncState, saveXBlocksSyncState } = await import("../lib/blocks-sync");
            const st = await getXBlocksSyncState();
            if (!st.running) {
              st.running = true;
              st.pages = 0;
              // 断点续传：上次因限流/标签页丢失而中断时，游标还停在断点，
              // 就从那里继续拉，而不是每次都从第一页重拉——重拉既烧掉
              // X 的限流额度（用户看到的「每次只同步前几页」），又会把
              // 同一批账号重复追加进本地列表。自然跑完的任务 nextCursor
              // 已被置 null，这里会正常从头开始。
              if (!st.nextCursor || st.nextCursor === "-1") {
                st.nextCursor = "-1";
                st.fetched = 0;
              }
              st.lastError = null;
              st.finishedAt = null;
              await saveXBlocksSyncState(st);
              void runBlocksSync();
            }
            sendResponse({ ok: true, data: st });
          } else if (msg.type === "blocks_sync_status") {
            const { getXBlocksSyncState } = await import("../lib/blocks-sync");
            sendResponse({ ok: true, data: await getXBlocksSyncState() });
          } else if (msg.type === "x_unblock_exec") {
            const { BLOCK_QUEUE_WORKER_KEY } = await import("../lib/block-queue");
            const worker = (await chrome.storage.local.get(BLOCK_QUEUE_WORKER_KEY))[
              BLOCK_QUEUE_WORKER_KEY
            ] as { tabId?: number | null } | undefined;
            if (!worker?.tabId) {
              sendResponse({ ok: false, error: "no_tab" });
            } else {
              try {
                sendResponse(
                  (await chrome.tabs.sendMessage(worker.tabId, {
                    type: "x_unblock_exec",
                    u: msg.u,
                    h: msg.h,
                  })) as BgResponse,
                );
              } catch {
                sendResponse({ ok: false, error: "no_tab" });
              }
            }
          } else {
            sendResponse({ ok: false, error: "unknown message" });
          }
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      })();
      return true; // async response
    },
  );
});
