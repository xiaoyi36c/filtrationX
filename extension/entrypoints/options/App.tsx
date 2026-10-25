import { useEffect, useMemo, useRef, useState } from "react";
import { clearGh, getGhLogin, getGhToken, ghUser, setGh } from "../../lib/auth";
import {
  type BackupFile,
  type BackupSection,
  type BackupSummary,
  type ImportMode,
  backupFileName,
  exportBackup,
  importBackup,
  parseBackup,
  presentBackupSections,
  summarize,
} from "../../lib/backup";
import { BRAND } from "../../lib/brand";
import { resolveLocale, tr as trL, UI_LOCALES, type UiLocale } from "../../lib/i18n";
import { D as UI_D } from "../../lib/ui-strings";
import {
  clearKolSignals,
  type KolSignalsStats,
  kolSignalsStats,
} from "../../lib/kol-signals";
import { clearPreciseCache } from "../../lib/x-graphql";
import { CATEGORY_ZH, SPAM_CATEGORIES, type SpamCategory, categoryFromCode } from "../../lib/category";
import {
  type CustomRule,
  MAX_CUSTOM_RULES,
  type RuleField,
  getCustomRules,
  getDisabledPatterns,
  saveCustomRules,
  saveDisabledPatterns,
} from "../../lib/local-rules";
import { categorizeReason, categorizeReasons } from "../../lib/reason-category";
import { RUN_LIMITS, type BlockQueueState } from "../../lib/block-queue";
import {
  type XBlockedUser,
  type XBlocksData,
  type XBlocksSyncState,
  blocksSyncErrorText,
  getXBlocksData,
  removeXBlockedUser,
} from "../../lib/blocks-sync";
import {
  DEFAULT_SYNC_CONFIG,
  type RulesSyncConfig,
  getRulesSyncConfig,
  saveRulesSyncConfig,
  pushRules,
  pullRules,
  syncRules,
  verifyRepoAccess,
} from "../../lib/gh-repo";
import {
  type ActionMode,
  type CategoryAction,
  type Settings,
  getSettings,
  onSettingsChange,
  setCategoryAction,
  setSetting,
} from "../../lib/settings";
import { getStoredList, getStoredWhitelist } from "../../lib/list-sync";
import {
  LOCAL_WL_KEY,
  type LocalWhitelistEntry,
  MAX_LOCAL_WHITELIST,
  addLocalWhitelist,
  clearExcluded,
  listExcluded,
  listLocalWhitelist,
  normalizeWhitelistHandle,
  removeLocalWhitelist,
} from "../../lib/local-whitelist";
import {
  type BlockRecord,
  type CacheRow,
  clearAllLocal,
  getBlocklist,
  getCacheRows,
  getStats,
  removeBlock,
  tweetUrl,
} from "../../lib/store";
import { clearDetectionCache } from "../../lib/cache";
import type { Label } from "../../lib/types";

const REPO = BRAND.repo;
const EDGE_DEFAULT = BRAND.edgeBase;

/** Pre-filled GitHub false-positive appeal for a listed account — matches the
 *  content-script's openAppeal so both entries land on the same filled form. */
function appealUrl(handle: string, userId?: string): string {
  const p = new URLSearchParams();
  p.set("handle", `@${handle}`);
  if (userId && /^\d+$/.test(userId)) p.set("userid", userId);
  p.set("title", `[Appeal] @${handle} wrongly listed`);
  return `${BRAND.appealNewIssue}&${p.toString()}`;
}

const whenFull = (ts: number) => new Date(ts).toLocaleString("zh-CN", { hour12: false });
/** Table-cell timestamp: current-year dates drop the year, no seconds —
 *  keeps the 时间 column narrow; hover (title=whenFull) has the rest. */
const when = (ts: number) => {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString("zh-CN", {
    hour12: false,
    ...(sameYear ? {} : { year: "numeric" }),
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};
const idTail = (id: string, h: string) =>
  /^\d+$/.test(id) && id !== h && !/^\d+$/.test(h) ? ` · ${id}` : "";

const TAG: Record<Label, [string, string]> = {
  spam: ["text-danger", "垃圾"],
  porn_bot: ["text-violet", "色情bot"],
  likely_spam: ["text-warn", "疑似垃圾"],
  uncertain: ["text-fg-3", "不确定"],
  legit: ["text-ok", "正常"],
};
const Tag = ({ label, conf }: { label: Label; conf?: number }) => {
  const [cls, zh] = TAG[label] ?? ["text-fg-3", label];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-current px-2 py-0.5 text-[11px] font-semibold tracking-[0.02em] ${cls}`}
    >
      {zh}
      {conf !== undefined ? (
        <span className="font-mono text-[10.5px] opacity-80">
          {(conf * 100).toFixed(0)}%
        </span>
      ) : null}
    </span>
  );
};

/**
 * Themed confirm modal — replaces native window.confirm so destructive
 * actions read in the same visual language as the rest of the options panel.
 * Backdrop-blur card; Esc cancels, Enter confirms; focus trap on the
 * primary button after mount; respects prefers-reduced-motion via CSS.
 */
function ConfirmDialog({
  open,
  title,
  body,
  okLabel = "确认",
  cancelLabel = "取消",
  variant = "primary",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: React.ReactNode;
  okLabel?: string;
  cancelLabel?: string;
  variant?: "primary" | "danger" | "ok";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => okRef.current?.focus(), 40);
    function key(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      }
    }
    document.addEventListener("keydown", key, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", key, true);
    };
  }, [open, onCancel, onConfirm]);

  if (!open) return null;
  const okClass =
    variant === "danger"
      ? "bg-danger text-white border-danger hover:opacity-90 font-semibold"
      : variant === "ok"
        ? "border-ok/40 text-ok hover:bg-ok-soft"
        : "bg-fg text-bg border-fg hover:opacity-90 font-semibold";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="mxgaConfirmTitle"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-[420px] overflow-hidden rounded-lg border border-border-2 bg-bg shadow-[0_24px_64px_rgba(0,0,0,0.45)]">
        <h3
          id="mxgaConfirmTitle"
          className="px-5 pb-1.5 pt-5 text-[15px] font-semibold tracking-tight"
        >
          {title}
        </h3>
        <div className="px-5 pb-4 text-[13px] leading-relaxed text-fg-2">{body}</div>
        <div className="flex justify-end gap-2 border-t border-border bg-card px-5 py-3.5">
          <button
            type="button"
            className="rounded-md border border-border-2 px-3 py-1.5 text-[12px] text-fg-2 transition hover:bg-card-hi"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            ref={okRef}
            type="button"
            className={`rounded-md border px-3 py-1.5 text-[12px] transition min-w-[72px] ${okClass}`}
            onClick={onConfirm}
          >
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const Avatar = ({ url, name }: { url?: string; name?: string }) => {
  const mono = (name || "?").replace(/^@/, "").charAt(0).toUpperCase();
  return url ? (
    <img
      src={url}
      referrerPolicy="no-referrer"
      alt=""
      className="h-7 w-7 flex-none rounded-full bg-card-hi object-cover"
    />
  ) : (
    <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-card-hi text-xs font-bold text-fg-3">
      {mono}
    </span>
  );
};

/** Avatar wrapped in an X profile link — supports manual review by click. */
const AvatarLink = ({ handle, url, name }: { handle: string; url?: string; name?: string }) => (
  <a
    href={`https://x.com/${encodeURIComponent(handle)}`}
    target="_blank"
    rel="noopener"
    className="flex-none rounded-full ring-offset-1 transition hover:ring-2 hover:ring-accent/50"
    title={`去 @${handle} 的 X 主页`}
  >
    <Avatar url={url} name={name} />
  </a>
);

/** Plain @handle link with hover-to-accent. */
const HandleLink = ({ handle, className = "" }: { handle: string; className?: string }) => (
  <a
    href={`https://x.com/${encodeURIComponent(handle)}`}
    target="_blank"
    rel="noopener"
    className={`transition hover:text-accent ${className}`}
    title={`去 @${handle} 的 X 主页`}
  >
    @{handle}
  </a>
);

/** Display chip for a verdict reason — categorizes the raw English LLM
 *  output into a small Chinese class. The full reason is in title= for hover. */
const ReasonChip = ({
  raw,
  reasons,
}: {
  raw?: string | null;
  reasons?: readonly (string | null | undefined)[];
}) => {
  const cat = reasons ? categorizeReasons(reasons) : categorizeReason(raw);
  const display = (reasons?.filter(Boolean) as string[] | undefined)?.join("\n") || raw || "";
  // Tone → explicit classes (Tailwind v4 needs literal strings to detect)
  const tone =
    cat.tone === "violet"
      ? "text-violet border-violet/40 bg-violet/[0.08]"
      : cat.tone === "warn"
        ? "text-warn border-warn/40 bg-warn/[0.08]"
        : cat.tone === "danger"
          ? "text-danger border-danger/40 bg-danger/[0.08]"
          : cat.tone === "amber"
            ? "text-warn border-warn/30 bg-warn/[0.06]"
            : cat.tone === "neutral"
              ? "text-fg-2 border-border-2 bg-card-hi"
              : "text-fg-3 border-border bg-card";
  return (
    <span
      title={display || "无原因记录"}
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold tracking-[0.02em] ${tone}`}
    >
      {cat.zh}
    </span>
  );
};

type BtnTier = "primary" | "default" | "ghost" | "danger";
function Btn({
  tier = "default",
  size = "md",
  className = "",
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tier?: BtnTier;
  size?: "sm" | "md";
}) {
  const tone =
    tier === "primary"
      ? "bg-fg text-bg border-fg hover:opacity-90 font-semibold"
      : tier === "danger"
        ? "border-danger/35 bg-transparent text-danger hover:bg-danger-soft hover:border-danger/55"
        : tier === "ghost"
          ? "border-transparent bg-transparent text-fg-2 hover:bg-card-hi hover:text-fg"
          : "border-border-2 bg-transparent text-fg hover:bg-card-hi hover:border-fg-3";
  const px = size === "sm" ? "px-2.5 py-1 text-[12px] rounded-sm" : "px-3 py-1.5 text-[13px] rounded-md";
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex cursor-pointer items-center justify-center gap-1.5 border font-medium leading-none transition-[background,border-color,transform,color] active:translate-y-px ${px} ${tone} ${className}`}
    >
      {children}
    </button>
  );
}

/** 全局文案钩子（二开 M4.5）：跟随设置 uiLocale（auto=浏览器语言）。
 *  t("key") 取 ui-strings.ts 字典，支持 {var} 插值；缺 key 原样返回。 */
function useT() {
  const [pref, setPref] = useState<UiLocale>("auto");
  useEffect(() => {
    let alive = true;
    void getSettings().then((s) => {
      if (alive) setPref(s.uiLocale);
    });
    const off = onSettingsChange((s) => setPref(s.uiLocale));
    return () => {
      alive = false;
      off();
    };
  }, []);
  const loc = resolveLocale(pref);
  const t = (key: string, vars?: Record<string, string | number>) => {
    const row = UI_D[key];
    if (!row) return key;
    let s = trL(loc, row);
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };
  return { t, loc };
}

const Page = ({
  title,
  sub,
  children,
}: { title: string; sub?: string; children?: React.ReactNode }) => (
  <main className="mxga-page w-full min-w-0 max-w-[1160px] flex-1 px-4 py-5 sm:px-6 md:px-9 md:py-8">
    <h1 className="text-[26px] font-semibold tracking-[-0.015em] text-fg">{title}</h1>
    {sub && <div className="mb-7 mt-1.5 text-[13px] text-fg-3">{sub}</div>}
    {children}
  </main>
);

const SectionH = ({ children }: { children: React.ReactNode }) => (
  <h2 className="mb-4 mt-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-3">
    {children}
  </h2>
);

const td = "border-b border-border px-3 py-2.5 align-middle whitespace-nowrap";
const th = `${td} text-left text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-3`;
const trHover = "transition hover:bg-card-hi";

const CAT_COLOR: Record<string, string> = {
  porn: "#a855f7",
  crypto: "#f59e0b",
  gambling: "#ec4899",
  resource: "#3b82f6",
  marketing: "#ef4444",
  other: "#71717a",
};

const relTime = (ts: number | null | undefined): string => {
  if (!ts) return "从未";
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
};

interface ListState {
  black: number;
  white: number;
  version: string | null;
  fetchedAt: number | null;
  rules: number;
  catDist: Record<string, number>;
}

async function readListState(): Promise<ListState> {
  const [list, wl] = await Promise.all([getStoredList(), getStoredWhitelist()]);
  const catDist: Record<string, number> = {};
  if (list) {
    for (const e of list.entries) {
      const code = String(e[2])[1] ?? "o";
      catDist[code] = (catDist[code] ?? 0) + 1;
    }
  }
  return {
    black: list?.count ?? 0,
    white: wl?.count ?? 0,
    version: list?.version ?? null,
    fetchedAt: list?.fetchedAt ?? null,
    rules: list?.rules?.length ?? 0,
    catDist,
  };
}

/** 名单状态卡：黑/白名单规模、版本、同步时间 + 手动「立即更新」。 */
function ListStatusCard({ ls, onRefreshed }: { ls: ListState; onRefreshed: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = (await chrome.runtime.sendMessage({ type: "list-sync", force: true })) as {
        ok: boolean;
        data?: { updated?: boolean; black?: number; white?: number; error?: string };
        error?: string;
      };
      const d = r?.data;
      if (r?.ok && d && !d.error) {
        setMsg(d.updated ? `已更新 · 黑名单 ${d.black?.toLocaleString()} 条` : "已是最新版本");
        onRefreshed();
      } else {
        setMsg(`更新失败：${d?.error ?? r?.error ?? "未知错误"}`);
      }
    } catch (e) {
      setMsg(`更新失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="list-status-card mb-8 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <div className="list-status-summary flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[13px]">
        <span className="list-status-stat">
          <b className="font-mono text-[16px] tabular-nums">{ls.black.toLocaleString("zh-CN")}</b>
          <span className="ml-1 text-fg-3">黑名单</span>
        </span>
        <span className="list-status-stat">
          <b className="font-mono text-[16px] tabular-nums">{ls.white.toLocaleString("zh-CN")}</b>
          <span className="ml-1 text-fg-3">白名单</span>
        </span>
        <span className="list-status-stat">
          <b className="font-mono text-[16px] tabular-nums">{ls.rules}</b>
          <span className="ml-1 text-fg-3">检测规则</span>
        </span>
        <span className="list-status-meta text-[12px] text-fg-3">
          上次同步 {relTime(ls.fetchedAt)}
          {ls.version ? ` · ${ls.version.slice(0, 14)}…` : ""} · 每 6 小时自动同步
        </span>
      </div>
      <div className="list-status-actions flex items-center gap-3">
        {msg && <span className="text-[12px] text-fg-3">{msg}</span>}
        <Btn onClick={refresh} disabled={busy}>
          {busy ? "同步中…" : "立即更新"}
        </Btn>
      </div>
    </div>
  );
}

/** 本地 X 账号黑名单（二开）：识别你 X 账号原生已拉黑的账号——数量 + 详细
 *  列表。真值在 X 侧，新装显示 0，点「同步拉黑列表」通过打开的 x.com 标签页
 *  分页拉取（只读 GET，页间短暂停顿），结果存本机、不上传。另附本机处理
 *  记录计数（含一键拉黑队列的落账），明细在「处理记录」tab。 */
function LocalBlocklistCard({ localCount }: { localCount: number }) {
  const [data, setData] = useState<XBlocksData | null>(null);
  const [sync, setSync] = useState<XBlocksSyncState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const bg = (m: unknown) =>
    new Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }>((res) => {
      try {
        chrome.runtime.sendMessage(m, (r) => res(r ?? { ok: false, error: "no response" }));
      } catch (e) {
        res({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const r = await bg({ type: "blocks_sync_status" });
      if (alive && r?.ok) setSync(r.data as unknown as XBlocksSyncState);
      if (alive) setData(await getXBlocksData());
    };
    void tick();
    const t = setInterval(() => void tick(), 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const start = async () => {
    setErr(null);
    setBusy(true);
    try {
      if (!(await ensureXPermission())) {
        setErr("需要 x.com 访问权限才能读取你的拉黑列表，请授权后重试。");
        return;
      }
      await bg({ type: "blocks_sync_start" });
    } finally {
      setBusy(false);
    }
  };

  const count = data?.count ?? 0;
  const syncing = !!sync?.running;

  return (
    <div className="local-blocklist-card mb-6 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="text-[13px] font-semibold text-fg">本地 X 账号黑名单</span>
          <span className="text-[13px]">
            <b className="font-mono text-[16px] tabular-nums text-fg">{count.toLocaleString("zh-CN")}</b>
            <span className="ml-1 text-fg-3">个账号</span>
          </span>
          <span className="text-[12px] text-fg-3">
            你 X 账号已原生拉黑的账号
            {data?.syncedAt ? ` · 同步于 ${relTime(data.syncedAt)}` : " · 尚未同步"}
            {` · 仅存本机`}
          </span>
        </div>
        <div className="flex flex-none items-center gap-2">
          <Btn tier="primary" onClick={() => void start()} disabled={busy || syncing}>
            {syncing ? "同步中…" : count > 0 ? "重新同步" : "同步拉黑列表"}
          </Btn>
          <a href="?tab=xblocks" className="flex-none text-[12px] text-fg-3 hover:text-fg">
            明细与解除拉黑 →
          </a>
        </div>
      </div>
      {syncing && (
        <div className="mt-2 text-[12px] text-fg-2">
          正在从 X 分页拉取 · 已获取 {sync?.fetched.toLocaleString("zh-CN") ?? 0} 个（{sync?.pages ?? 0} 页）
          ——请保持一个 x.com 标签页打开
        </div>
      )}
      {!syncing && sync?.lastError && (
        <div className="mt-2 text-[12px] text-danger">{blocksSyncErrorText(sync.lastError)}</div>
      )}
      {err && <div className="mt-2 text-[12px] text-danger">{err}</div>}
      <div className="mt-2 border-t border-border pt-2 text-[12px] text-fg-3">
        本机处理记录 {localCount.toLocaleString("zh-CN")} 条（含一键拉黑队列落账）·
        <a href="?tab=blocklist" className="ml-1 text-fg-2 hover:text-fg">
          明细见「处理记录」→
        </a>
      </div>
    </div>
  );
}

/** X 拉黑（二开）：你 X 账号原生已拉黑的账号列表（只读同步）。
 *  误拉黑的账号可直接「解除拉黑」——走你的 X 登录态调用 X 的
 *  blocks/destroy，与拉黑同一套限速队列（防风控）。 */
function XBlocksPage() {
  const { t } = useT();
  const [data, setData] = useState<XBlocksData | null>(null);
  const [sync, setSync] = useState<XBlocksSyncState | null>(null);
  const [q, setQ] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const bg = (m: unknown) =>
    new Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }>((res) => {
      try {
        chrome.runtime.sendMessage(m, (r) => res(r ?? { ok: false, error: "no response" }));
      } catch (e) {
        res({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const r = await bg({ type: "blocks_sync_status" });
      if (alive && r?.ok) setSync(r.data as unknown as XBlocksSyncState);
      if (alive) setData(await getXBlocksData());
    };
    void tick();
    const t = setInterval(() => void tick(), 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const start = async () => {
    setErr(null);
    setSyncBusy(true);
    try {
      if (!(await ensureXPermission())) {
        setErr("需要 x.com 访问权限才能读取你的拉黑列表，请授权后重试。");
        return;
      }
      await bg({ type: "blocks_sync_start" });
    } finally {
      setSyncBusy(false);
    }
  };

  const unblock = async (u: XBlockedUser) => {
    const key = u.u || u.h;
    setBusyId(key);
    setMsg(null);
    try {
      const r = await bg({ type: "x_unblock_exec", u: u.u, h: u.h });
      const d = r?.data as { ok?: boolean; status?: number } | undefined;
      if (r?.ok && d?.ok) {
        await removeXBlockedUser(u.u, u.h);
        await getXBlocksData().then(setData);
        setMsg({ text: `@${u.h || u.u} 已解除拉黑，X 上立即生效。`, ok: true });
      } else if (r?.error === "no_tab") {
        setMsg({ text: "需要一个打开的 x.com 标签页来执行解除拉黑。", ok: false });
      } else if (d?.status === 401 || d?.status === 403) {
        setMsg({ text: "X 登录态已失效，请在浏览器重新登录 X 后重试。", ok: false });
      } else {
        setMsg({ text: `解除失败${d?.status ? `（X 返回 ${d.status}）` : ""}，请稍后重试。`, ok: false });
      }
    } finally {
      setBusyId(null);
    }
  };

  const users = data?.users ?? [];
  const rows = useMemo(
    () =>
      users.filter((u) =>
        `${u.h} ${u.n ?? ""} ${u.u}`.toLowerCase().includes(q.toLowerCase()),
      ),
    [users, q],
  );
  const syncing = !!sync?.running;

  return (
    <Page
      title={t("page.xblocks.title")}
      sub={t("xb.count", { n: (data?.count ?? 0).toLocaleString("en-US") })}
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          aria-label={t("page.xblocks.title")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("xb.search")}
          className="w-full max-w-[320px] rounded-md border border-border-2 bg-transparent px-3 py-2 text-[13px] outline-none transition focus:border-accent"
        />
        <Btn tier="primary" onClick={() => void start()} disabled={syncBusy || syncing}>
          {syncing ? t("xb.syncing") : data?.syncedAt ? t("xb.resync") : t("xb.syncNow")}
        </Btn>
        {syncing && (
          <span className="text-[12px] text-fg-2">
            {t("xb.fetched", { n: sync?.fetched.toLocaleString("en-US") ?? "0", p: sync?.pages ?? 0 })}
          </span>
        )}
        {!syncing && sync?.lastError && (
          <span className="text-[12px] text-danger">{blocksSyncErrorText(sync.lastError)}</span>
        )}
        {err && <span className="text-[12px] text-danger">{err}</span>}
      </div>
      {msg && <p className={`mb-4 text-[12px] ${msg.ok ? "text-ok" : "text-danger"}`}>{msg.text}</p>}
      {rows.length === 0 ? (
        <p className="py-10 text-center text-[13px] text-fg-3">
          {data?.syncedAt ? t("xb.emptyNone") : t("xb.emptyNever")}
        </p>
      ) : (
        <div className="desktop-record-table overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[680px] border-collapse text-[13px]">
            <thead className="bg-card">
              <tr>
                <th className={th}>账号</th>
                <th className={th}>X ID</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const key = u.u || u.h;
                return (
                  <tr key={key} className={trHover}>
                    <td className={td}>
                      <div className="flex min-w-0 items-center gap-2.5">
                        <AvatarLink handle={u.h} url={u.a} name={u.n || u.h} />
                        <div className="min-w-0">
                          <div className="max-w-[220px] truncate font-semibold tracking-[-0.005em]">
                            {u.n ? (
                              <a
                                href={`https://x.com/${encodeURIComponent(u.h || u.u)}`}
                                target="_blank"
                                rel="noopener"
                                className="text-fg transition hover:text-accent"
                                title={`去 @${u.h || u.u} 的 X 主页`}
                              >
                                {u.n}
                              </a>
                            ) : (
                              <HandleLink handle={u.h || u.u} className="text-fg" />
                            )}
                          </div>
                          <div className="max-w-[220px] truncate text-[12px] text-fg-3">
                            <HandleLink handle={u.h || u.u} className="text-fg-3" />
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className={`${td} font-mono text-[12px] text-fg-3`}>{u.u || "—"}</td>
                    <td className={`${td} text-right`}>
                      <Btn tier="danger" onClick={() => void unblock(u)} disabled={busyId === key}>
                        {busyId === key ? "解除中…" : "解除拉黑"}
                      </Btn>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && data.count > rows.length && (
        <p className="mt-3 text-[12px] text-fg-3">
          搜索过滤后显示 {rows.length.toLocaleString("zh-CN")} 个（全部 {data.count.toLocaleString("zh-CN")} 个）。
        </p>
      )}
    </Page>
  );
}

/** 黑名单一键拉黑任务卡（二开）：把公共黑名单条目用你的 X 登录态批量拉黑。
 *  节奏由后台严格控制（每个约 3.7-5 秒、连续失败自动停止），无每日数量上限，
 *  需要保持一个打开的 x.com 标签页作为执行器。 */
function BlockQueueCard() {
  const [q, setQ] = useState<BlockQueueState | null>(null);
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState<number>(RUN_LIMITS[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const bg = (m: unknown) =>
    new Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }>((res) => {
      try {
        chrome.runtime.sendMessage(m, (r) => res(r ?? { ok: false, error: "no response" }));
      } catch (e) {
        res({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const r = await bg({ type: "block_queue_status" });
      if (alive && r?.ok) setQ(r.data as unknown as BlockQueueState);
    };
    void tick();
    const t = setInterval(() => void tick(), 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const total = q?.items.length ?? 0;
  const processed = q?.cursor ?? 0;
  const active = !!(q?.running || q?.paused);

  const start = async () => {
    setErr(null);
    setBusy(true);
    try {
      if (!(await ensureXPermission())) {
        setErr("需要 x.com 访问权限才能调用 X 的拉黑接口，请授权后重试。");
        return;
      }
      const r = await bg({ type: "block_queue_start", limit });
      if (!r?.ok) {
        setErr(r?.error ?? "启动失败");
        return;
      }
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (m: unknown) => {
    setBusy(true);
    try {
      await bg(m);
      const r = await bg({ type: "block_queue_status" });
      if (r?.ok) setQ(r.data as unknown as BlockQueueState);
    } finally {
      setBusy(false);
    }
  };

  const statusText = (() => {
    if (!q || total === 0) return null;
    if (q.running) return `执行中 · 已处理 ${q.cursor}/${total}（成功 ${q.done} · 失败 ${q.failed}）`;
    if (q.paused) {
      if (q.needTab) return `已暂停 · 等待 x.com 标签页——打开任意 x.com 页面即自动继续（${q.cursor}/${total}）`;
      return `已暂停 · ${q.lastError ?? ""}（${q.cursor}/${total}）`;
    }
    if (q.cursor >= total && total > 0) {
      return `已完成 · 成功 ${q.done} · 失败 ${q.failed}${q.lastError ? ` · ${q.lastError}` : ""}`;
    }
    return q.lastError ? `已停止 · ${q.lastError}（${q.cursor}/${total}）` : `已停止（${q.cursor}/${total}）`;
  })();

  return (
    <div className="block-queue-card mb-6 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-[220px] flex-1">
          <div className="text-[13px] font-semibold text-fg">黑名单一键拉黑</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-fg-3">
            用你的 X 登录态把名单里的账号原生拉黑。节奏刻意放慢（每个约 4 秒），无每日数量上限；执行期间请保持一个 x.com 标签页打开。
          </p>
        </div>
        <div className="flex flex-none items-center gap-2">
          {!active && (
            <Btn tier="primary" onClick={() => setOpen((v) => !v)}>
              {open ? "收起" : "一键拉黑"}
            </Btn>
          )}
          {q?.running && (
            <Btn onClick={() => void setStatus({ type: "block_queue_pause", paused: true })} disabled={busy}>
              暂停
            </Btn>
          )}
          {q?.paused && !q.needTab && (
            <Btn tier="primary" onClick={() => void setStatus({ type: "block_queue_pause", paused: false })} disabled={busy}>
              继续
            </Btn>
          )}
          {active && (
            <Btn tier="danger" onClick={() => void setStatus({ type: "block_queue_stop" })} disabled={busy}>
              停止
            </Btn>
          )}
        </div>
      </div>
      {statusText && <div className="mt-2 text-[12px] text-fg-2">{statusText}</div>}
      {open && !active && (
        <div className="mt-3 rounded-md border border-border-2 p-3">
          <p className="text-[12px] leading-relaxed text-fg-3">
            拉黑是 X 原生操作、跨设备生效且对方可见，<b className="text-fg-2">误伤需在 X 上手动解除</b>。
            名单按顺序执行，已处理过和白名单账号自动跳过。为避免触发 X 风控，请勿同时开多个任务，也不要把每次执行数量设得过大。
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-fg-3">本次执行数量：</span>
            {RUN_LIMITS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setLimit(n)}
                className={`rounded-md border px-3 py-1 text-[12px] transition ${
                  limit === n ? "border-fg bg-card-hi text-fg" : "border-border-2 text-fg-3 hover:border-fg-3"
                }`}
              >
                {n}
              </button>
            ))}
            <Btn tier="primary" onClick={() => void start()} disabled={busy}>
              {busy ? "启动中…" : `开始拉黑 ${limit} 个`}
            </Btn>
          </div>
          {err && <p className="mt-2 text-[12px] text-danger">{err}</p>}
        </div>
      )}
    </div>
  );
}

/** 共建状态卡：把「登录 GitHub」重新定位成参与公开收集的入口——未登录讲清
 *  登录能开启什么（在线 AI 检测 + 上报），已登录展示贡献状态。 */
function ContribCard({
  login,
  detections,
  blocked,
}: {
  login: string | null;
  detections: number;
  blocked: number;
}) {
  if (!login) {
    return (
      <div className="contrib-card mb-6 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-card-hi px-5 py-4">
        <div className="min-w-[240px] flex-1">
          <div className="text-[13.5px] font-semibold text-fg">参与共建 · 帮所有人拦住新垃圾号</div>
          <p className="mt-1 text-[12px] leading-relaxed text-fg-3">
            登录 GitHub 后：本地名单没命中的新账号会自动送在线 AI 检测，一键上报进入公共审核队列——
            你刷到的每个新垃圾号，复核后全体用户受益。只提交垃圾账号的公开资料，不含你的 X 身份。
          </p>
        </div>
        <a href="?tab=whitelist" className="flex-none">
          <Btn tier="primary">用 GitHub 登录，开启共建</Btn>
        </a>
      </div>
    );
  }
  return (
    <div className="contrib-card mb-6 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border px-5 py-4">
      <div className="min-w-[240px] flex-1">
        <div className="flex items-center gap-2 text-[13.5px] font-semibold text-fg">
          <span className="inline-block h-2 w-2 rounded-full bg-ok" />
          共建已开启 · @{login}
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-fg-3">
          新账号在线 AI 检测运行中；本设备已检测 {detections.toLocaleString("zh-CN")} 次、处理{" "}
          {blocked.toLocaleString("zh-CN")} 个账号。上报与误判申诉随时可用。
        </p>
      </div>
      <a href="?tab=whitelist" className="flex-none text-[12px] text-fg-3 hover:text-fg">
        管理登录 →
      </a>
    </div>
  );
}

function Overview() {
  const { t } = useT();
  const [s, setS] = useState<Awaited<ReturnType<typeof getStats>> | null>(null);
  const [bl, setBl] = useState(0);
  const [autoBl, setAutoBl] = useState(0);
  const [ls, setLs] = useState<ListState | null>(null);
  const [st, setSt] = useState<Settings | null>(null);
  const [ghLogin, setGhLogin] = useState<string | null>(null);
  const loadLists = () => readListState().then(setLs);
  useEffect(() => {
    getStats().then(setS);
    getBlocklist().then((l) => {
      setBl(l.length);
      setAutoBl(l.filter((r) => r.source === "auto").length);
    });
    getSettings().then(setSt);
    getGhLogin().then((v) => setGhLogin(v ?? null));
    void loadLists();
  }, []);
  if (!s) return <Page title={t("page.overview.title")} sub={t("common.loading")} />;
  const d = s.byLabel;
  const total = Object.values(d).reduce((a, b) => a + b, 0) || 1;
  const seg = (k: string, c: string) =>
    d[k] ? (
      <i
        key={k}
        style={{ width: `${((d[k] / total) * 100).toFixed(1)}%`, background: c }}
        className="block h-full"
        title={`${k} · ${d[k]}`}
      />
    ) : null;
  const Card = ({ n, l }: { n: number; l: string }) => (
    <div className="overview-stat-card bg-bg p-5">
      <div className="font-mono text-[28px] font-semibold tabular-nums leading-[1.05] tracking-[-0.02em] text-fg">
        {n.toLocaleString("zh-CN")}
      </div>
      <div className="mt-2 text-[12px] text-fg-3">{l}</div>
    </div>
  );
  const catTotal = ls ? Object.values(ls.catDist).reduce((a, b) => a + b, 0) || 1 : 1;
  const CAT_ORDER: [string, SpamCategory][] = [
    ["p", "porn"],
    ["m", "marketing"],
    ["r", "resource"],
    ["c", "crypto"],
    ["g", "gambling"],
    ["o", "other"],
  ];
  return (
    <Page title={t("page.overview.title")} sub={t("page.overview.sub")}>
      <ContribCard login={ghLogin} detections={s.detections} blocked={bl} />
      {ls && <ListStatusCard ls={ls} onRefreshed={loadLists} />}
      <LocalBlocklistCard localCount={bl} />
      <BlockQueueCard />
      <div className="overview-stats mb-8 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border lg:grid-cols-4">
        <Card n={s.detections} l={t("ov.aiTotal")} />
        <Card n={s.cacheHits} l={t("ov.cacheHits")} />
        <Card n={bl} l={autoBl ? t("ov.processedAuto", { n: autoBl.toLocaleString("en-US") }) : t("ov.processed")} />
        <Card n={(d.spam ?? 0) + (d.porn_bot ?? 0)} l={t("ov.spamPorn")} />
      </div>

      {ls && ls.black > 0 && (
        <div className="mb-8">
          <SectionH>{t("ov.listMakeup")}</SectionH>
          <div className="my-2 flex h-1.5 overflow-hidden rounded-full bg-card">
            {CAT_ORDER.map(([code, cat]) =>
              ls.catDist[code] ? (
                <i
                  key={code}
                  style={{
                    width: `${((ls.catDist[code] / catTotal) * 100).toFixed(1)}%`,
                    background: CAT_COLOR[cat],
                  }}
                  className="block h-full"
                  title={`${CATEGORY_ZH[cat]} · ${ls.catDist[code]}`}
                />
              ) : null,
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[12px] text-fg-3">
            {CAT_ORDER.map(([code, cat]) => (
              <span key={code} className="inline-flex items-center gap-1.5">
                <i className="block h-2 w-2 rounded-full" style={{ background: CAT_COLOR[cat] }} />
                {CATEGORY_ZH[cat]} {(ls.catDist[code] ?? 0).toLocaleString("zh-CN")}
              </span>
            ))}
          </div>
        </div>
      )}

      {st && (
        <div className="mb-8">
          <div className="flex items-baseline justify-between">
            <SectionH>自动处理策略</SectionH>
            <a href="?tab=settings" className="text-[12px] text-fg-3 hover:text-fg">
              {t("ov.adjust")}
            </a>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {SPAM_CATEGORIES.map((cat) => {
              const act = st.categoryActions[cat] ?? "badge";
              const actZh =
                act === "badge" ? t("act.badge") : act === "hide" ? t("act.hide") : act === "mute" ? t("act.mute") : t("act.block");
              return (
                <span
                  key={cat}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] ${
                    act === "badge" ? "border-border-2 text-fg-3" : "border-fg/30 text-fg"
                  }`}
                >
                  <i className="block h-2 w-2 rounded-full" style={{ background: CAT_COLOR[cat] }} />
                  {CATEGORY_ZH[cat]} · {actZh}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <SectionH>{t("ov.catDist")}</SectionH>
      <div className="my-2 flex h-1.5 overflow-hidden rounded-full bg-card">
        {seg("porn_bot", "#a855f7")}
        {seg("spam", "#ef4444")}
        {seg("likely_spam", "#f59e0b")}
        {seg("uncertain", "#71717a")}
        {seg("legit", "#10b981")}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[12px] text-fg-3">
        <span className="inline-flex items-center gap-1.5">
          <i className="block h-2 w-2 rounded-full bg-violet" />
          {t("ov.pornBot")} {d.porn_bot ?? 0}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="block h-2 w-2 rounded-full bg-danger" />
          {t("ov.spam")} {d.spam ?? 0}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="block h-2 w-2 rounded-full bg-warn" />
          {t("ov.likely")} {d.likely_spam ?? 0}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="block h-2 w-2 rounded-full bg-fg-3" />
          {t("ov.uncertain")} {d.uncertain ?? 0}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="block h-2 w-2 rounded-full bg-ok" />
          {t("ov.legit")} {d.legit ?? 0}
        </span>
      </div>
    </Page>
  );
}

function Blocklist() {
  const { t } = useT();
  const [list, setList] = useState<BlockRecord[]>([]);
  const [q, setQ] = useState("");
  const load = () => getBlocklist().then((l) => setList([...l].sort((a, b) => b.ts - a.ts)));
  useEffect(() => void load(), []);
  const rows = useMemo(
    () =>
      list.filter((r) =>
        `${r.handle} ${r.displayName ?? ""} ${r.reason ?? ""}`.toLowerCase().includes(q.toLowerCase()),
      ),
    [list, q],
  );
  // 来源 answers "这条处理是谁触发的" — plain words, config jargon stays in
  // the tooltip. block_all/list_hit/cache_hit only appear on legacy records.
  const src: Record<string, { label: string; hint: string }> = {
    manual: { label: "手动处理", hint: "你在页面上手动点了隐藏 / 静音 / 拉黑" },
    auto: {
      label: "自动处理",
      hint: "命中公共黑名单或官方规则，按「设置 → 自动处理策略」自动执行",
    },
    block_all: { label: "一键处理", hint: "在气泡面板一键处理了本页全部命中（旧版记录）" },
    list_hit: { label: "名单命中", hint: "命中公共黑名单（旧版记录）" },
    cache_hit: { label: "缓存命中", hint: "命中本地检测缓存（旧版记录）" },
  };
  return (
    <Page
      title="处理记录"
      sub={`共 ${list.length} 条 · 记录所有被隐藏 / 静音 / 拉黑的账号 · 恢复显示用于纠正误判（本地恢复可见；X 端的静音 / 拉黑需去 X 手动解除）`}
    >
      <input
        aria-label="搜索处理记录"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜索 @handle / 显示名 / 理由"
        className="mb-4 w-full max-w-[320px] rounded-md border border-border-2 bg-transparent px-3 py-2 text-[13px] outline-none transition focus:border-accent"
      />
      {/* overflow-x-auto（而非 hidden）：窄窗口下表格横向滚动，操作列不再被裁掉 */}
      <div className="desktop-record-table overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[880px] border-collapse text-[13px]">
          <thead className="bg-card">
            <tr>
              <th className={th}>账号</th>
              <th className={th}>判定</th>
              <th className={th}>理由</th>
              <th className={th}>来源</th>
              <th className={th}>时间</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={trHover}>
                <td className={td}>
                  <div className="flex min-w-0 items-center gap-2.5">
                    <AvatarLink
                      handle={r.handle}
                      url={r.avatarUrl}
                      name={r.displayName || r.handle}
                    />
                    <div className="min-w-0">
                      <div className="max-w-[220px] truncate font-semibold tracking-[-0.005em]">
                        {r.displayName ? (
                          <a
                            href={`https://x.com/${encodeURIComponent(r.handle)}`}
                            target="_blank"
                            rel="noopener"
                            className="text-fg transition hover:text-accent"
                            title={`去 @${r.handle} 的 X 主页`}
                          >
                            {r.displayName}
                          </a>
                        ) : /^\d+$/.test(r.handle) ? (
                          // Bare id row (no name captured yet): X resolves
                          // /i/user/<id> to the profile; the name fills in
                          // the next time the account is seen on X.
                          <a
                            href={`https://x.com/i/user/${r.handle}`}
                            target="_blank"
                            rel="noopener"
                            className="text-fg transition hover:text-accent"
                            title="仅记录了账号 ID；下次在 X 上遇到会补全名称"
                          >
                            账号 ID {r.handle}
                          </a>
                        ) : (
                          <HandleLink handle={r.handle} className="text-fg" />
                        )}
                      </div>
                      <div className="max-w-[220px] truncate text-[12px] text-fg-3">
                        {/^\d+$/.test(r.handle) ? (
                          <span>用户名待补全</span>
                        ) : (
                          <HandleLink handle={r.handle} className="text-fg-3" />
                        )}
                        {idTail(r.id, r.handle)}
                      </div>
                    </div>
                  </div>
                </td>
                <td className={td}>
                  {r.verdict ? <Tag label={r.verdict.label} conf={r.verdict.confidence} /> : "—"}
                </td>
                <td className={td}>
                  <div className="flex items-center gap-2">
                    <ReasonChip raw={r.reason} />
                    {tweetUrl(r) && (
                      <a
                        href={tweetUrl(r) as string}
                        target="_blank"
                        rel="noopener"
                        title={r.tweetText ? `触发内容：${r.tweetText}` : "查看触发这次处理的推文"}
                        className="whitespace-nowrap text-[11px] text-fg-3 underline decoration-dotted underline-offset-2 transition hover:text-accent"
                      >
                        查看推文 ↗
                      </a>
                    )}
                  </div>
                  {r.tweetText && (
                    <div
                      className="mt-1 max-w-[260px] truncate text-[11px] text-fg-3"
                      title={r.tweetText}
                    >
                      “{r.tweetText}”
                    </div>
                  )}
                </td>
                <td className={`${td} text-fg-3`}>
                  <span
                    title={src[r.source]?.hint ?? ""}
                    className="inline-flex cursor-help items-center rounded-full border border-border-2 bg-card px-2 py-0.5 text-[11px] text-fg-2"
                  >
                    {src[r.source]?.label ?? r.source}
                  </span>
                </td>
                <td className={`${td} font-mono text-[12px] text-fg-3`} title={whenFull(r.ts)}>
                  {when(r.ts)}
                </td>
                <td className={td}>
                  {/* 纵向堆叠：横排两个操作是表格在 1440 视口下溢出的主因 */}
                  <div className="flex flex-col items-start gap-1">
                    <Btn
                      size="sm"
                      onClick={async () => {
                        await removeBlock(r.id);
                        load();
                      }}
                    >
                      恢复显示
                    </Btn>
                    <a
                      href={appealUrl(r.handle, r.id)}
                      target="_blank"
                      rel="noopener"
                      title="账号被误列？提交申诉（已预填账号信息）"
                      className="whitespace-nowrap text-[11px] text-fg-3 underline decoration-dotted underline-offset-2 transition hover:text-warn"
                    >
                      误判申诉 ↗
                    </a>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mobile-record-list">
        {rows.map((r) => (
          <article key={r.id} className="mobile-record-card">
            <header className="flex items-start gap-3">
              <AvatarLink
                handle={r.handle}
                url={r.avatarUrl}
                name={r.displayName || r.handle}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold text-fg">
                  {r.displayName || `@${r.handle}`}
                </div>
                <HandleLink handle={r.handle} className="text-[12px] text-fg-3" />
              </div>
              {r.verdict && <Tag label={r.verdict.label} conf={r.verdict.confidence} />}
            </header>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <ReasonChip raw={r.reason} />
              {tweetUrl(r) && (
                <a
                  href={tweetUrl(r) as string}
                  target="_blank"
                  rel="noopener"
                  className="text-[12px] text-fg-2 underline decoration-dotted underline-offset-2"
                >
                  查看现场 ↗
                </a>
              )}
            </div>
            {r.tweetText && (
              <p className="mt-2 line-clamp-3 text-[12px] leading-5 text-fg-3">“{r.tweetText}”</p>
            )}
            <footer className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
              <span className="text-[11px] text-fg-3">
                {src[r.source]?.label ?? r.source} · {when(r.ts)}
              </span>
              <div className="flex flex-col items-end gap-1.5">
                <Btn
                  size="sm"
                  className="mobile-record-action"
                  onClick={async () => {
                    await removeBlock(r.id);
                    load();
                  }}
                >
                  恢复显示
                </Btn>
                <a
                  href={appealUrl(r.handle, r.id)}
                  target="_blank"
                  rel="noopener"
                  className="text-[11px] text-fg-3 underline decoration-dotted underline-offset-2"
                >
                  误判申诉 ↗
                </a>
              </div>
            </footer>
          </article>
        ))}
      </div>
      {!list.length && <div className="py-10 text-center text-fg-3">还没有处理记录</div>}
    </Page>
  );
}

function Cache() {
  const { t } = useT();
  const [rows, setRows] = useState<CacheRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const reload = () => void getCacheRows().then(setRows);
  useEffect(() => void reload(), []);
  const clearAll = async () => {
    setBusy(true);
    try {
      const n = await clearDetectionCache();
      setMsg(n > 0 ? `已清空 ${n} 条缓存，下次检测将重新调用 AI` : "缓存本来就是空的");
      reload();
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  };
  return (
    <Page
      title={t("page.cache.title")}
      sub={`共 ${rows.length} 条 · 同一账号再次出现时直接复用判定结果，不再调用 AI`}
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Btn onClick={() => reload()} disabled={busy}>
          刷新
        </Btn>
        <Btn tier="danger" onClick={() => setConfirmOpen(true)} disabled={busy || !rows.length}>
          重置缓存
        </Btn>
        {msg && <span className="text-[12px] text-fg-3">{msg}</span>}
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title="重置检测缓存"
        variant="danger"
        body={
          <>
            清空全部 {rows.length} 条判定缓存。效果：
            <ul className="my-2 list-inside list-disc text-fg-3">
              <li>这些账号再次出现时将重新调用 AI 检测（消耗在线检测额度）</li>
              <li>不影响处理记录、白名单与词库</li>
            </ul>
          </>
        }
        onConfirm={() => void clearAll()}
        onCancel={() => setConfirmOpen(false)}
      />
      <div className="desktop-record-table overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[760px] border-collapse text-[13px]">
          <thead className="bg-card">
            <tr>
              <th className={th}>账号</th>
              <th className={th}>判定</th>
              <th className={th}>理由</th>
              <th className={th}>模型</th>
              <th className={th}>时间</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className={trHover}>
                <td className={td}>
                  <div className="flex items-center gap-2.5">
                    <AvatarLink
                      handle={c.handle}
                      url={c.avatarUrl}
                      name={c.displayName || c.handle}
                    />
                    <div className="min-w-0">
                      <div className="max-w-[220px] truncate font-semibold tracking-[-0.005em]">
                        {c.displayName ? (
                          <a
                            href={`https://x.com/${encodeURIComponent(c.handle)}`}
                            target="_blank"
                            rel="noopener"
                            className="text-fg transition hover:text-accent"
                            title={`去 @${c.handle} 的 X 主页`}
                          >
                            {c.displayName}
                          </a>
                        ) : (
                          <HandleLink handle={c.handle} className="text-fg" />
                        )}
                      </div>
                      <div className="text-[12px] text-fg-3">
                        <HandleLink handle={c.handle} className="text-fg-3" />
                      </div>
                    </div>
                  </div>
                </td>
                <td className={td}>
                  <Tag label={c.verdict.label} conf={c.verdict.confidence} />
                </td>
                <td className={td}>
                  <ReasonChip reasons={c.verdict.reasons} />
                </td>
                <td className={`${td} font-mono text-[12px] text-fg-3`}>{c.model}</td>
                <td className={`${td} font-mono text-[12px] text-fg-3`} title={whenFull(c.ts)}>
                  {when(c.ts)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mobile-record-list">
        {rows.map((c) => (
          <article key={c.id} className="mobile-record-card">
            <header className="flex items-start gap-3">
              <AvatarLink
                handle={c.handle}
                url={c.avatarUrl}
                name={c.displayName || c.handle}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold text-fg">
                  {c.displayName || `@${c.handle}`}
                </div>
                <HandleLink handle={c.handle} className="text-[12px] text-fg-3" />
              </div>
              <Tag label={c.verdict.label} conf={c.verdict.confidence} />
            </header>
            <div className="mt-3">
              <ReasonChip reasons={c.verdict.reasons} />
            </div>
            <footer className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3 text-[11px] text-fg-3">
              <span className="truncate font-mono">{c.model}</span>
              <span className="flex-none">{when(c.ts)}</span>
            </footer>
          </article>
        ))}
      </div>
      {!rows.length && <div className="py-10 text-center text-fg-3">缓存为空</div>}
    </Page>
  );
}

function Toggle({
  on,
  onChange,
  label,
  hint,
}: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-2">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
        className={`mt-0.5 h-5 w-9 flex-none rounded-full border transition ${
          on
            ? "bg-fg border-fg"
            : "bg-card-hi border-border-2"
        }`}
      >
        <span
          className={`block h-4 w-4 rounded-full shadow-sm transition ${
            on ? "translate-x-4 bg-bg" : "translate-x-0.5 bg-fg-3"
          }`}
        />
      </button>
      <span>
        <span className="font-medium text-fg">{label}</span>
        {hint && <span className="block text-[12px] text-fg-3">{hint}</span>}
      </span>
    </label>
  );
}

const X_ORIGINS = ["*://x.com/*", "*://twitter.com/*"];
// github.com: Device Flow login endpoints (no CORS). api.github.com: the
// user's own custom-rules repo file sync (lib/gh-repo.ts, Contents API —
// requested together so one login prompt covers both).
const GH_ORIGINS = ["https://github.com/*", "https://api.github.com/*"];
// Firefox MV3 data-collection consent needed by online AI checks and whitelist requests.
const FIREFOX_DATA_COLLECTION = ["authenticationInfo", "personallyIdentifyingInfo", "websiteContent"];

// Firefox's chrome.* compatibility shim does NOT promisify
// permissions.request / permissions.contains — calling them without a callback
// returns `undefined`, so `await`ing them yields a falsy value and a successful
// grant is wrongly treated as denied (the exact "未授权访问 x.com" loop, even
// after the user clicks Allow). The native `browser.*` API is fully
// promise-based and reliable, so prefer it on Firefox and fall back to chrome.*
// on Chromium builds.
const perms = ((globalThis as any).browser?.permissions ??
  (globalThis as any).chrome.permissions) as {
  contains: (p: any) => Promise<boolean>;
  request: (p: any) => Promise<boolean>;
};

const ACTION_MODES: {
  value: ActionMode;
  label: string;
  hint: string;
  needsX: boolean;
}[] = [
  {
    value: "local",
    label: "本地隐藏（推荐）",
    hint: "只在本扩展里隐藏，零联网，可随时在「处理记录」恢复。",
    needsX: false,
  },
  {
    value: "mute",
    label: "X 静音",
    hint: "X 原生静音：你看不到 ta，对方无感知。需授权 x.com。",
    needsX: true,
  },
  {
    value: "block",
    label: "X 拉黑",
    hint: "X 原生拉黑：互相不可见、解除关注。需授权 x.com；大批量拉黑可能触发风控。",
    needsX: true,
  },
];

function isMobileApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/** Ensure X website access before enabling a native action.
 *
 * Safari grants website access for the content script from Safari Settings;
 * its permissions.request() result does not reliably reflect that grant. If
 * the content script can run on X, the native action is a same-site request
 * and needs no second Chrome-style runtime grant. */
async function ensureXPermission(): Promise<boolean> {
  if (import.meta.env.SAFARI) return true;
  try {
    // Firefox REQUIRES permissions.request() to be called synchronously from
    // a user input handler. Any await *before* it (e.g. contains()) lets the
    // browser drop the user-gesture token, and request() throws:
    //   "permissions.request may only be called from a user input handler"
    //
    // If the permission is already granted, request() returns true instantly
    // without showing a dialog, so calling it unconditionally is harmless.
    // The only ground truth is contains(), which we check afterward.
    // The return value is intentionally ignored: request() can resolve to
    // false (or to `undefined` under Firefox's chrome.* shim) even when the
    // grant succeeded. We only await it to keep a possible rejection from
    // surfacing as an unhandled promise error.
    try {
      await perms.request({ origins: X_ORIGINS });
    } catch {
      // Firefox throws "permissions.request may only be called from a user
      // input handler" when the gesture token was already consumed. The grant
      // may still have gone through, so fall through to contains().
    }
    return await perms.contains({ origins: X_ORIGINS });
  } catch {
    return false;
  }
}

const CATEGORY_HINT: Record<SpamCategory, string> = {
  porn: "约炮 / 上门 / 引流到主页的色情机器人",
  crypto: "荐币、空投、合约喊单、股票投放",
  gambling: "博彩、体育投注、棋牌推广",
  resource: "网盘资源自取、盗版资源引流",
  marketing: "广告矩阵、涨粉、通用营销引流",
  other: "已确认是垃圾号但未归入以上类别",
};

// Same action vocabulary as the manual 处理方式 selector — the four segments
// describe WHAT happens; that this column happens automatically is carried by
// the section title. 「自动隐藏/自动静音」-style labels made it look like a
// different set of actions from the manual ones (they never were).
const CATEGORY_ACTIONS: { value: CategoryAction; label: string; title: string; needsX: boolean }[] = [
  { value: "badge", label: "仅标记", title: "只挂角标提示，不做任何处理", needsX: false },
  { value: "hide", label: "本地隐藏", title: "只在本扩展里隐藏（仅本机、可随时恢复），与手动方式里的「本地隐藏」是同一动作", needsX: false },
  { value: "mute", label: "X 静音", title: "X 原生静音：用你的登录态执行，所有设备生效；对方无感知", needsX: true },
  { value: "block", label: "X 拉黑", title: "X 原生拉黑：用你的登录态执行，所有设备生效；互相不可见、解除关注，需谨慎", needsX: true },
];

/** cat → 1-char lite-artifact code (schema v2), for the per-category counts
 *  shown next to the policy rows. Mirrors CODE_TO_CATEGORY in lib/category. */
const CAT_CODE: Record<SpamCategory, string> = {
  porn: "p",
  crypto: "c",
  gambling: "g",
  resource: "r",
  marketing: "m",
  other: "o",
};

/** One category row: name + hint on the left, 4-way segmented control on the
 *  right. mute/block request the optional x.com permission first, exactly
 *  like the manual 处理方式 selector. `count` = how many accounts of this
 *  category are in the locally-synced public blacklist (hidden when no list). */
function CategoryPolicyRow({
  cat,
  value,
  count,
  onChange,
}: {
  cat: SpamCategory;
  value: CategoryAction;
  count?: number;
  onChange: (a: CategoryAction) => void;
}) {
  return (
    <div className="category-policy-row flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-border-2 p-3">
      <div className="min-w-0 flex-1 sm:min-w-[150px]">
        <span className="font-medium text-fg">{CATEGORY_ZH[cat]}</span>
        {count !== undefined && (
          <span
            className="ml-1.5 font-mono text-[12px] tabular-nums text-fg-3"
            title={`本地公共名单中该类别共 ${count.toLocaleString("zh-CN")} 个账号`}
          >
            · {count.toLocaleString("zh-CN")}
          </span>
        )}
        <span className="block text-[12px] text-fg-3">{CATEGORY_HINT[cat]}</span>
      </div>
      <div className="category-policy-actions flex w-full overflow-x-auto rounded-md border border-border-2 sm:w-auto">
        {CATEGORY_ACTIONS.map((a) => {
          const active = value === a.value;
          return (
            <button
              key={a.value}
              type="button"
              title={a.title}
              onClick={() => onChange(a.value)}
              className={`px-2.5 py-1.5 text-[12px] transition ${
                active
                  ? a.value === "block"
                    ? "bg-danger/15 font-semibold text-danger"
                    : "bg-card-hi font-semibold text-fg"
                  : "text-fg-3 hover:text-fg"
              }`}
            >
              {a.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

type ApplyStatus = "none" | "pending" | "approved" | "rejected";

const APPLY_STATUS_ZH: Record<ApplyStatus, [string, string]> = {
  none: ["尚未申请", "text-fg-3"],
  pending: ["审核中", "text-warn"],
  approved: ["已批准 ✓", "text-ok"],
  rejected: ["已驳回", "text-danger"],
};

/** Map a /v1/whitelist/apply error response to a user-facing line. */
function applyErrorText(status: number, error?: string): string {
  if (status === 401) return "GitHub Token 无效或已过期，请重新生成后再试。";
  if (status === 403 && error === "gh_account_too_young")
    return "GitHub 账号注册需满 90 天才能申请（防滥用门槛）。";
  if (status === 403 && error === "reporter_banned") return "该身份已被限制，无法提交申请。";
  if (status === 409) return "已有一条待审申请（同一身份 / 同一账号同时只能有一条）。";
  if (status === 429) return "请求太频繁，请约 1 小时后再试。";
  if (status === 503) return "服务端暂不可用，请稍后再试。";
  return `申请失败（HTTP ${status}${error ? ` · ${error}` : ""}）。`;
}

/** 「白名单」自助申请区：GitHub Token 做身份证明 + 提交自己的 @handle。 */
function WhitelistApplySection({ edgeBase }: { edgeBase: string }) {
  const base = (edgeBase || EDGE_DEFAULT).replace(/\/+$/, "");
  const [token, setToken] = useState("");
  const [login, setLogin] = useState<string | null>(null);
  // The applicant's OWN X handle, captured by the content script from the
  // logged-in x.com session ("xss:viewer"). No free-text input — you can
  // only apply for the account you are actually logged in as (防滥用).
  const [ownHandle, setOwnHandle] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<ApplyStatus | null>(null);
  const [statusHandle, setStatusHandle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  // Already ON the official whitelist (locally-synced copy)? The apply/status
  // endpoint only knows about APPLICATIONS — an account whitelisted directly
  // (maintainer add, appeal) has no request row and would read 尚未申请,
  // prompting a pointless application. The local list answers instantly.
  const [wlHit, setWlHit] = useState(false);
  useEffect(() => {
    if (!ownHandle) return;
    void getStoredWhitelist().then((wl) => {
      if (!wl) return;
      const h = ownHandle.toLowerCase().replace(/^@+/, "");
      setWlHit(wl.entries.some((e) => String(e[1] ?? "").toLowerCase() === h));
    });
  }, [ownHandle]);

  const fetchStatus = async (tok: string) => {
    try {
      const res = await fetch(`${base}/v1/whitelist/apply/status`, {
        headers: { authorization: `Bearer ${tok}` },
      });
      if (!res.ok) return;
      const j = (await res.json()) as { status?: string; handle?: string };
      if (j.status && j.status in APPLY_STATUS_ZH) {
        setStatus(j.status as ApplyStatus);
        setStatusHandle(j.handle ?? null);
      }
    } catch {
      /* status display is best-effort */
    }
  };

  useEffect(() => {
    void (async () => {
      const [tok, lg] = await Promise.all([getGhToken(), getGhLogin()]);
      if (tok) {
        setToken(tok);
        setLogin(lg || null);
        void fetchStatus(tok);
      }
      try {
        const g = await chrome.storage.local.get("xss:viewer");
        const v = g["xss:viewer"] as { handle?: string } | undefined;
        if (v?.handle) setOwnHandle(v.handle);
      } catch {
        /* viewer capture is best-effort */
      }
    })();
    // fetchStatus is stable for a given edgeBase; run once on mount.
  }, []);

  // ---- GitHub Device Flow (一键登录，v0.4 的引导交互) ----
  const [ghFlow, setGhFlow] = useState<{ userCode: string; uri: string } | null>(null);
  const [ghBusy, setGhBusy] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);

  const copyCode = async () => {
    if (!ghFlow) return;
    try {
      await navigator.clipboard.writeText(ghFlow.userCode);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 1600);
    } catch {
      /* clipboard denied — the code is still selectable */
    }
  };

  const bg = (m: unknown) =>
    new Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }>((res) => {
      try {
        chrome.runtime.sendMessage(m, (r) => res(r ?? { ok: false, error: "no response" }));
      } catch (e) {
        res({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });

  /** Shared success message incl. the 90d gate check (surfaced immediately). */
  const showIdentity = async (lg: string) => {
    setLogin(lg);
    const tok = await getGhToken();
    if (tok) {
      setToken(tok);
      const u = await ghUser(tok);
      if (u?.ageDays !== null && u !== null && u.ageDays < 90) {
        setMsg({
          text: `已登录，GitHub 身份：@${lg} —— 注意：该账号注册仅 ${u.ageDays} 天，未满 90 天无法申请白名单（请换一个注册更久的 GitHub 账号）。`,
          ok: false,
        });
      } else {
        setMsg({
          text: `已登录，GitHub 身份：@${lg}${u?.ageDays != null ? `（注册 ${u.ageDays} 天）` : ""}`,
          ok: true,
        });
      }
      void fetchStatus(tok);
    }
  };

  const ghLogin = async () => {
    setMsg(null);
    try {
      // Same two Firefox pitfalls as ensureXPermission():
      //   1. permissions.request() must be called SYNCHRONOUSLY from the user
      //      input handler — an `await` before it (here: the data_collection
      //      request) drops the user-gesture token and the second request()
      //      throws "permissions.request may only be called from a user input
      //      handler".
      //   2. request()'s return value is NOT reliable — it can return false
      //      even for already-granted origins, which produced the exact
      //      "未授权访问 …" loop. contains() is the only ground truth.
      //
      // So: fire every request() synchronously, then judge with contains().
      const pending: Promise<unknown>[] = [];
      if (import.meta.env.BROWSER === "firefox") {
        pending.push(
          Promise.resolve(
            perms.request({
              data_collection: FIREFOX_DATA_COLLECTION,
            } as any),
          ).catch(() => undefined),
        );
      }
      pending.push(Promise.resolve(perms.request({ origins: GH_ORIGINS })).catch(() => undefined));
      await Promise.all(pending);

      if (
        import.meta.env.BROWSER === "firefox" &&
        !(await perms.contains({ data_collection: FIREFOX_DATA_COLLECTION } as any))
      ) {
        setMsg({ text: "未授权在线 AI 检测与白名单申请所需的数据传输权限。", ok: false });
        return;
      }
      const granted = await perms.contains({ origins: GH_ORIGINS });
      if (!granted) {
        setMsg({ text: "未授权访问 github.com——一键登录需要该权限（仅用于 GitHub 配对登录）。", ok: false });
        return;
      }
    } catch {
      setMsg({ text: "无法请求 github.com 权限。", ok: false });
      return;
    }
    setGhBusy(true);
    try {
      const start = await bg({ type: "gh_start" });
      const d = start.data as
        | { device_code?: string; user_code?: string; verification_uri?: string; interval?: number }
        | undefined;
      if (!start.ok || !d?.device_code || !d.user_code || !d.verification_uri) {
        setMsg({ text: `发起 GitHub 登录失败${start.error ? `：${start.error}` : ""}`, ok: false });
        return;
      }
      setGhFlow({ userCode: d.user_code, uri: d.verification_uri });
      window.open(d.verification_uri, "_blank", "noopener");
      const stepMs = Math.max(5, d.interval ?? 5) * 1000;
      const deadline = Date.now() + 5 * 60_000; // GitHub device codes live ~15min; 5min is plenty
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, stepMs));
        const poll = await bg({ type: "gh_poll", deviceCode: d.device_code });
        const p = poll.data as { login?: string; pending?: string } | undefined;
        if (p?.login) {
          setGhFlow(null);
          await showIdentity(p.login);
          return;
        }
        if (p?.pending && p.pending !== "authorization_pending" && p.pending !== "slow_down") {
          setGhFlow(null);
          setMsg({ text: `GitHub 登录未完成（${p.pending}），可重试。`, ok: false });
          return;
        }
      }
      setGhFlow(null);
      setMsg({ text: "登录等待超时，请重试。", ok: false });
    } finally {
      setGhBusy(false);
    }
  };

  const saveToken = async () => {
    const tok = token.trim();
    setMsg(null);
    if (!tok) {
      await clearGh();
      setLogin(null);
      setStatus(null);
      setMsg({ text: "已清除本机保存的 Token。", ok: true });
      return;
    }
    setBusy(true);
    const u = await ghUser(tok);
    setBusy(false);
    if (!u) {
      setMsg({ text: "Token 校验失败：GitHub 拒绝了这个 Token。", ok: false });
      return;
    }
    await setGh(tok, u.login);
    setLogin(u.login);
    // Surface the 90d anti-abuse gate NOW, not at submit time — "明明超过了
    // 90 天" usually means the token belongs to a different (newer) account.
    if (u.ageDays !== null && u.ageDays < 90) {
      setMsg({
        text: `已验证并保存，GitHub 身份：@${u.login} —— 注意：该账号注册仅 ${u.ageDays} 天，未满 90 天无法申请白名单（请换一个注册更久的 GitHub 账号的 Token）。`,
        ok: false,
      });
    } else {
      setMsg({
        text: `已验证并保存，GitHub 身份：@${u.login}${u.ageDays !== null ? `（注册 ${u.ageDays} 天）` : ""}`,
        ok: true,
      });
    }
    void fetchStatus(tok);
  };

  const apply = async () => {
    const h = (ownHandle ?? "").trim().replace(/^@+/, "");
    setMsg(null);
    if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) {
      setMsg({ text: "还没有识别到你的 X 账号——打开或刷新一次 x.com 再回到本页。", ok: false });
      return;
    }
    const tok = token.trim();
    if (!tok) {
      setMsg({ text: "请先填写并保存 GitHub Token。", ok: false });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${base}/v1/whitelist/apply`, {
        method: "POST",
        headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
        body: JSON.stringify({
          handle: h,
          ...(note.trim() ? { note: note.trim().slice(0, 200) } : {}),
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        status?: string;
        error?: string;
      };
      if (res.ok && j.status === "already_whitelisted") {
        setWlHit(true); // flip straight into the 已在白名单 success panel
      } else if (res.ok && j.ok) {
        setStatus("pending");
        setStatusHandle(h);
        setMsg({ text: "申请已提交，等待维护者审核。", ok: true });
      } else {
        setMsg({ text: applyErrorText(res.status, j.error), ok: false });
      }
    } catch (e) {
      setMsg({ text: `网络错误：${e instanceof Error ? e.message : String(e)}`, ok: false });
    } finally {
      setBusy(false);
    }
  };

  const input =
    "w-full rounded-md border border-border-2 bg-transparent px-3 py-2 text-[13px] outline-none transition focus:border-accent";

  // ---- 改绑（二开）：X 改名后把已批准的白名单名额迁到新 handle ----
  // 新 id 不手填：与首次申请同一套防滥用语义——只能是内容脚本从 x.com
  // 会话捕获的当前登录账号（xss:viewer），杜绝替别人提交改绑。
  const [rebindOpen, setRebindOpen] = useState(false);
  const [rebindBusy, setRebindBusy] = useState(false);
  const [rebindMsg, setRebindMsg] = useState<{ text: string; ok: boolean } | null>(null);
  // 当前 edge 没有改绑端点（官方服务器未部署此二开功能）→ 提供 Issue 兜底。
  const [rebindNoEndpoint, setRebindNoEndpoint] = useState(false);

  /** 重读 xss:viewer —— 用户开了 x.com 再回到本页时手动刷新识别结果。 */
  const refreshViewer = async () => {
    try {
      const g = await chrome.storage.local.get("xss:viewer");
      const v = g["xss:viewer"] as { handle?: string } | undefined;
      setOwnHandle(v?.handle ?? null);
    } catch {
      /* viewer capture is best-effort */
    }
  };

  const rebindErrorText = (httpStatus: number, error?: string): string => {
    switch (error) {
      case "no_approved_binding":
        return "没有找到你名下已批准的白名单申请，无法改绑（维护者直接添加的账号请联系维护者修改）。";
      case "binding_not_whitelisted":
        return "原账号已不在官方白名单中，无法改绑，请重新提交申请。";
      case "already_pending":
        return "已有审核中的申请，请等待维护者处理后再试。";
      case "github_login_required":
        return "GitHub 登录已失效，请重新登录。";
      case "reporter_banned":
        return "该 GitHub 身份已被限制提交。";
      case "rate_limited":
        return "提交过于频繁，请稍后再试。";
      default:
        return applyErrorText(httpStatus, error);
    }
  };

  /** 改绑端点不可用（404 / CORS 拦截）时的人工兜底：预填好的 GitHub Issue。 */
  const rebindIssueUrl = (): string => {
    const newH = (ownHandle ?? "").trim().replace(/^@+/, "");
    const oldH = ((wlHit ? ownHandle : statusHandle) ?? ownHandle ?? statusHandle ?? "").replace(/^@+/, "");
    const p = new URLSearchParams();
    p.set("title", `[Rebind] @${oldH || "…"} → @${newH || "…"}（白名单改绑申请）`);
    p.set(
      "body",
      [
        "请求把官方白名单名额从旧 X id 改绑到新 X id（账号已改名），扩展改绑入口自动生成：",
        "",
        `- GitHub 身份：@${login ?? "未知"}`,
        `- 旧 X id：@${oldH}`,
        `- 新 X id：@${newH}`,
        "",
        "请维护者核对后在后台完成改绑（新 id 入白名单、旧 id 退出）。",
      ].join("\n"),
    );
    return `${BRAND.issues}/new?${p.toString()}`;
  };

  const rebind = async () => {
    setRebindMsg(null);
    setRebindNoEndpoint(false);
    // 新 id 只能是识别到的当前登录账号——手填一律拒绝。
    const h = (ownHandle ?? "").trim().replace(/^@+/, "");
    if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) {
      setRebindMsg({ text: "还没有识别到你的 X 账号——打开或刷新一次 x.com 再回到本页点「重新识别」。", ok: false });
      return;
    }
    const tok = token.trim();
    if (!tok) {
      setRebindMsg({ text: "请先登录 GitHub（改绑同样需要身份鉴权）。", ok: false });
      return;
    }
    setRebindBusy(true);
    try {
      const res = await fetch(`${base}/v1/whitelist/apply/rebind`, {
        method: "POST",
        headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
        body: JSON.stringify({ handle: h }),
      });
      if (res.status === 404) {
        // 当前 edge 未部署改绑路由（官方服务器尚未包含此二开功能）。
        setRebindNoEndpoint(true);
        setRebindMsg({
          text: `当前服务（${base}）还没有改绑端点——官方服务器尚未包含此功能。可在下方通过 GitHub Issue 申请人工改绑；或自部署包含改绑端点的 edge 后，在「设置 → 高级」把服务地址改成你的部署。`,
          ok: false,
        });
        return;
      }
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        status?: string;
        handle?: string;
        error?: string;
      };
      if (res.ok && j.ok && j.status === "already_whitelisted") {
        setRebindMsg({ text: `@${h} 已在白名单中，无需改绑。`, ok: true });
      } else if (res.ok && j.ok && j.status === "pending") {
        // Flip the whole panel into the 审核中 state for the NEW handle —
        // same UX as a fresh application, the approved card no longer applies.
        setStatus("pending");
        setStatusHandle(j.handle ?? h);
        setWlHit(false);
      } else {
        setRebindMsg({ text: rebindErrorText(res.status, j.error), ok: false });
      }
    } catch {
      // fetch throw（Failed to fetch）= CORS 拦截/网络不可达，同样是端点缺失的表现。
      setRebindNoEndpoint(true);
      setRebindMsg({
        text: `无法连接改绑端点（当前服务 ${base} 未部署此功能）。可在下方通过 GitHub Issue 申请人工改绑，或自部署 edge 后修改服务地址。`,
        ok: false,
      });
    } finally {
      setRebindBusy(false);
    }
  };

  const identityLine = login && (
    <div className="space-y-1 text-[12px] text-fg-3">
      <p>
        GitHub 身份：<b className="text-fg-2">@{login}</b> · 新账号在线 AI 检测已启用
      </p>
      <p className="leading-relaxed">
        本地名单、缓存与官方规则均未命中的账号，会把公开资料和当前公开文本提交到
        x.zuoluo.tv 检测；单页最多 40 个，结果缓存在本机。
      </p>
    </div>
  );

  // ---- Terminal states render as a status panel, not the apply form ----
  // 已在白名单（本地名单命中 / 申请已批准）：再展示三步引导 + 申请按钮
  // 就是在骗用户做无用功。
  if (wlHit || status === "approved") {
    const h = (wlHit ? ownHandle : statusHandle) ?? ownHandle ?? statusHandle;
    return (
      <section className="space-y-3">
        <div className="flex items-start gap-3 rounded-lg border border-ok/40 bg-ok/[0.07] p-4">
          <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-ok text-[12px] font-bold text-white">
            ✓
          </span>
          <div>
            <div className="text-[14px] font-semibold text-ok">
              {h ? `@${h} ` : "你的账号"}已在官方白名单
            </div>
            <div className="mt-1 text-[12px] leading-relaxed text-fg-2">
              白名单账号永不会被本扩展检测、标记、自动处理或上榜。
              {status === "approved" && !wlHit
                ? " 你的申请已获批准，名单每 6 小时同步到本机。"
                : ""}
            </div>
          </div>
        </div>
        {identityLine}
        {/* 改绑：X 改名后把已批准的名额迁到新 handle（二开） */}
        <details
          open={rebindOpen}
          onToggle={(e) => setRebindOpen((e.target as HTMLDetailsElement).open)}
          className="rounded-lg border border-border-2 px-3 py-2"
        >
          <summary className="cursor-pointer select-none text-[12px] text-fg-2">
            改绑新的 X id（账号改名后使用）
          </summary>
          <p className="mt-2 text-[12px] leading-relaxed text-fg-3">
            新 id 自动识别为你当前登录的 X 账号（与首次申请同一套防滥用机制，不能替别人改绑）。提交后进入维护者审核；批准时白名单名额自动从旧 id 迁到新 id，旧 id 同步退出白名单。
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {ownHandle ? (
              <span className="text-[12px] text-fg-2">
                识别到当前登录的 X 账号：
                <b className="ml-1 font-mono text-fg">{ownHandle.replace(/^@+/, "")}</b>
              </span>
            ) : (
              <span className="text-[12px] text-warn">
                未识别到 X 账号——打开或刷新一次 x.com，再回到本页点「重新识别」
              </span>
            )}
            <Btn size="sm" onClick={() => void refreshViewer()}>
              重新识别
            </Btn>
            <Btn tier="primary" onClick={() => void rebind()} disabled={rebindBusy || !ownHandle}>
              {rebindBusy ? "提交中…" : "提交改绑"}
            </Btn>
          </div>
          {rebindMsg && (
            <p className={`mt-2 text-[12px] ${rebindMsg.ok ? "text-ok" : "text-danger"}`}>{rebindMsg.text}</p>
          )}
          {rebindNoEndpoint && (
            <div className="mt-2">
              <a
                href={rebindIssueUrl()}
                target="_blank"
                rel="noopener"
                className="inline-block rounded-md border border-border-2 px-3 py-1.5 text-[12px] text-fg-2 transition hover:border-fg-3 hover:text-fg"
              >
                通过 GitHub Issue 申请人工改绑 ↗（已预填新旧 id）
              </a>
            </div>
          )}
        </details>
        {msg && <p className={`text-[12px] ${msg.ok ? "text-ok" : "text-danger"}`}>{msg.text}</p>}
      </section>
    );
  }
  if (status === "pending") {
    return (
      <section className="space-y-3">
        <div className="rounded-lg border border-warn/40 bg-warn/[0.07] p-4">
          <div className="text-[14px] font-semibold text-warn">
            申请审核中{statusHandle ? ` · @${statusHandle}` : ""}
          </div>
          <div className="mt-1 text-[12px] leading-relaxed text-fg-2">
            维护者审核通过后自动生效（名单每 6 小时同步到本机），无需重复提交。
          </div>
        </div>
        {identityLine}
        {msg && <p className={`text-[12px] ${msg.ok ? "text-ok" : "text-danger"}`}>{msg.text}</p>}
      </section>
    );
  }

  // ---- Apply flow: the pitch is a LIVE checklist, not a static blurb ----
  const Step = ({ done, n, children }: { done: boolean; n: number; children: React.ReactNode }) => (
    <li className="flex items-center gap-2.5">
      <span
        className={`flex h-5 w-5 flex-none items-center justify-center rounded-full text-[11px] font-bold ${
          done ? "bg-ok text-white" : "border border-border-2 text-fg-3"
        }`}
      >
        {done ? "✓" : n}
      </span>
      <span className={done ? "text-fg-3" : "text-fg-2"}>{children}</span>
    </li>
  );

  return (
    <section>
      <ol className="mb-4 space-y-1.5 text-[13px]">
        <Step done={!!login} n={1}>
          GitHub 登录（账号需注册满 90 天，防滥用；凭证只存本机）
        </Step>
        <Step done={!!ownHandle} n={2}>
          扩展自动识别你登录的 X 账号
        </Step>
        <Step done={false} n={3}>
          提交申请，等维护者审核
        </Step>
      </ol>
      {status === "rejected" && (
        <p className="mb-3 text-[12px] text-danger">
          上次申请被驳回{statusHandle ? `（@${statusHandle}）` : ""}——可补充附言说明后重新提交。
        </p>
      )}
      <div className="space-y-2.5">
        {!login && !ghFlow && (
          <div className="flex items-center gap-3">
            <Btn tier="primary" onClick={ghLogin} disabled={ghBusy}>
              {ghBusy ? "正在连接 GitHub…" : "用 GitHub 一键登录"}
            </Btn>
            <span className="text-[12px] text-fg-3">
              跳转 GitHub 输入配对码即可，无需创建 Token
            </span>
          </div>
        )}
        {ghFlow && (
          <div className="rounded-lg border border-border-2 bg-card p-4">
            <div className="text-[12px] text-fg-3">在打开的 GitHub 页面输入这个配对码：</div>
            <div className="my-2 flex items-center gap-3">
              <button
                type="button"
                onClick={copyCode}
                title="点击复制配对码"
                className="cursor-pointer rounded-md border border-transparent font-mono text-[26px] font-bold tracking-[0.2em] text-fg transition hover:border-border-2 hover:bg-card-hi"
              >
                {ghFlow.userCode}
              </button>
              <Btn size="sm" onClick={copyCode} className="flex-none">
                {codeCopied ? "✓ 已复制" : "复制"}
              </Btn>
            </div>
            <div className="text-[12px] text-fg-3">
              等待你在 GitHub 上确认…（页面没弹出？
              <a
                href={ghFlow.uri}
                target="_blank"
                rel="noopener"
                className="text-fg-2 underline hover:text-fg"
              >
                手动打开 ↗
              </a>
              ）
            </div>
          </div>
        )}
        {identityLine}
        <details className="text-[12px] text-fg-3">
          <summary className="cursor-pointer select-none">
            高级：手动粘贴 GitHub Token（无需勾选任何权限）
          </summary>
          <div className="mt-2 flex items-center gap-2">
            <input
              aria-label="GitHub Token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="GitHub Token（ghp_… / github_pat_…）"
              autoComplete="off"
              className={input}
            />
            <Btn onClick={saveToken} disabled={busy} className="flex-none">
              验证并保存
            </Btn>
          </div>
        </details>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div
            className={`${input} flex items-center gap-2 ${ownHandle ? "" : "text-fg-3"}`}
            title="由你当前登录的 x.com 会话自动识别，不可手填——只能为自己的账号申请"
          >
            {ownHandle ? (
              <>
                <span className="flex-none whitespace-nowrap text-fg-3">申请账号（自动识别）</span>
                <b className="text-fg">@{ownHandle}</b>
              </>
            ) : (
              "未识别到你的 X 账号 · 打开或刷新一次 x.com 后回到本页"
            )}
          </div>
          <input
            aria-label="白名单申请附言"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder="附言（选填，≤200 字）"
            className={input}
          />
        </div>
        <div className="flex items-center gap-3">
          <Btn tier="primary" onClick={apply} disabled={busy || !token.trim() || !ownHandle}>
            {busy ? "提交中…" : status === "rejected" ? "重新提交申请" : "申请把我的 X 账号加入白名单"}
          </Btn>
        </div>
        {msg && <p className={`text-[12px] ${msg.ok ? "text-ok" : "text-danger"}`}>{msg.text}</p>}
      </div>
    </section>
  );
}

const RULE_FIELD_ZH: Record<RuleField, string> = {
  any: "任意字段",
  handle: "用户名",
  display_name: "昵称",
  bio: "简介",
  tweet: "推文",
};
const RULE_FIELD_BY_CODE: Record<string, RuleField> = {
  h: "handle",
  d: "display_name",
  b: "bio",
  t: "tweet",
  a: "any",
};

const CatChip = ({ cat }: { cat: SpamCategory }) => (
  <span className="inline-flex items-center gap-1.5 rounded-full border border-border-2 px-2 py-0.5 text-[11px] text-fg-2">
    <span
      className="h-1.5 w-1.5 rounded-full"
      style={{ backgroundColor: CAT_COLOR[cat] ?? CAT_COLOR.other }}
    />
    {CATEGORY_ZH[cat]}
  </span>
);

/** Compact switch for dense rule rows — same visual language as Toggle,
 *  minus the label block. */
function MiniSwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`h-[18px] w-8 flex-none rounded-full border transition ${
        on ? "bg-fg border-fg" : "bg-card-hi border-border-2"
      }`}
    >
      <span
        className={`block h-3.5 w-3.5 rounded-full shadow-sm transition ${
          on ? "translate-x-[15px] bg-bg" : "translate-x-0.5 bg-fg-3"
        }`}
      />
    </button>
  );
}

/** 「检测规则」——同步的官方规则（总开关 / 单条停用 / 匿名回传）+ 本机自定义规则。 */
function DetectionRulesSection({
  st,
  save,
}: {
  st: Settings;
  save: <K extends keyof Settings>(k: K, v: Settings[K]) => Promise<void>;
}) {
  const [official, setOfficial] = useState<{ pattern: string; field: RuleField; cat: SpamCategory }[]>([]);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [custom, setCustom] = useState<CustomRule[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<{ pattern: string; field: RuleField; category: SpamCategory }>({
    pattern: "",
    field: "any",
    category: "porn",
  });
  const [draftMsg, setDraftMsg] = useState<string | null>(null);
  // Own-repo sync (lib/gh-repo.ts): the custom keyword library lives as a
  // JSON file in the user's fork; adds/removes push up when autoSync is on,
  // and the background alarm merges repo-side edits back every 6h.
  const [syncCfg, setSyncCfg] = useState<RulesSyncConfig>(DEFAULT_SYNC_CONFIG);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ text: string; ok: boolean } | null>(null);
  // 鉴权状态：未登录时禁止一切上传/同步（按钮仍可点，但会给出登录指引）。
  const [ghLoginName, setGhLoginName] = useState<string | null>(null);
  // 二开：登录后自动发现账号可写的仓库列表——owner 自动填登录名，repo 变
  // 下拉选择，不再手填（检索失败时回退手输，不影响使用）。
  const [ghRepos, setGhRepos] = useState<string[] | null>(null);

  useEffect(() => {
    void getRulesSyncConfig().then(setSyncCfg);
    void getGhLogin().then((l) => setGhLoginName(l || null));
  }, []);

  /** 登录变化后自动发现：GET /user/repos（含 push 权限的），预选逻辑：
   *  已保存的 repo 优先 → 二开仓库 filtrationX → 最近更新的第一个。 */
  useEffect(() => {
    if (!ghLoginName) {
      setGhRepos(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const token = await getGhToken();
        if (!token) return;
        const resp = await fetch(
          "https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator",
          { headers: { authorization: `token ${token}`, accept: "application/vnd.github+json" } },
        );
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const repos = (await resp.json()) as {
          name: string;
          permissions?: { push?: boolean };
        }[];
        const writable = repos
          .filter((r) => r.permissions?.push !== false)
          .map((r) => r.name);
        if (!alive) return;
        setGhRepos(writable);
        const cur = await getRulesSyncConfig();
        const next: RulesSyncConfig = { ...cur, owner: ghLoginName };
        if (!next.repo) {
          next.repo = writable.includes("filtrationX") ? "filtrationX" : (writable[0] ?? "");
        }
        if (next.owner !== cur.owner || next.repo !== cur.repo) {
          setSyncCfg(await saveRulesSyncConfig(next));
        }
      } catch {
        if (alive) setGhRepos(null); // 发现失败 → 保持手输框
      }
    })();
    return () => {
      alive = false;
    };
  }, [ghLoginName]);

  useEffect(() => {
    void getStoredList().then((list) => {
      const rows = (list?.rules ?? []).flatMap((r) => {
        const field = RULE_FIELD_BY_CODE[String(r[1])];
        return field
          ? [{ pattern: r[0], field, cat: categoryFromCode(String(r[2])[1]) }]
          : [];
      });
      setOfficial(rows);
    });
    void getDisabledPatterns().then((p) => setDisabled(new Set(p)));
    void getCustomRules().then(setCustom);
  }, []);

  const toggleRule = async (pattern: string, enabledNow: boolean) => {
    const next = new Set(disabled);
    if (enabledNow) next.add(pattern);
    else next.delete(pattern);
    setDisabled(next);
    await saveDisabledPatterns([...next]);
  };

  const addCustom = async () => {
    const pattern = draft.pattern.trim();
    if (!pattern) return;
    if (custom.some((r) => r.pattern.toLowerCase() === pattern.toLowerCase() && r.field === draft.field)) {
      setDraftMsg("已有相同规则");
      return;
    }
    if (custom.length >= MAX_CUSTOM_RULES) {
      setDraftMsg(`最多 ${MAX_CUSTOM_RULES} 条`);
      return;
    }
    const next = await saveCustomRules([...custom, { pattern, field: draft.field, category: draft.category }]);
    setCustom(next);
    setDraft((d) => ({ ...d, pattern: "" }));
    setDraftMsg(null);
    void maybeAutoPush();
  };

  const removeCustom = async (idx: number) => {
    const next = custom.filter((_, i) => i !== idx);
    setCustom(await saveCustomRules(next));
    void maybeAutoPush();
  };

  // ---- own-repo sync helpers ----

  const updateSyncCfg = async (patch: Partial<RulesSyncConfig>) => {
    setSyncCfg(await saveRulesSyncConfig({ ...syncCfg, ...patch }));
    setSyncMsg(null);
  };

  /** Fire-and-forget push after a local add/remove (only when autoSync is on). */
  const maybeAutoPush = async () => {
    if (!syncCfg.autoSync) return;
    const token = await getGhToken();
    if (!token) {
      setSyncMsg({ text: "已开启自动同步，但尚未登录 GitHub——本次仅保存到本机。", ok: false });
      return;
    }
    const out = await pushRules(token, syncCfg);
    setSyncMsg(
      out.ok
        ? { text: `已自动上传 ${out.ruleCount} 条规则到 ${syncCfg.owner}/${syncCfg.repo}`, ok: true }
        : { text: `自动上传失败：${out.error}`, ok: false },
    );
  };

  const runSync = async (mode: "push" | "pull" | "sync") => {
    setSyncMsg(null);
    const token = await getGhToken();
    if (!token) {
      setSyncMsg({ text: "未登录 GitHub——请先到「白名单」页完成登录，鉴权通过后才能同步上传", ok: false });
      return;
    }
    if (!syncCfg.owner || !syncCfg.repo) {
      setSyncMsg({ text: "请先填写 owner/repo、分支与文件路径", ok: false });
      return;
    }
    setSyncBusy(true);
    try {
      const out =
        mode === "push"
          ? await pushRules(token, syncCfg)
          : mode === "pull"
            ? await pullRules(token, syncCfg, saveCustomRules)
            : await syncRules(token, syncCfg, saveCustomRules);
      if (out.ok) {
        if (out.pulled > 0) {
          setCustom(await getCustomRules());
          setSyncMsg({ text: `已从仓库合并 ${out.pulled} 条新规则，本机共 ${out.ruleCount} 条`, ok: true });
        } else if (out.action === "pushed") {
          setSyncMsg({ text: `已上传 ${out.ruleCount} 条规则到 ${syncCfg.owner}/${syncCfg.repo}`, ok: true });
        } else {
          setSyncMsg({ text: `仓库与本机已一致（共 ${out.ruleCount} 条）`, ok: true });
        }
      } else {
        setSyncMsg({ text: out.error, ok: false });
      }
    } finally {
      setSyncBusy(false);
    }
  };

  /** 鉴权自检：验证登录令牌对目标仓库的可见性与写权限（push/sync 前也会强制执行）。 */
  const checkAccess = async () => {
    setSyncMsg(null);
    const token = await getGhToken();
    if (!token) {
      setSyncMsg({ text: "未登录 GitHub——请先到「白名单」页完成登录", ok: false });
      return;
    }
    if (!syncCfg.owner || !syncCfg.repo) {
      setSyncMsg({ text: "请先填写 owner/repo", ok: false });
      return;
    }
    setSyncBusy(true);
    try {
      const access = await verifyRepoAccess(token, syncCfg);
      if (access.ok) {
        setSyncMsg({ text: `鉴权通过：@${ghLoginName ?? "?"} 对 ${syncCfg.owner}/${syncCfg.repo} 有写权限，可以同步`, ok: true });
      } else {
        setSyncMsg({ text: access.error ?? "鉴权未通过", ok: false });
      }
    } finally {
      setSyncBusy(false);
    }
  };

  const disabledCount = official.filter((r) => disabled.has(r.pattern)).length;
  const shown = expanded ? official : [];
  const selectCls =
    "rounded-md border border-border-2 bg-transparent px-2 py-1.5 text-[12px] text-fg outline-none transition focus:border-accent";

  return (
    <section>
      <SectionH>检测规则</SectionH>
      <p className="mb-3 text-[12px] leading-relaxed text-fg-3">
        官方规则由维护者人工审定、随公共名单每 6 小时同步，全部在本机比对；命中后按上方「自动处理策略」执行（仅评论区自动执行）。
      </p>
      <Toggle
        on={st.officialRulesEnabled}
        onChange={(v) => save("officialRulesEnabled", v)}
        label="启用官方规则"
        hint="关闭后同步的官方规则全部不再生效；公共黑名单命中不受影响"
      />
      <Toggle
        on={st.kolCardEnabled}
        onChange={(v) => save("kolCardEnabled", v)}
        label="KOL 悬浮卡"
        hint="悬停在 @handle 上显示账号年龄、粉丝规模、互动效率与本地采样结论（原创比 / 主题集中度 / 综合可信分）——全部读自页面自身数据与本地累积采样，零联网查询"
      />
      <div className="pl-1 text-[12px] text-fg-3">
        卡片语言在侧边栏「语言」页统一设置（默认跟随浏览器语言）。
      </div>
      <Toggle
        on={st.kolGraphqlEnabled}
        onChange={(v) => save("kolGraphqlEnabled", v)}
        label="精确互动质量（GraphQL · 默认关）"
        hint="悬停 KOL 卡时按需拉取该账号最近 20 条推文，计算单条获赞/转推/回复中位数 vs 粉丝数——买粉死号与刷赞号一眼现形，原创比也升级为官方标记的精确值。会消耗你的 X 会话请求配额：全局串行限速（≥400ms 间隔），命中限流冷却 10 分钟，结果缓存 3 天，一天正常使用仅几十次请求。关闭后卡片回退到本地近似指标"
      />
      <KolSignalsManager />
      <Toggle
        on={st.ruleTelemetry}
        onChange={(v) => save("ruleTelemetry", v)}
        label="匿名回传官方规则命中"
        hint="仅上传命中账号的公开标识（用户名 / 数字 ID）、命中的规则与字段，以及该账号自己公开发布的命中处原文片段（≤200 字），供维护者复核后决定是否收录公共名单；不含你的任何账号或浏览信息。自定义规则命中永不上传。"
      />

      <div className="mt-3 overflow-hidden rounded-lg border border-border">
        <div className="flex items-center justify-between gap-3 bg-card-hi px-3 py-2.5">
          <div className="text-[12px] text-fg-2">
            已同步 <b className="font-mono tabular-nums text-fg">{official.length}</b> 条官方规则
            {disabledCount > 0 && (
              <span className="ml-2 text-fg-3">（已停用 {disabledCount} 条）</span>
            )}
          </div>
          {official.length > 0 && (
            <Btn onClick={() => setExpanded((v) => !v)}>{expanded ? "收起" : "查看规则"}</Btn>
          )}
        </div>
        {expanded && (
          <ul className="max-h-[320px] divide-y divide-border overflow-y-auto">
            {shown.map((r) => {
              const off = disabled.has(r.pattern);
              return (
                <li
                  key={`${r.pattern}|${r.field}`}
                  className={`flex items-center gap-3 px-3 py-2 ${off ? "opacity-45" : ""}`}
                >
                  <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg">
                    {r.pattern}
                  </code>
                  <span className="flex-none text-[11px] text-fg-3">{RULE_FIELD_ZH[r.field]}</span>
                  <span className="flex-none">
                    <CatChip cat={r.cat} />
                  </span>
                  <MiniSwitch
                    on={!off && st.officialRulesEnabled}
                    onChange={() => st.officialRulesEnabled && toggleRule(r.pattern, !off)}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-5">
        <div className="mb-1.5 text-[12px] font-semibold text-fg">自定义规则</div>
        <p className="mb-2 text-[12px] leading-relaxed text-fg-3">
          你自己的关键词规则：默认仅本机生效、不参与匿名回传，可选择同步到你自己的 GitHub 仓库（见下方）。命中处理方式与官方规则一致，白名单账号永不处理。
        </p>
        {custom.length > 0 && (
          <ul className="mb-2 divide-y divide-border overflow-hidden rounded-lg border border-border">
            {custom.map((r, i) => (
              <li key={`${r.pattern}|${r.field}`} className="flex items-center gap-3 px-3 py-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg">
                  {r.pattern}
                </code>
                <span className="flex-none text-[11px] text-fg-3">{RULE_FIELD_ZH[r.field]}</span>
                <span className="flex-none">
                  <CatChip cat={r.category} />
                </span>
                <Btn tier="danger" onClick={() => removeCustom(i)}>
                  删除
                </Btn>
              </li>
            ))}
          </ul>
        )}
        <div className="custom-rule-form flex flex-wrap items-center gap-2">
          <input
            value={draft.pattern}
            onChange={(e) => {
              setDraft((d) => ({ ...d, pattern: e.target.value }));
              setDraftMsg(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && void addCustom()}
            placeholder="关键词（包含即命中，不区分大小写）"
            maxLength={200}
            className="min-w-[200px] flex-1 rounded-md border border-border-2 bg-transparent px-3 py-1.5 text-[12.5px] outline-none transition focus:border-accent"
          />
          <select
            value={draft.field}
            onChange={(e) => setDraft((d) => ({ ...d, field: e.target.value as RuleField }))}
            className={selectCls}
          >
            {(Object.keys(RULE_FIELD_ZH) as RuleField[]).map((f) => (
              <option key={f} value={f}>
                {RULE_FIELD_ZH[f]}
              </option>
            ))}
          </select>
          <select
            value={draft.category}
            onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value as SpamCategory }))}
            className={selectCls}
          >
            {SPAM_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_ZH[c]}
              </option>
            ))}
          </select>
          <Btn onClick={() => void addCustom()} disabled={!draft.pattern.trim()}>
            添加
          </Btn>
        </div>
        {draftMsg && <p className="mt-1.5 text-[12px] text-danger">{draftMsg}</p>}

        {/* ---- 同步到自己的 GitHub 仓库（二开：词库文件可配置） ---- */}
        <div className="mt-5 rounded-lg border border-border p-3">
          <div className="mb-1.5 text-[12px] font-semibold text-fg">同步到我的 GitHub 仓库</div>
          <p className="mb-3 text-[12px] leading-relaxed text-fg-3">
            把上面的自定义词库存成你自己仓库里的一个 JSON 文件（比如 xiaoyi36c/filtrationX），在 GitHub 上直接编辑也能同步回本机——仓库文件就是一套可配置的词库，官方同步下来的关键词照常生效，两套互不影响。
          </p>
          <div className="mb-3 rounded-md border border-border-2 px-3 py-2 text-[12px]">
            {ghLoginName ? (
              <span className="text-fg-3">
                已登录 <b className="text-fg">@{ghLoginName}</b>，上传 / 同步前会先校验该账号对目标仓库的写权限
              </span>
            ) : (
              <span className="text-danger">
                未登录 GitHub——请到「白名单」页完成登录，鉴权通过后自定义词库才能同步上传到仓库
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={syncCfg.owner}
              readOnly
              title="自动取自 GitHub 登录账号，无需手填"
              placeholder="owner（登录后自动填入）"
              className="min-w-[140px] flex-1 rounded-md border border-border-2 bg-transparent px-3 py-1.5 font-mono text-[12.5px] text-fg-2 outline-none"
            />
            {ghRepos && ghRepos.length > 0 ? (
              <select
                value={syncCfg.repo}
                onChange={(e) => void updateSyncCfg({ repo: e.target.value })}
                title="自动列出你账号下有写权限的仓库（按最近更新排序）"
                className="min-w-[140px] flex-1 rounded-md border border-border-2 bg-transparent px-3 py-1.5 font-mono text-[12.5px] outline-none transition focus:border-accent"
              >
                {!ghRepos.includes(syncCfg.repo) && syncCfg.repo && (
                  <option key="current" value={syncCfg.repo}>
                    {syncCfg.repo}（当前保存）
                  </option>
                )}
                {ghRepos.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={syncCfg.repo}
                onChange={(e) => void updateSyncCfg({ repo: e.target.value })}
                placeholder={ghLoginName ? "检索仓库中…或手动填写 repo" : "repo（如 filtrationX）"}
                className="min-w-[140px] flex-1 rounded-md border border-border-2 bg-transparent px-3 py-1.5 font-mono text-[12.5px] outline-none transition focus:border-accent"
              />
            )}
            <input
              value={syncCfg.branch}
              onChange={(e) => void updateSyncCfg({ branch: e.target.value })}
              placeholder="分支"
              className="w-[90px] rounded-md border border-border-2 bg-transparent px-2 py-1.5 font-mono text-[12.5px] outline-none transition focus:border-accent"
            />
            <input
              value={syncCfg.path}
              onChange={(e) => void updateSyncCfg({ path: e.target.value })}
              placeholder="文件路径"
              className="min-w-[180px] flex-1 rounded-md border border-border-2 bg-transparent px-3 py-1.5 font-mono text-[12.5px] outline-none transition focus:border-accent"
            />
          </div>
          <div className="mt-2">
            <Toggle
              on={syncCfg.autoSync}
              onChange={(v) => void updateSyncCfg({ autoSync: v })}
              label="自动同步"
              hint="本机新增 / 删除关键词后立即上传到仓库；同时每 6 小时自动与仓库双向合并——你在 GitHub 上编辑的词库也会同步到本机"
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Btn onClick={() => void runSync("sync")} disabled={syncBusy}>
              {syncBusy ? "同步中…" : "双向同步"}
            </Btn>
            <Btn onClick={() => void runSync("pull")} disabled={syncBusy}>
              从仓库拉取
            </Btn>
            <Btn onClick={() => void runSync("push")} disabled={syncBusy}>
              上传（覆盖仓库）
            </Btn>
            <Btn onClick={() => void checkAccess()} disabled={syncBusy}>
              检查权限
            </Btn>
          </div>
          {syncMsg && (
            <p className={`mt-2 text-[12px] ${syncMsg.ok ? "text-fg-3" : "text-danger"}`}>{syncMsg.text}</p>
          )}
          <p className="mt-2 text-[11.5px] leading-relaxed text-fg-3">
            同步必须鉴权：未登录或令牌对目标仓库没有写权限时，上传一律被拒绝。写入需要含 repo 权限的 GitHub 登录（旧版令牌请退出重新登录一次）；同步只读写上述这一个文件，不影响仓库其他内容。
          </p>
        </div>
      </div>
    </section>
  );
}

function Settings() {
  const { t } = useT();
  const [cleared, setCleared] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [st, setSt] = useState<Settings | null>(null);
  const [ls, setLs] = useState<ListState | null>(null);
  const [permDenied, setPermDenied] = useState(false);
  useEffect(() => {
    getSettings().then(setSt);
    // Loaded once so each 分级策略 row can show how many synced public-list
    // accounts fall into its category. No list yet → counts stay hidden.
    readListState().then(setLs);
  }, []);
  const save = async <K extends keyof Settings>(k: K, v: Settings[K]) => {
    await setSetting(k, v);
    setSt((p) => (p ? { ...p, [k]: v } : p));
  };
  const changeMode = async (mode: ActionMode) => {
    if (mode !== "local") {
      const ok = await ensureXPermission();
      if (!ok) {
        setPermDenied(true);
        return;
      }
    }
    setPermDenied(false);
    await save("actionMode", mode);
  };
  const changeCategoryAction = async (cat: SpamCategory, action: CategoryAction) => {
    if (action === "mute" || action === "block") {
      const ok = await ensureXPermission();
      if (!ok) {
        setPermDenied(true);
        return;
      }
    }
    setPermDenied(false);
    await setCategoryAction(cat, action);
    setSt((p) =>
      p ? { ...p, categoryActions: { ...p.categoryActions, [cat]: action } } : p,
    );
  };
  return (
    <Page title="设置" sub="配置仅存于本机">
      <div className="settings-content max-w-[680px] space-y-9">
        {st && (
          <section>
            <SectionH>检测行为</SectionH>
            <p className="mb-2 text-[12px] text-fg-3">改动在下次刷新页面后生效</p>
            <Toggle
              on={st.enabled}
              onChange={(v) => save("enabled", v)}
              label="启用被动检测"
              hint="关闭后扩展在 X 上完全不工作"
            />
            <Toggle on={st.bubble} onChange={(v) => save("bubble", v)} label="显示角标气泡" />
            <Toggle
              on={st.bubblePos === "tr"}
              onChange={(v) => save("bubblePos", v ? "tr" : "br")}
              label="气泡位置：右上角"
              hint="关 = 右下角"
            />
            <Toggle
              on={st.autoExpand}
              onChange={(v) => save("autoExpand", v)}
              label="自动处理时展开面板"
              hint="关闭后仅气泡脉冲提示，不弹出处理卡片（小屏 / 手机端建议关闭）"
            />
          </section>
        )}

        {st && (
          <section>
            <SectionH>自动处理策略</SectionH>
            <p className="mb-3 text-[12px] leading-relaxed text-fg-3">
              命中<b className="text-fg-2">公共黑名单或官方规则</b>的账号按下方类别设定自动处理，其余只挂角标。
              规则命中只在评论区自动执行；白名单账号永不处理；一切可在「处理记录」撤销。
            </p>
            <div className="mb-4">
              <Toggle
                on={st.autoProcess}
                onChange={(v) => save("autoProcess", v)}
                label="启用自动处理"
                hint="总开关，与气泡面板里的「自动处理」开关同步；关闭后以下配置保留但不执行，一切命中只标记"
              />
            </div>
            <div className="mb-4">
              <div className="mb-1.5 text-[12px] font-semibold text-fg">自动处理范围</div>
              <div className="auto-scope-grid grid grid-cols-1 gap-2 sm:grid-cols-2">
                {(
                  [
                    {
                      v: "replies",
                      label: "仅推文评论区（推荐）",
                      hint: "只自动处理别人推文下的回复——垃圾潮所在；信息流和主页只标记。",
                    },
                    {
                      v: "all",
                      label: "全局",
                      hint: "信息流、主页、评论区都自动处理，误伤风险更高。",
                    },
                  ] as const
                ).map((o) => {
                  const active = (st.autoScope ?? "replies") === o.v;
                  return (
                    <button
                      key={o.v}
                      type="button"
                      onClick={() => save("autoScope", o.v)}
                      className={`flex items-start gap-2.5 rounded-lg border p-3 text-left transition ${
                        active ? "border-fg bg-card-hi" : "border-border-2 hover:border-fg-3"
                      }`}
                    >
                      <span
                        className={`mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full border ${
                          active ? "border-fg" : "border-border-2"
                        }`}
                      >
                        {active && <span className="h-2 w-2 rounded-full bg-fg" />}
                      </span>
                      <span>
                        <span className="text-[13px] font-medium text-fg">{o.label}</span>
                        <span className="block text-[12px] leading-5 text-fg-3">{o.hint}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="mb-4">
              <div className="mb-1.5 text-[12px] font-semibold text-fg">自动收录条目</div>
              <p className="mb-2 text-[12px] leading-relaxed text-fg-3">
                命中分两级：<b className="text-fg-2">人工确认</b>（维护者复核过的公榜条目，始终按下方各类别的动作完整执行）和
                <b className="text-fg-2">自动收录</b>（AI/规则自动上榜的公榜条目 + 本地官方规则命中，占大多数）。这里决定自动上榜条目能自动处理到什么程度；本地规则命中默认封顶为本地隐藏，除非你在下方显式开启。
              </p>
              <div className="grid grid-cols-1 gap-2">
                {(
                  [
                    {
                      v: "full",
                      label: "完整执行（默认）",
                      hint: "自动上榜的公榜条目与人工确认同权，按各类别设定的动作执行（包括 X 静音/拉黑）；本地规则命中封顶为本地隐藏（尚未上榜、无人复核），除非开启下方「本地规则命中也执行我设定的动作」。误判可在「处理记录」恢复并申诉。",
                    },
                    {
                      v: "hide",
                      label: "封顶为本地隐藏",
                      hint: "按各类别设定的动作执行，但封顶为本地隐藏——零联网、一键恢复；X 静音/拉黑仍只对人工确认条目执行。",
                    },
                    {
                      v: "badge",
                      label: "仅标记",
                      hint: "自动收录条目只挂角标、永不自动处理（最保守）。",
                    },
                  ] as const
                ).map((o) => {
                  const active = (st.autoTierMode ?? "full") === o.v;
                  return (
                    <button
                      key={o.v}
                      type="button"
                      onClick={() => save("autoTierMode", o.v)}
                      className={`flex items-start gap-2.5 rounded-lg border p-3 text-left transition ${
                        active ? "border-fg bg-card-hi" : "border-border-2 hover:border-fg-3"
                      }`}
                    >
                      <span
                        className={`mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full border ${
                          active ? "border-fg" : "border-border-2"
                        }`}
                      >
                        {active && <span className="h-2 w-2 rounded-full bg-fg" />}
                      </span>
                      <span>
                        <span className="text-[13px] font-medium text-fg">{o.label}</span>
                        <span className="block text-[12px] leading-5 text-fg-3">{o.hint}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="mb-4 rounded-lg border border-border p-3">
              <Toggle
                on={st.ruleHitsAutoAct}
                onChange={(v) => save("ruleHitsAutoAct", v)}
                label="本地规则命中也执行我设定的动作"
                hint="默认关闭：官方关键词规则是无人复核的关键词匹配，且命中的大多数是一次误判就会用你的登录态做出不可撤销的 X 静音/拉黑。打开后规则命中按下列类别动作执行（仍受上面的档位和「仅推文评论区」范围限制）。"
              />
            </div>
            <div className="space-y-2">
              {SPAM_CATEGORIES.map((cat) => (
                <CategoryPolicyRow
                  key={cat}
                  cat={cat}
                  value={st.categoryActions[cat] ?? "badge"}
                  count={ls && ls.black > 0 ? (ls.catDist[CAT_CODE[cat]] ?? 0) : undefined}
                  onChange={(a) => changeCategoryAction(cat, a)}
                />
              ))}
            </div>
            <p className="mt-2 text-[12px] text-fg-3">
              动作含义与下方「手动处理动作」一致：本地隐藏仅本机、可恢复；X 静音 / 拉黑用你的登录态原生执行，所有设备生效。
            </p>
            {import.meta.env.SAFARI && (
              <p className="mt-2 text-[12px] leading-relaxed text-fg-3">
                {isMobileApplePlatform()
                  ? "Safari 的网站访问权限由浏览器统一管理。如果 X 上没有出现徽标或动作未执行，请前往“设置”→“App”→“Safari”→“扩展”→“Make X Great Again”，启用扩展并允许访问 x.com。"
                  : "Safari 的网站访问权限由浏览器统一管理。如果 X 上没有出现徽标或动作未执行，请前往 Safari → 设置 → 扩展 → Make X Great Again，启用扩展并允许访问 x.com。"}
              </p>
            )}
            {permDenied && (
              <p className="mt-2 text-[12px] text-danger">
                未授权访问 x.com，已保持当前设置。X 静音 / 拉黑需要该权限才能调用 X 接口。
              </p>
            )}
          </section>
        )}

        {st && <DetectionRulesSection st={st} save={save} />}

        {st && (
          <section>
            <SectionH>手动处理动作</SectionH>
            <p className="mb-3 text-[12px] text-fg-3">
              只决定你<b className="text-fg-2">手动</b>点角标或气泡按钮时执行哪种动作，不影响上方的自动处理。X 静音 / 拉黑走你自己的登录态，不经过我们的服务器。
            </p>
            <div className="space-y-2">
              {ACTION_MODES.map((m) => {
                const active = st.actionMode === m.value;
                return (
                  <button
                    type="button"
                    key={m.value}
                    onClick={() => changeMode(m.value)}
                    className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition ${
                      active
                        ? "border-fg bg-card-hi"
                        : "border-border-2 hover:border-fg-3"
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full border ${
                        active ? "border-fg" : "border-border-2"
                      }`}
                    >
                      {active && <span className="h-2 w-2 rounded-full bg-fg" />}
                    </span>
                    <span>
                      <span className="font-medium text-fg">{m.label}</span>
                      <span className="block text-[12px] text-fg-3">{m.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {permDenied && (
              <p className="mt-2 text-[12px] text-danger">
                未授权访问 x.com，已保持当前处理方式。X 静音 / 拉黑需要该权限才能调用 X 接口。
              </p>
            )}
          </section>
        )}

        <section>
          <SectionH>数据与隐私</SectionH>
          <p className="mb-3 text-[13px] text-fg-2">
            检测缓存、处理记录、统计均仅存于本机；除公开的 X 数字 ID 外不存任何个人信息。
          </p>
          <div className="flex items-center gap-3">
            <Btn tier="danger" onClick={() => setClearOpen(true)}>
              清除本地数据
            </Btn>
            {cleared && <span className="text-[12px] text-ok">已清除</span>}
          </div>
        </section>

        <ConfirmDialog
          open={clearOpen}
          title="清除本地数据"
          body={
            <>
              这会清空本机上的：
              <ul className="my-2 list-inside list-disc text-fg-3">
                <li>本地检测缓存</li>
                <li>你的隐藏历史 + 本地处理统计</li>
              </ul>
              <b className="text-fg">不可恢复。</b>
            </>
          }
          okLabel="确认清除"
          variant="danger"
          onCancel={() => setClearOpen(false)}
          onConfirm={async () => {
            setClearOpen(false);
            await clearAllLocal();
            setCleared(true);
          }}
        />
      </div>
    </Page>
  );
}

const About = () => {
  const { t } = useT();
  return (
  <Page title={t("page.about.title")} sub={t("page.about.sub")}>
    <div className="max-w-[680px] space-y-4 text-[13px] leading-7 text-fg-2">
      <p>{t("about.body")}</p>
      <div className="about-grid grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
        <div className="bg-bg p-4">
          <div className="text-[11px] uppercase tracking-[0.15em] text-fg-3">{t("about.license")}</div>
          <code className="mt-1 inline-block font-mono text-[13px] text-fg">{BRAND.license}</code>
        </div>
        <div className="bg-bg p-4">
          <div className="text-[11px] uppercase tracking-[0.15em] text-fg-3">{t("about.repo")}</div>
          <a
            href={REPO}
            target="_blank"
            rel="noopener"
            className="mt-1 inline-block text-[13px] text-fg hover:text-accent"
          >
            github.com/{BRAND.owner}/filtrationX ↗
          </a>
        </div>
        <div className="bg-bg p-4">
          <div className="text-[11px] uppercase tracking-[0.15em] text-fg-3">{t("about.publicList")}</div>
          <a
            href={`${EDGE_DEFAULT}/list`}
            target="_blank"
            rel="noopener"
            className="mt-1 inline-block text-[13px] text-fg hover:text-accent"
          >
            {t("about.recent100")}
          </a>
        </div>
        <div className="bg-bg p-4">
          <div className="text-[11px] uppercase tracking-[0.15em] text-fg-3">{t("about.governance")}</div>
          <a
            href={BRAND.governance}
            target="_blank"
            rel="noopener"
            className="mt-1 inline-block text-[13px] text-fg hover:text-accent"
          >
            {t("about.appeal")}
          </a>
        </div>
      </div>
      <p className="text-[12px] text-fg-3">{t("about.privacy")}</p>
    </div>
  </Page>
  );
};

// 小蓝 mascot — same PNG as the toolbar icon + the popup header. We use the
// runtime URL helper instead of bundling a duplicate asset, and render at
// 28px (retina-safe — the source is 128×128) for a chunkier sidebar mark
// than the popup's 32px version.
const MASCOT_URL = chrome.runtime.getURL("icon/128.png");
const Mascot = () => (
  <img
    src={MASCOT_URL}
    alt={BRAND.name}
    width={28}
    height={28}
    className="flex-none rounded-md"
  />
);

function BrandLockup() {
  return (
    <div className="flex min-w-0 items-center gap-2.5 text-[15px] font-semibold tracking-[-0.005em]">
      <Mascot />
      <span className="truncate">{BRAND.acronym}</span>
    </div>
  );
}

const WL_SOURCE_ZH: Record<LocalWhitelistEntry["source"], { label: string; hint: string }> = {
  manual: { label: "手动添加", hint: "你在角标弹层或本页手动加入" },
  following: { label: "我关注的", hint: "检测到你关注了该账号后自动加入" },
};

/** 本地白名单 — the user's own never-touch list (highest priority of the
 *  whole chain). Followed accounts join automatically; anything can be added
 *  by handle. Local-only storage, never uploaded. */
function LocalWhitelistSection({
  st,
  save,
}: {
  st: Settings;
  save: <K extends keyof Settings>(k: K, v: Settings[K]) => Promise<void>;
}) {
  const [rows, setRows] = useState<LocalWhitelistEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [q, setQ] = useState("");
  const reload = () => void listLocalWhitelist().then(setRows);
  useEffect(() => {
    reload();
    const h = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes[LOCAL_WL_KEY]) reload();
    };
    try {
      chrome.storage.onChanged.addListener(h);
      return () => chrome.storage.onChanged.removeListener(h);
    } catch {
      return undefined;
    }
  }, []);
  const add = async () => {
    const handle = normalizeWhitelistHandle(draft);
    if (!handle) {
      setMsg({ text: "请输入有效的 X 用户名（1–15 位字母、数字或下划线）", ok: false });
      return;
    }
    const added = await addLocalWhitelist({ handle, source: "manual" });
    setMsg({ text: added ? `已加入 @${handle}` : `@${handle} 已在白名单中`, ok: true });
    setDraft("");
    reload();
  };
  const remove = async (handle: string) => {
    await removeLocalWhitelist(handle);
    reload();
  };
  const [excluded, setExcluded] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const PAGE = 50;
  useEffect(() => {
    void listExcluded().then(setExcluded);
  }, [rows]);
  const following = rows.filter((r) => r.source === "following").length;
  const needle = q.trim().toLowerCase().replace(/^@+/, "");
  const shown = needle
    ? rows.filter(
        (r) => r.handle.toLowerCase().includes(needle) || (r.displayName ?? "").toLowerCase().includes(needle),
      )
    : rows;
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const cur = Math.min(page, pages - 1);
  const slice = shown.slice(cur * PAGE, cur * PAGE + PAGE);
  return (
    <section className="mb-10">
      <SectionH>本地白名单 · 你信任的账号</SectionH>
      <p className="mb-3 text-[12px] leading-relaxed text-fg-3">
        针对<b className="text-fg-2">别人的账号</b>（你关注的人、朋友、确认不是垃圾号的账号）：只对本机生效，优先级最高——名单内账号<b className="text-fg-2">不检测、不标记、不自动处理</b>，即使公共名单或关键词规则命中。仅保存在本机，不上传、不参与回传。
      </p>
      <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
        <span>
          <span className="block text-[13px] font-medium text-fg">自动加入我关注的账号</span>
          <span className="block text-[12px] leading-5 text-fg-3">
            刷到你关注的账号（X 自带的关注关系）时自动加入；「移出」过的账号不会再自动加回
            {following > 0 ? `（已收录 ${following.toLocaleString("zh-CN")} 个）` : ""}
          </span>
        </span>
        <MiniSwitch on={st.followingWhitelist} onChange={(v) => save("followingWhitelist", v)} />
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setMsg(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && void add()}
          placeholder="@用户名 — 手动加入白名单"
          maxLength={20}
          className="min-w-[200px] flex-1 rounded-md border border-border-2 bg-transparent px-3 py-1.5 text-[12.5px] outline-none transition focus:border-accent"
        />
        <Btn tier="primary" onClick={() => void add()} disabled={rows.length >= MAX_LOCAL_WHITELIST}>
          加入
        </Btn>
        {msg && (
          <span className={`text-[12px] ${msg.ok ? "text-fg-2" : "text-danger"}`}>{msg.text}</span>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-[12.5px] text-fg-3">
          还没有本地白名单账号。在 X 上悬停角标 → 「加入白名单」，或在上方输入用户名。
        </div>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
            <span className="text-[12px] text-fg-3">
              共 {rows.length.toLocaleString("zh-CN")} 个账号
              {needle ? ` · 筛选出 ${shown.length.toLocaleString("zh-CN")} 个` : ""}
            </span>
            {rows.length > 8 && (
              <input
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(0);
                }}
                placeholder="筛选用户名 / 昵称"
                className="w-44 rounded-md border border-border-2 bg-transparent px-2.5 py-1 text-[12px] outline-none transition focus:border-accent"
              />
            )}
          </div>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={th}>账号</th>
                  <th className={th}>来源</th>
                  <th className={th}>加入时间</th>
                  <th className={`${th} text-right`}></th>
                </tr>
              </thead>
              <tbody>
                {slice.map((r) => (
                  <tr key={r.handle} className={trHover}>
                    <td className={td}>
                      <a
                        href={`https://x.com/${r.handle}`}
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center gap-2.5 text-fg hover:underline"
                        title={`去 @${r.handle} 的 X 主页`}
                      >
                        <Avatar url={r.avatarUrl} name={r.displayName || r.handle} />
                        <span className="min-w-0">
                          {r.displayName ? (
                            <>
                              <span className="font-medium">{r.displayName}</span>
                              <span className="ml-1.5 text-fg-3">@{r.handle}</span>
                            </>
                          ) : (
                            <>@{r.handle}</>
                          )}
                        </span>
                      </a>
                    </td>
                    <td className={`${td} text-[12px] text-fg-2`} title={WL_SOURCE_ZH[r.source].hint}>
                      {WL_SOURCE_ZH[r.source].label}
                    </td>
                    <td className={`${td} font-mono text-[12px] text-fg-3`}>
                      {r.addedAt ? relTime(r.addedAt) : "—"}
                    </td>
                    <td className={`${td} text-right`}>
                      <Btn tier="ghost" size="sm" onClick={() => void remove(r.handle)}>
                        移出
                      </Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="mt-2 flex items-center justify-between gap-3 text-[12px] text-fg-3">
              <span>
                第 {cur + 1} / {pages} 页 · 每页 {PAGE} 个
              </span>
              <span className="flex items-center gap-1.5">
                <Btn size="sm" onClick={() => setPage(0)} disabled={cur === 0}>
                  首页
                </Btn>
                <Btn size="sm" onClick={() => setPage(cur - 1)} disabled={cur === 0}>
                  上一页
                </Btn>
                <Btn size="sm" onClick={() => setPage(cur + 1)} disabled={cur >= pages - 1}>
                  下一页
                </Btn>
                <Btn size="sm" onClick={() => setPage(pages - 1)} disabled={cur >= pages - 1}>
                  末页
                </Btn>
              </span>
            </div>
          )}
        </>
      )}
      {excluded.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-[12px] text-fg-3">
          <span>
            已移出 {excluded.length.toLocaleString("zh-CN")} 个关注的账号，不会再自动加回（手动加入可解除）
          </span>
          <Btn
            tier="ghost"
            size="sm"
            onClick={() => void clearExcluded().then(() => listExcluded().then(setExcluded))}
          >
            全部允许再次自动加入
          </Btn>
        </div>
      )}
    </section>
  );
}

/** 白名单 — the user's local list first (highest priority), then the
 *  official-whitelist self-service application. */
function WhitelistPage() {
  const { t } = useT();
  const [st, setSt] = useState<Settings | null>(null);
  useEffect(() => {
    getSettings().then(setSt);
  }, []);
  const save = async <K extends keyof Settings>(k: K, v: Settings[K]) => {
    await setSetting(k, v);
    setSt((s) => (s ? { ...s, [k]: v } : s));
  };
  return (
    <Page title={t("page.whitelist.title")} sub={t("page.whitelist.sub")}>
      <div className="max-w-[760px]">
        <section className="mb-10">
          <SectionH>保护我的账号 · 官方白名单</SectionH>
          <p className="mb-3 text-[12px] leading-relaxed text-fg-3">
            针对<b className="text-fg-2">你自己的 X 账号</b>：申请进入官方白名单后，所有用户的扩展都不会再检测、标记或收录你。需要 GitHub 登录，由维护者审核。
          </p>
          {st && <WhitelistApplySection edgeBase={st.edgeBase} />}
        </section>
        {st && <LocalWhitelistSection st={st} save={save} />}
      </div>
    </Page>
  );
}

const SECTION_ZH: Record<BackupSection, string> = {
  settings: "设置",
  localWhitelist: "本地白名单",
  customRules: "自定义规则",
  disabledRules: "停用的官方规则",
  hiddenIds: "已隐藏账号与处理记录",
  stats: "本地统计",
  cache: "检测缓存",
};

function summaryLines(s: BackupSummary): string[] {
  const out: string[] = [];
  if (s.settings) out.push("设置");
  if (s.localWhitelist) out.push(`本地白名单 ${s.localWhitelist.toLocaleString("zh-CN")} 个`);
  if (s.localWhitelistExcluded) out.push(`不再自动加入白名单 ${s.localWhitelistExcluded.toLocaleString("zh-CN")} 个`);
  if (s.customRules) out.push(`自定义规则 ${s.customRules} 条`);
  if (s.disabledRules) out.push(`停用的官方规则 ${s.disabledRules} 条`);
  if (s.hiddenIds || s.hiddenRecords)
    out.push(`已隐藏账号 ${s.hiddenIds.toLocaleString("zh-CN")} 个（处理记录 ${s.hiddenRecords.toLocaleString("zh-CN")} 条）`);
  if (s.stats) out.push("本地统计");
  if (s.cache) out.push(`检测缓存 ${s.cache.toLocaleString("zh-CN")} 条`);
  return out;
}

/** 备份与迁移 — export the user's own local data to a JSON file, import it on
 *  another browser. Never includes the GitHub login or the synced public
 *  lists; import validates every field and merges or replaces per section. */
function BackupPage() {
  const { t } = useT();
  const [includeCache, setIncludeCache] = useState(false);
  const [includeStats, setIncludeStats] = useState(true);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [parsed, setParsed] = useState<{ file: BackupFile; summary: BackupSummary; name: string } | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [importErr, setImportErr] = useState<string | null>(null);
  const [mode, setMode] = useState<ImportMode>("merge");
  const [skip, setSkip] = useState<Partial<Record<BackupSection, boolean>>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BackupSummary | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const doExport = async () => {
    setBusy(true);
    setExportMsg(null);
    try {
      const file = await exportBackup({ includeCache, includeStats });
      const text = JSON.stringify(file, null, 2);
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = backupFileName();
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      const s = summarize(file);
      setExportMsg(`已导出 ${a.download}（${(text.length / 1024).toFixed(0)} KB）：${summaryLines(s).join("、") || "无数据"}`);
    } catch (e) {
      setExportMsg(`导出失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const onPick = async (f: File | undefined) => {
    setParsed(null);
    setParseErr(null);
    setResult(null);
    setImportErr(null);
    setSkip({});
    if (!f) return;
    if (f.size > 50 * 1024 * 1024) {
      setParseErr("文件超过 50 MB，不是本扩展的备份");
      return;
    }
    try {
      const r = parseBackup(await f.text());
      if (!r.ok) {
        setParseErr(r.error);
        return;
      }
      setParsed({ file: r.file, summary: r.summary, name: f.name });
    } catch (e) {
      setParseErr(`读取失败：${(e as Error).message}`);
    }
  };

  const doImport = async () => {
    if (!parsed) return;
    setBusy(true);
    setResult(null);
    setImportErr(null);
    try {
      const sections: Partial<Record<BackupSection, boolean>> = {};
      for (const [k, v] of Object.entries(skip)) if (v) sections[k as BackupSection] = false;
      const applied = await importBackup(parsed.file, mode, sections);
      setResult(applied);
    } catch (e) {
      setImportErr(`导入失败：${(e as Error).message}。请检查本机数据后重试。`);
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  };

  const present = parsed ? presentBackupSections(parsed.file) : [];

  return (
    <Page title={t("page.backup.title")} sub={t("page.backup.sub")}>
      <div className="max-w-[760px]">
        <section className="mb-10">
          <SectionH>导出备份</SectionH>
          <p className="mb-3 text-[12px] leading-relaxed text-fg-3">
            导出一个 JSON 文件，包含：设置、本地白名单、自定义规则与停用的官方规则、已隐藏账号与处理记录、本地统计。
            <b className="text-fg-2">不包含</b> GitHub 登录信息（换浏览器后需重新登录）、服务地址和公开名单（会自动重新同步）。文件含你的白名单、隐藏偏好和处理记录，请妥善保管。
          </p>
          <div className="mb-3 space-y-2">
            <Toggle on={includeStats} onChange={setIncludeStats} label="包含本地统计" hint="扫描 / 命中 / 处理计数" />
            <Toggle
              on={includeCache}
              onChange={setIncludeCache}
              label="包含检测缓存"
              hint="账号级判定缓存，换机后可少调用在线检测；文件会明显变大，且旧判定会一并带走"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Btn tier="primary" onClick={() => void doExport()} disabled={busy}>
              导出备份文件
            </Btn>
            {exportMsg && <span className="text-[12px] text-fg-2">{exportMsg}</span>}
          </div>
        </section>

        <section>
          <SectionH>导入备份</SectionH>
          <p className="mb-3 text-[12px] leading-relaxed text-fg-3">
            选择之前导出的文件，先看到内容摘要，再选择合并或覆盖。导入只写入上面列出的几类数据，不会碰登录信息。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => void onPick(e.target.files?.[0])}
            />
            <Btn onClick={() => fileInput.current?.click()} disabled={busy}>
              选择备份文件
            </Btn>
            {parsed && <span className="text-[12px] text-fg-2">{parsed.name}</span>}
            {parseErr && <span className="text-[12px] text-danger">{parseErr}</span>}
          </div>

          {parsed && (
            <div className="mt-4 rounded-lg border border-border bg-card p-4">
              <div className="mb-1 text-[13px] font-medium text-fg">备份内容</div>
              <div className="mb-3 text-[12px] text-fg-3">
                导出于 {parsed.file.exportedAt ? new Date(parsed.file.exportedAt).toLocaleString("zh-CN") : "未知时间"}
                {parsed.file.extensionVersion ? ` · 扩展 v${parsed.file.extensionVersion}` : ""}
              </div>
              <ul className="mb-4 space-y-1.5">
                {present.map((k) => {
                  const v = parsed.summary[k];
                  return (
                    <li key={k} className="text-[13px]">
                      <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={!skip[k]}
                        onChange={(e) => setSkip((s) => ({ ...s, [k]: !e.target.checked }))}
                        className="h-4 w-4 accent-fg"
                      />
                      <span className="text-fg">{SECTION_ZH[k]}</span>
                      {typeof v === "number" && <span className="text-fg-3">{v.toLocaleString("zh-CN")}</span>}
                      {k === "localWhitelist" && parsed.summary.localWhitelistExcluded > 0 && <span className="text-fg-3">（不再自动加入 {parsed.summary.localWhitelistExcluded} 个）</span>}
                      </label>
                    </li>
                  );
                })}
                {present.length === 0 && <li className="text-[12px] text-fg-3">文件里没有可导入的数据</li>}
              </ul>
              <div className="mb-4 grid gap-2 sm:grid-cols-2">
                {(
                  [
                    { v: "merge", label: "合并（推荐）", hint: "名单/规则/隐藏账号取并集，统计相加，设置以备份为准；本机已有的数据保留" },
                    { v: "replace", label: "覆盖", hint: "勾选的每一类以备份为准，本机同类数据被替换；未勾选的类别不动" },
                  ] as const
                ).map((o) => (
                  <button
                    type="button"
                    key={o.v}
                    onClick={() => setMode(o.v)}
                    className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition ${
                      mode === o.v ? "border-fg bg-card-hi" : "border-border hover:border-fg-3"
                    }`}
                  >
                    <span className={`mt-1 flex h-3.5 w-3.5 flex-none items-center justify-center rounded-full border ${mode === o.v ? "border-fg" : "border-border-2"}`}>
                      {mode === o.v && <span className="h-2 w-2 rounded-full bg-fg" />}
                    </span>
                    <span>
                      <span className="text-[13px] font-medium text-fg">{o.label}</span>
                      <span className="block text-[12px] leading-5 text-fg-3">{o.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Btn tier={mode === "replace" ? "danger" : "primary"} onClick={() => setConfirmOpen(true)} disabled={busy || !present.some((k) => !skip[k])}>
                  {mode === "replace" ? "覆盖导入" : "合并导入"}
                </Btn>
                {result && (
                  <span className="text-[12px] text-ok">
                    已导入：{summaryLines(result).join("、") || "没有新增内容"}
                  </span>
                )}
                {importErr && <span role="alert" className="text-[12px] text-danger">{importErr}</span>}
              </div>
            </div>
          )}
        </section>

        <ConfirmDialog
          open={confirmOpen}
          title={mode === "replace" ? "覆盖导入" : "合并导入"}
          body={
            <>
              将把 {parsed?.name ?? "备份"} 中的：
              <ul className="my-2 list-inside list-disc text-fg-3">
                {present.filter((k) => !skip[k]).map((k) => (
                  <li key={k}>{SECTION_ZH[k]}</li>
                ))}
              </ul>
              {mode === "replace" ? (
                <b className="text-fg">覆盖本机同类数据（不可恢复，建议先导出一份当前备份）。</b>
              ) : (
                <>与本机数据合并。已隐藏的账号会在 X 上立即生效。</>
              )}
            </>
          }
          okLabel={mode === "replace" ? "确认覆盖" : "确认合并"}
          variant={mode === "replace" ? "danger" : "primary"}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => void doImport()}
        />
      </div>
    </Page>
  );
}

/** 语言（二开 M4.5）：全局 UI 语言独立页。
 *  "auto" = 浏览器语言（不是 X.com 的语言——用户明确否决过跟随 X）；
 *  zh/en/ja 钉死。已接入：popup、x.com 徽标与 KOL 悬浮卡、拉黑同步页、
 *  本页；管理面板其余页面逐步迁移。 */
function LanguagePage() {
  const [pref, setPref] = useState<UiLocale>("auto");
  useEffect(() => {
    let alive = true;
    void getSettings().then((s) => {
      if (alive) setPref(s.uiLocale);
    });
    const off = onSettingsChange((s) => setPref(s.uiLocale));
    return () => {
      alive = false;
      off();
    };
  }, []);
  const resolved = resolveLocale(pref);
  const { t } = useT();
  const zhName = (l: UiLocale) =>
    l === "auto" ? t("lang.autoBrowser") : t(`lang.${l}`);
  return (
    <Page
      title={t("page.language.title")}
      sub={t("page.language.sub")}
    >
      <div className="flex flex-wrap gap-2">
        {UI_LOCALES.map((l) => (
          <button
            key={l.value}
            type="button"
            onClick={() => {
              setPref(l.value);
              void setSetting("uiLocale", l.value);
            }}
            className={`rounded-md border px-3.5 py-2 text-[13px] transition ${
              pref === l.value
                ? "border-fg bg-card-hi text-fg"
                : "border-border-2 text-fg-3 hover:border-fg-3 hover:text-fg-2"
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>
      <p className="mt-4 text-[12.5px] text-fg-2">
        {t("lang.current")}：<b className="text-fg">{zhName(pref === "auto" ? "auto" : resolved)}</b>
        {pref === "auto" && <span className="ml-1 text-fg-3">{t("lang.autoNote", { loc: resolved })}</span>}
      </p>
      <p className="mt-3 text-[12px] leading-relaxed text-fg-3">{t("lang.scope")}</p>
    </Page>
  );
}

const TABS = [
  ["overview", "nav.overview", Overview],
  ["blocklist", "nav.blocklist", Blocklist],
  ["xblocks", "nav.xblocks", XBlocksPage],
  ["cache", "nav.cache", Cache],
  ["settings", "nav.settings", Settings],
  ["language", "nav.language", LanguagePage],
  ["whitelist", "nav.whitelist", WhitelistPage],
  ["backup", "nav.backup", BackupPage],
  ["about", "nav.about", About],
] as const;
type TabId = (typeof TABS)[number][0];
const tabIds = new Set<TabId>(TABS.map(([id]) => id));

function TabButtons({
  active,
  drawer = false,
  onSelect,
}: {
  active: TabId;
  drawer?: boolean;
  onSelect: (id: TabId) => void;
}) {
  const { t } = useT();
  return TABS.map(([id, labelKey]) => (
    <button
      key={id}
      type="button"
      onClick={() => onSelect(id)}
      className={`flex min-h-11 flex-none cursor-pointer items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-left text-[13px] transition ${
        drawer ? "w-full" : ""
      } ${active === id ? "bg-card-hi text-fg" : "text-fg-3 hover:bg-card hover:text-fg"}`}
    >
      {t(labelKey)}
    </button>
  ));
}

function NavigationFooter() {
  const { t } = useT();
  return (
    <div className="space-y-2 text-[11px] text-fg-3">
      <a
        href={`${EDGE_DEFAULT}/list`}
        target="_blank"
        rel="noopener"
        className="block min-h-11 content-center rounded-md px-3 text-fg-2 hover:bg-card hover:text-fg"
      >
        {t("nav.publicList")} ↗
      </a>
      <a
        href={REPO}
        target="_blank"
        rel="noopener"
        className="block min-h-11 content-center rounded-md px-3 text-fg-2 hover:bg-card hover:text-fg"
      >
        {t("nav.thisRepo")} ↗
      </a>
      <a
        href={BRAND.upstreamRepo}
        target="_blank"
        rel="noopener"
        className="block min-h-11 content-center rounded-md px-3 text-fg-2 hover:bg-card hover:text-fg"
      >
        {t("nav.upstream")} ↗
      </a>
      <div className="px-3 pt-1 font-mono text-fg-4">
        v{chrome.runtime.getManifest().version_name ?? chrome.runtime.getManifest().version}
      </div>
    </div>
  );
}

function tabFromLocation(): TabId {
  if (typeof location === "undefined") return "overview";
  const url = new URL(location.href);
  const fromQuery = url.searchParams.get("tab");
  const fromHash = url.hash.replace(/^#/, "");
  if (fromQuery && tabIds.has(fromQuery as TabId)) return fromQuery as TabId;
  if (fromHash && tabIds.has(fromHash as TabId)) return fromHash as TabId;
  return "overview";
}

function setTabUrl(id: TabId) {
  if (typeof history === "undefined" || typeof location === "undefined") return;
  const url = new URL(location.href);
  url.searchParams.set("tab", id);
  url.hash = "";
  history.replaceState({}, "", url.toString());
}

export function App() {
  const [tab, setTabState] = useState<TabId>(() => tabFromLocation());
  const [menuOpen, setMenuOpen] = useState(false);
  const mobileApple = isMobileApplePlatform();
  const activeTab = TABS.find((item) => item[0] === tab);
  const Active = activeTab?.[2] ?? Overview;
  const setTab = (id: TabId) => {
    setTabState(id);
    setTabUrl(id);
    setMenuOpen(false);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  if (mobileApple) {
    return (
      <div className="ios-mobile-shell min-h-screen">
        <header className="ios-mobile-header sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-bg/95 px-4 pb-3 backdrop-blur">
          <button
            type="button"
            aria-label="打开管理菜单"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
            className="grid h-11 w-11 flex-none place-items-center rounded-lg border border-border-2 bg-card text-fg"
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <BrandLockup />
        </header>

        {menuOpen && (
          <div className="fixed inset-0 z-50">
            <button
              type="button"
              aria-label="关闭管理菜单"
              onClick={() => setMenuOpen(false)}
              className="absolute inset-0 h-full w-full bg-black/65 backdrop-blur-[2px]"
            />
            <aside
              role="dialog"
              aria-modal="true"
              aria-label="管理面板菜单"
              className="ios-mobile-drawer absolute inset-y-0 left-0 flex w-[min(320px,86vw)] flex-col border-r border-border-2 bg-bg px-4 pb-5 shadow-[20px_0_60px_rgba(0,0,0,0.45)]"
            >
              <div className="flex items-center justify-between border-b border-border pb-4">
                <BrandLockup />
                <button
                  type="button"
                  aria-label="关闭菜单"
                  onClick={() => setMenuOpen(false)}
                  className="grid h-11 w-11 place-items-center rounded-lg text-fg-2 hover:bg-card-hi hover:text-fg"
                >
                  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                    <path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
              <nav className="mt-4 flex flex-col gap-1" aria-label="管理面板导航">
                <TabButtons active={tab} drawer onSelect={setTab} />
              </nav>
              <div className="mt-auto border-t border-border pt-3">
                <NavigationFooter />
              </div>
            </aside>
          </div>
        )}

        <Active />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="sticky top-0 z-20 flex w-full flex-none flex-col gap-3 border-b border-border bg-bg/95 px-4 py-3 backdrop-blur md:h-screen md:w-[220px] md:gap-6 md:border-b-0 md:border-r md:py-6">
        <div className="px-1">
          <BrandLockup />
        </div>
        <nav className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 md:mx-0 md:flex-col md:gap-0.5 md:overflow-visible md:px-0 md:pb-0" aria-label="管理面板导航">
          <TabButtons active={tab} onSelect={setTab} />
        </nav>
        <div className="mt-auto hidden md:block">
          <NavigationFooter />
        </div>
      </aside>
      <Active />
    </div>
  );
}

/**
 * KOL 采样数据管理（M4）：统计当前累积的采样画像并支持一键清空。
 * 设置页与内容脚本不在同一上下文——统计直接读 chrome.storage，内容脚本
 * 内存 map 由 kol-signals 的 storage.onChanged 监听同步清空，不会写回。
 */
function KolSignalsManager() {
  const [stats, setStats] = useState<KolSignalsStats | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cleared, setCleared] = useState(false);
  const refresh = () => {
    void kolSignalsStats()
      .then(setStats)
      .catch(() => setStats(null));
  };
  useEffect(() => {
    refresh();
    try {
      const fn = () => refresh();
      chrome.storage.onChanged.addListener(fn);
      return () => chrome.storage.onChanged.removeListener(fn);
    } catch {
      return undefined;
    }
  }, []);
  const latest =
    stats && stats.latestTs > 0 ? new Date(stats.latestTs).toLocaleDateString() : null;
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border">
      <div className="flex flex-wrap items-center justify-between gap-3 bg-card-hi px-3 py-2.5">
        <div className="min-w-0 text-[12px] leading-relaxed text-fg-2">
          采样画像：
          <b className="font-mono tabular-nums text-fg">{stats?.accounts ?? 0}</b> 个账号（
          <b className="font-mono tabular-nums text-fg">{stats?.labeled ?? 0}</b> 个已够样本量）
          · 累计 <b className="font-mono tabular-nums text-fg">{stats?.samples ?? 0}</b> 条
          {latest && <span className="ml-2 text-fg-3">最近采样 {latest}</span>}
          <div className="text-[11px] text-fg-3">
            仅本机存储，只存词频计数不存推文原文；清空后原创比 / 主题集中度将从零重新累积
          </div>
        </div>
        <div className="flex flex-none items-center gap-2">
          {cleared && <span className="text-[12px] text-ok">已清空</span>}
          <Btn tier="danger" onClick={() => setConfirmOpen(true)}>
            清空采样
          </Btn>
        </div>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title="清空 KOL 采样数据"
        variant="danger"
        body={
          <>
            这会删除本机累积的全部账号采样画像（原创比 / 主题集中度 / 可信分中的采样部分）。
            <ul className="my-2 list-inside list-disc text-fg-3">
              <li>档案实时数据（账号年龄、粉丝数等）不受影响，悬浮卡仍正常显示</li>
              <li>采样随浏览从零重新累积，约需刷到每个账号 5 条以上推文</li>
              <li>仅本机操作，全程无网络请求</li>
            </ul>
          </>
        }
        onConfirm={() => {
          void clearKolSignals().then(() => {
            void clearPreciseCache();
            setCleared(true);
            setConfirmOpen(false);
            refresh();
            setTimeout(() => setCleared(false), 2600);
          });
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
