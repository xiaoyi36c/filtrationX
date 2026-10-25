// Blacklist one-click block queue (二开: 支持黑名单一键拉黑，但操作不能太快).
//
// The user can bulk-block public-blacklist accounts with their own X session.
// Safety rails, in the order they matter:
//   1. PACING — the background pump waits PUMP_INTERVAL_MS + jitter between
//      requests, ON TOP of lib/x-action's own 800ms+jitter slot pacing and
//      staged cooldowns. One block per ~1.5-2.5s wall-clock (提速后；已封禁/
//      注销的账号走 gone 缓存瞬时跳过，不占节奏).
//   2. GONE CACHE — accounts X answered 404 for (suspended/deleted) are
//      cached locally; later runs skip them without any request.
//   3. RUN LIMIT — the options page starts a bounded run (100/300/500),
//      never "everything" — the list is 190k+ rows and blocking it all is
//      neither realistic nor safe.
//   4. FAIL-STREAK ABORT — 5 consecutive X errors (login expired, endpoint
//      gone) stop the run instead of hammering.
//
// Execution lives in an open x.com tab's content script (only a page holds
// the ct0 CSRF cookie performXAction needs); the background owns the queue,
// the pacing and the persisted progress, and dispatches one item at a time.
// Everything survives service-worker death: progress is checkpointed to
// storage after every item and a 1-minute watchdog alarm resumes the pump.

import type { LiteRow } from "./list-sync";

export interface BlockQueueItem {
  /** X numeric user id (may be empty when the artifact row has none). */
  u: string;
  /** X handle, lowercase-normalized by the list sync. */
  h: string;
}

export interface BlockQueueState {
  items: BlockQueueItem[];
  cursor: number;
  running: boolean;
  paused: boolean;
  /** Parked because no x.com tab answered; resumes on the next worker hello. */
  needTab: boolean;
  done: number;
  failed: number;
  failStreak: number;
  lastError: string | null;
  startedAt: number | null;
  updatedAt: number;
}

export const BLOCK_QUEUE_KEY = "xss:block-queue:v1";
/** Last x.com content script that said hello (tab id) — the pump's executor. */
export const BLOCK_QUEUE_WORKER_KEY = "xss:block-queue:worker";

/** 已确认被封/注销的账号（X 返回 404）缓存：下次一键拉黑直接跳过，不再
 *  发请求。uid 与 handle 各存一条（同一账号两种键都能命中），按时间淘汰
 *  最旧的，防 storage 无限膨胀。 */
export const GONE_KEY = "xss:block-queue:gone:v1";
const GONE_MAX = 20_000;

export async function getGoneMap(): Promise<Record<string, number>> {
  try {
    const got = await chrome.storage.local.get(GONE_KEY);
    const v = got[GONE_KEY] as Record<string, number> | undefined;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export async function markGoneAccounts(keys: string[]): Promise<void> {
  const clean = [...new Set(keys.map((k) => String(k ?? "").trim()).filter(Boolean))];
  if (!clean.length) return;
  const map = await getGoneMap();
  const now = Date.now();
  for (const k of clean) map[k] = now;
  // 淘汰最旧的，压在上限内。
  let entries = Object.entries(map);
  if (entries.length > GONE_MAX) {
    entries.sort((x, y) => x[1] - y[1]);
    entries = entries.slice(entries.length - GONE_MAX);
  }
  const out: Record<string, number> = {};
  for (const [k, ts] of entries) out[k] = ts;
  try {
    await chrome.storage.local.set({ [GONE_KEY]: out });
  } catch {
    /* non-fatal */
  }
}

/** 泵的节流间隔。2026-10-25 应用户要求提速：2500+1200 → 800+400，
 *  叠加 x-action 槽位后约 1.5–2.5 秒/个（原 ~4.6 秒）。404 死号命中
 *  gone 缓存瞬时跳过，不占这个节奏。 */
export const PUMP_INTERVAL_MS = 800;
export const PUMP_JITTER_MS = 400;
// 2026-10 二开调整：按用户要求移除每日配额（DAILY_CAP）。防风控仍由
// 节奏限速（pump 间隔 + x-action 冷却）和失败熔断负责；单次运行数量
// 仍由 options 页的 RUN_LIMITS 限定。
export const MAX_FAIL_STREAK = 5;
export const MAX_QUEUE_ITEMS = 5000;
/** Run-size choices offered by the options page. */
export const RUN_LIMITS = [100, 300, 500] as const;

export function emptyBlockQueue(): BlockQueueState {
  return {
    items: [],
    cursor: 0,
    running: false,
    paused: false,
    needTab: false,
    done: 0,
    failed: 0,
    failStreak: 0,
    lastError: null,
    startedAt: null,
    updatedAt: 0,
  };
}

export async function getBlockQueue(): Promise<BlockQueueState> {
  try {
    const got = await chrome.storage.local.get(BLOCK_QUEUE_KEY);
    const v = got[BLOCK_QUEUE_KEY] as Partial<BlockQueueState> | undefined;
    if (!v || !Array.isArray(v.items)) return emptyBlockQueue();
    return { ...emptyBlockQueue(), ...v, items: v.items as BlockQueueItem[] };
  } catch {
    return emptyBlockQueue();
  }
}

export async function saveBlockQueue(q: BlockQueueState): Promise<void> {
  q.updatedAt = Date.now();
  await chrome.storage.local.set({ [BLOCK_QUEUE_KEY]: q });
}

/** Pick up to `limit` runnable items from the synced lite artifact, skipping
 *  anything already handled locally (processed records) or protected
 *  (whitelist entries, both uid and handle). */
export function buildBlockQueueItems(
  rows: LiteRow[],
  limit: number,
  skip: Set<string>,
): BlockQueueItem[] {
  const cap = Math.min(Math.max(1, Math.floor(limit) || 100), MAX_QUEUE_ITEMS);
  const items: BlockQueueItem[] = [];
  for (const row of rows) {
    if (items.length >= cap) break;
    if (!Array.isArray(row) || row.length < 2) continue;
    const uid = typeof row[0] === "string" ? row[0].trim() : "";
    const handle = typeof row[1] === "string" ? row[1].trim().replace(/^@+/, "").toLowerCase() : "";
    if (!uid && !handle) continue;
    if (skip.has(uid) || skip.has(handle)) continue;
    items.push({ u: uid, h: handle });
  }
  return items;
}

/** A response shape the content script returns per dispatched item. */
export interface BlockQueueExecResult {
  ok?: boolean;
  retryable?: boolean;
  status?: number;
  skipped?: boolean;
  /** X returned 404 — the account is already suspended/deleted, so the goal
   *  is already achieved. Counted as done, never as a failure (a run of
   *  already-gone accounts used to trip the circuit breaker instantly). */
  gone?: boolean;
}
