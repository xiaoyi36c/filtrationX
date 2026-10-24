import { useEffect, useState } from "react";
import { BRAND } from "../../lib/brand";
import {
  resolveLocale,
  UI_LOCALES,
  type ResolvedLocale,
  type UiLocale,
} from "../../lib/i18n";
import { getSettings, setSetting, onSettingsChange } from "../../lib/settings";
import type { BgResponse } from "../../lib/types";

function bg<T = Record<string, unknown>>(msg: unknown): Promise<BgResponse & { data?: T }> {
  return new Promise((r) =>
    chrome.runtime.sendMessage(msg, (resp) => r(resp ?? { ok: false })),
  );
}

interface LocalStats {
  hitPublic: number;
  blocked: number;
  firstUsedAt: number;
}

const MASCOT_URL = chrome.runtime.getURL("icon/128.png");

// ---- 三语文案（二开 M4.5：popup 全量接入，缺译回退中文）----
const ZH = {
  checking: "检查中",
  synced: "名单已同步",
  syncFailed: "名单同步失败",
  daysWith: (d: string) => `小蓝陪你 ${d} 天 · 一起干掉`,
  spamAccounts: "个垃圾号",
  hitList: "命中名单",
  hitListHint: "公共名单命中，本地比对",
  byHand: "亲手处理",
  byHandHint: "你手动隐藏 / 静音 / 拉黑的账号",
  syncing: "同步名单…",
  entries: "条",
  syncRetry: "名单未同步 · 将自动重试",
  openPanel: "打开管理面板",
  protectMe: "保护我的账号 · 加入白名单",
  publicList: "看公榜",
  thisRepo: "本项目",
  upstream: "原项目",
  governance: "为什么 / 治理",
  governanceTail: "— 判定永不自动公开，须人工或社区共识确认",
};
const EN: typeof ZH = {
  checking: "Checking",
  synced: "List synced",
  syncFailed: "List sync failed",
  daysWith: (d: string) => `With you for ${d} days · cleaned up`,
  spamAccounts: "spam accounts",
  hitList: "List hits",
  hitListHint: "Matched the public list, checked locally",
  byHand: "By hand",
  byHandHint: "Accounts you hid / muted / blocked yourself",
  syncing: "Syncing list…",
  entries: "",
  syncRetry: "List not synced · will retry",
  openPanel: "Open dashboard",
  protectMe: "Protect my account · whitelist",
  publicList: "List",
  thisRepo: "Repo",
  upstream: "Upstream",
  governance: "Why / governance",
  governanceTail: "— verdicts are never auto-published; human or community review required",
};
const JA: typeof ZH = {
  checking: "確認中",
  synced: "リスト同期済み",
  syncFailed: "リスト同期に失敗",
  daysWith: (d: string) => `一緒に ${d} 日 · 排除した数`,
  spamAccounts: "件のスパムアカウント",
  hitList: "リスト一致",
  hitListHint: "公開リストに一致、ローカル判定",
  byHand: "手動対応",
  byHandHint: "自分で非表示 / ミュート / ブロックしたアカウント",
  syncing: "リスト同期中…",
  entries: "件",
  syncRetry: "未同期 · 自動で再試行します",
  openPanel: "管理パネルを開く",
  protectMe: "自分のアカウントを保護 · ホワイトリスト",
  publicList: "公榜",
  thisRepo: "このリポジトリ",
  upstream: "元プロジェクト",
  governance: "なぜ / ガバナンス",
  governanceTail: "— 判定は自動公開されません。人手またはコミュニティの合意が必要です",
};
const DICT = { zh: ZH, en: EN, ja: JA } as const;

function stringsFor(locale: ResolvedLocale): typeof ZH {
  return DICT[locale] ?? ZH;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}
function daysWith(ms: number): number {
  if (!ms) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

/** 语言快捷滑块（二开）：popup 顶部一排，点了立即生效并持久化。 */
function LocaleSwitch({
  pref,
  onPick,
}: {
  pref: UiLocale;
  onPick: (v: UiLocale) => void;
}) {
  return (
    <div className="flex flex-none items-center gap-1" aria-label="语言 / Language">
      {UI_LOCALES.map((l) => (
        <button
          key={l.value}
          type="button"
          onClick={() => onPick(l.value)}
          className={`cursor-pointer rounded border px-1.5 py-0.5 text-[10px] transition ${
            pref === l.value
              ? "border-fg bg-card-hi text-fg"
              : "border-border-2 text-fg-4 hover:text-fg-2"
          }`}
        >
          {l.value === "auto" ? "A" : l.value === "zh" ? "中" : l.value === "en" ? "EN" : "日"}
        </button>
      ))}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: number;
  hint: string;
  accent?: boolean;
}) {
  return (
    <div
      title={hint}
      className={`rounded-md border px-2 py-1.5 ${
        accent ? "border-ok/30 bg-ok-soft" : "border-border bg-card-hi"
      }`}
    >
      <div className={`text-[10px] font-medium ${accent ? "text-ok" : "text-fg-3"} tracking-tight`}>
        {label}
      </div>
      <div
        className={`mt-0.5 font-mono text-[15px] font-semibold leading-none tabular-nums ${
          accent ? "text-ok" : "text-fg"
        }`}
      >
        {fmt(value)}
      </div>
    </div>
  );
}

export function App() {
  const [status, setStatus] = useState<{ ok: boolean; n: number } | null>(null);
  const [stats, setStats] = useState<LocalStats | null>(null);
  const [edgeBase, setEdgeBase] = useState<string>(BRAND.edgeBase);
  const [pref, setPref] = useState<UiLocale>("auto");

  useEffect(() => {
    bg<{ records: number }>({ type: "health" }).then((h) =>
      setStatus(h.ok && h.data ? { ok: true, n: h.data.records } : { ok: false, n: 0 }),
    );
    bg<LocalStats>({ type: "stats" }).then((r) => {
      if (r.ok && r.data) setStats(r.data);
    });
    getSettings().then((s) => {
      if (s.edgeBase) setEdgeBase(s.edgeBase);
      setPref(s.uiLocale);
    });
    const off = onSettingsChange((s) => setPref(s.uiLocale));
    return off;
  }, []);

  const t = stringsFor(resolveLocale(pref));
  const totalAssist = stats ? stats.hitPublic + stats.blocked : 0;
  const days = stats ? daysWith(stats.firstUsedAt) : 0;

  return (
    <div className="p-4">
      <header className="flex items-center gap-2">
        <img
          src={MASCOT_URL}
          alt=""
          width={26}
          height={26}
          className="rounded-md"
        />
        <b className="text-[14px] font-semibold tracking-[-.005em]">{BRAND.acronym}</b>
        <LocaleSwitch
          pref={pref}
          onPick={(v) => {
            setPref(v);
            void setSetting("uiLocale", v);
          }}
        />
        <span
          aria-label={status === null ? t.checking : status.ok ? t.synced : t.syncFailed}
          className={`ml-auto inline-flex h-2 w-2 rounded-full ${
            status === null ? "bg-fg-4" : status.ok ? "bg-ok" : "bg-danger"
          }`}
        />
      </header>

      {/* Achievement hero — the line the user actually feels proud about. */}
      <div className="mt-3 rounded-md border border-border bg-card px-3 py-2.5">
        <div className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-fg-3">
          {t.daysWith(fmt(days))}
        </div>
        <div className="mt-1 flex items-baseline gap-1.5">
          <span className="font-mono text-[26px] font-bold leading-none tabular-nums tracking-tight text-fg">
            {fmt(totalAssist)}
          </span>
          <span className="text-[11.5px] text-fg-3">{t.spamAccounts}</span>
        </div>
      </div>

      {/* Per-stat breakdown */}
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <Stat label={t.hitList} value={stats?.hitPublic ?? 0} hint={t.hitListHint} accent />
        <Stat label={t.byHand} value={stats?.blocked ?? 0} hint={t.byHandHint} />
      </div>

      <div
        className={`mt-3 flex items-baseline justify-between gap-2 rounded-md border px-3 py-2 text-xs ${
          status?.ok
            ? "border-border bg-card text-fg"
            : status?.ok === false
              ? "border-danger/30 bg-danger-soft text-danger"
              : "border-border bg-card text-fg-3"
        }`}
      >
        {status === null ? (
          <span>{t.syncing}</span>
        ) : status.ok ? (
          <>
            <span className="text-fg-3">{t.synced}</span>
            <span className="font-mono text-[13px] font-semibold tabular-nums tracking-tight">
              {fmt(status.n)}
              {t.entries && <span className="ml-1 font-sans text-[11px] font-normal text-fg-3">{t.entries}</span>}
            </span>
          </>
        ) : (
          <span>{t.syncRetry}</span>
        )}
      </div>

      <button
        type="button"
        onClick={() =>
          chrome.tabs.create({ url: chrome.runtime.getURL("options.html") })
        }
        className="mt-3 w-full cursor-pointer rounded-md border border-fg bg-fg px-3 py-2.5 text-[13px] font-semibold text-bg transition hover:opacity-90 active:translate-y-px"
      >
        {t.openPanel}
      </button>

      <button
        type="button"
        onClick={() =>
          chrome.tabs.create({ url: chrome.runtime.getURL("options.html?tab=whitelist") })
        }
        className="mt-1.5 w-full cursor-pointer rounded-md border border-ok/40 bg-ok-soft px-3 py-2 text-[12.5px] font-medium text-ok transition hover:opacity-90 active:translate-y-px"
      >
        {t.protectMe}
      </button>

      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <a
          href={`${edgeBase}/list`}
          target="_blank"
          rel="noopener"
          className="rounded-md border border-border-2 px-2.5 py-1.5 text-center text-[12px] text-fg-2 transition hover:bg-card-hi hover:text-fg"
        >
          {t.publicList}
        </a>
        <a
          href={BRAND.repo}
          target="_blank"
          rel="noopener"
          className="rounded-md border border-border-2 px-2.5 py-1.5 text-center text-[12px] text-fg-2 transition hover:bg-card-hi hover:text-fg"
        >
          {t.thisRepo}
        </a>
        <a
          href={BRAND.upstreamRepo}
          target="_blank"
          rel="noopener"
          className="rounded-md border border-border-2 px-2.5 py-1.5 text-center text-[12px] text-fg-2 transition hover:bg-card-hi hover:text-fg"
        >
          {t.upstream}
        </a>
      </div>

      <footer className="mt-3 border-t border-border pt-2.5 text-[11px] leading-[1.6] text-fg-3">
        <a
          href={BRAND.governance}
          target="_blank"
          rel="noopener"
          className="text-fg-2 hover:text-fg"
        >
          {t.governance}
        </a>
        <span className="ml-1">{t.governanceTail}</span>
      </footer>
    </div>
  );
}
