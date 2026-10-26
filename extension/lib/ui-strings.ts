// 管理面板全局文案表 (二开 M4.5)。
//
// key → { zh, en, ja }。取值走 lib/i18n 的 tr（缺译回退中文）。
// 本轮覆盖：侧边栏、各页页头、概览、拉黑同步、关于、语言、通用按钮。
// 处理记录 / 检测缓存 / 设置 / 白名单 / 备份 的表体文案下一批迁移。

import type { ResolvedLocale } from "./i18n";

type Row = { zh: string; en: string; ja: string };

export const D: Record<string, Row> = {
  "nav.overview": { zh: "概览", en: "Overview", ja: "概要" },
  "nav.blocklist": { zh: "处理记录", en: "Records", ja: "処理記録" },
  "nav.xblocks": { zh: "拉黑同步", en: "Block sync", ja: "ブロック同期" },
  "nav.flj": { zh: "福利鉴", en: "FLJ", ja: "福利鉴" },
  "nav.cache": { zh: "检测缓存", en: "Cache", ja: "判定キャッシュ" },
  "nav.settings": { zh: "设置", en: "Settings", ja: "設定" },
  "nav.language": { zh: "语言", en: "Language", ja: "言語" },
  "nav.whitelist": { zh: "白名单", en: "Whitelist", ja: "ホワイトリスト" },
  "nav.backup": { zh: "备份", en: "Backup", ja: "バックアップ" },
  "nav.about": { zh: "关于", en: "About", ja: "について" },
  "nav.publicList": { zh: "看公榜", en: "List", ja: "公榜" },
  "nav.thisRepo": { zh: "本项目 GitHub", en: "Repo (GitHub)", ja: "このリポジトリ" },
  "nav.upstream": { zh: "原项目 MXGA", en: "Upstream MXGA", ja: "元プロジェクト" },

  "page.overview.title": { zh: "概览", en: "Overview", ja: "概要" },
  "page.overview.sub": { zh: "本地统计 · 数据仅存于本机，不含个人隐私信息", en: "Local stats · data stays on this machine, no personal info", ja: "ローカル統計 · データは端末内のみ、個人情報は含まれません" },
  "page.blocklist.title": { zh: "处理记录", en: "Records", ja: "処理記録" },
  "page.blocklist.sub": { zh: "本机处理过的账号与原因 · 仅存本机", en: "Accounts processed locally and why · local only", ja: "処理したアカウントと理由 · 端末内のみ" },
  "page.xblocks.title": { zh: "X 原生拉黑列表", en: "Native X block list", ja: "X ネイティブブロック一覧" },
  "page.flj.title": { zh: "福利鉴博主", en: "FLJ bloggers", ja: "福利鉴ブロガー" },
  "page.flj.sub": {
    zh: "从 flj.info 榜单同步博主并一键关注 · 名单仅存本机 · 关注走你自己的 X 登录态",
    en: "Sync bloggers from flj.info rankings and follow in a queue · list stays local · uses your own X session",
    ja: "flj.info ランキングから同期して一括フォロー · 名単は端末内のみ",
  },
  "flj.sync": { zh: "同步榜单", en: "Sync rankings", ja: "同期" },
  "flj.syncing": { zh: "同步中…", en: "Syncing…", ja: "同期中…" },
  "flj.syncedAt": { zh: "同步于", en: "Synced", ja: "同期済み" },
  "flj.count": { zh: "榜单博主", en: "bloggers", ja: "ブロガー" },
  "flj.none": { zh: "还没有榜单数据，点「同步榜单」开始", en: "No rankings yet — click Sync", ja: "データなし、同期してください" },
  "flj.skipNegative": { zh: "排除负面标签（盗图/照骗/诈骗）", en: "Exclude negatively flagged", ja: "ネガティブ除外" },
  "flj.excludeFushi": { zh: "排除风俗业者", en: "Exclude adult-service", ja: "風俗除外" },
  "flj.batch": { zh: "本轮关注数量", en: "Batch size", ja: "バッチ数" },
  "flj.follow": { zh: "一键关注", en: "Follow queue", ja: "一括フォロー" },
  "flj.stop": { zh: "停止", en: "Stop", ja: "停止" },
  "flj.needTab": {
    zh: "执行需要打开一个 x.com 标签页（和你已登录的账号）",
    en: "Open an x.com tab (logged in) to execute",
    ja: "x.com タブ（ログイン済み）が必要",
  },
  "flj.progress": { zh: "进度", en: "Progress", ja: "進捗" },
  "page.cache.title": { zh: "检测缓存", en: "Detection cache", ja: "判定キャッシュ" },
  "page.settings.title": { zh: "设置", en: "Settings", ja: "設定" },
  "page.settings.sub": { zh: "配置仅存于本机", en: "Configuration is stored locally", ja: "設定は端末内にのみ保存されます" },
  "page.language.title": { zh: "语言 / Language / 言語", en: "Language / 语言 / 言語", ja: "言語 / Language / 语言" },
  "page.language.sub": { zh: "扩展界面语言 · 默认跟随浏览器语言，可手动钉死", en: "Extension UI language · defaults to your browser language, can be pinned", ja: "拡張 UI の言語 · 既定はブラウザ言語、手動固定も可能" },
  "page.whitelist.title": { zh: "白名单", en: "Whitelist", ja: "ホワイトリスト" },
  "page.whitelist.sub": { zh: "两份名单，对象不同：上面保护「你自己」不被别人误列；下面保护「你信任的人」不被本机误处理", en: "Two lists, two jobs: the top one protects YOU from being listed by others; the bottom one protects people you trust from being processed here", ja: "2 つのリスト：上は「自分」が誤登録されない保護、下は信頼する人が誤処理されない保護" },
  "page.backup.title": { zh: "备份", en: "Backup", ja: "バックアップ" },
  "page.backup.sub": { zh: "导出 / 导入你在本机的数据 · 换浏览器、换电脑时迁移", en: "Export / import your local data · migrate across browsers and machines", ja: "ローカルデータの書き出し / 読み込み · 環境移行用" },
  "page.about.title": { zh: "关于", en: "About", ja: "について" },
  "page.about.sub": { zh: "公益、开源", en: "Non-profit, open source", ja: "非営利・オープンソース" },

  "common.loading": { zh: "加载中…", en: "Loading…", ja: "読み込み中…" },
  "common.sync": { zh: "双向同步", en: "Two-way sync", ja: "双方向同期" },
  "common.pull": { zh: "从仓库拉取", en: "Pull from repo", ja: "リポジトリから取得" },
  "common.push": { zh: "上传（覆盖仓库）", en: "Push (overwrite repo)", ja: "アップロード（上書き）" },
  "common.checkAccess": { zh: "检查权限", en: "Check access", ja: "権限を確認" },
  "common.remove": { zh: "移除", en: "Remove", ja: "削除" },
  "common.account": { zh: "账号", en: "Account", ja: "アカウント" },
  "common.reason": { zh: "原因", en: "Reason", ja: "理由" },
  "common.time": { zh: "时间", en: "Time", ja: "日時" },
  "common.action": { zh: "动作", en: "Action", ja: "操作" },
  "common.search": { zh: "搜索", en: "Search", ja: "検索" },
  "common.close": { zh: "关闭", en: "Close", ja: "閉じる" },
  "common.confirm": { zh: "确认", en: "Confirm", ja: "確認" },
  "common.cancel": { zh: "取消", en: "Cancel", ja: "キャンセル" },

  "ov.syncingList": { zh: "同步名单…", en: "Syncing list…", ja: "リスト同期中…" },
  "ov.listSynced": { zh: "名单已同步", en: "List synced", ja: "リスト同期済み" },
  "ov.listNotSynced": { zh: "名单未同步 · 将自动重试", en: "List not synced · will retry", ja: "未同期 · 自動で再試行します" },
  "ov.entries": { zh: "条", en: "", ja: "件" },
  "ov.aiTotal": { zh: "AI 检测总数", en: "AI detections", ja: "AI 判定総数" },
  "ov.cacheHits": { zh: "缓存命中 · 省下的 AI 判定", en: "Cache hits · AI calls saved", ja: "キャッシュヒット · AI 判定を節約" },
  "ov.processed": { zh: "已处理账号", en: "Accounts processed", ja: "処理済みアカウント" },
  "ov.processedAuto": { zh: "已处理账号 · 其中自动 {n}", en: "Accounts processed · {n} automatic", ja: "処理済みアカウント · 自動 {n}" },
  "ov.spamPorn": { zh: "判定为垃圾/色情bot", en: "Marked spam / porn-bot", ja: "スパム/アダルトbot 判定" },
  "ov.listMakeup": { zh: "公共黑名单构成", en: "Public blocklist makeup", ja: "公開ブラックリストの構成" },
  "ov.autoPolicy": { zh: "自动处理策略", en: "Auto-action policy", ja: "自動処理ポリシー" },
  "ov.adjust": { zh: "调整 →", en: "Adjust →", ja: "調整 →" },
  "ov.catDist": { zh: "检测类别分布", en: "Verdict distribution", ja: "判定カテゴリ分布" },
  "ov.pornBot": { zh: "色情 bot", en: "Porn bots", ja: "アダルト bot" },
  "ov.spam": { zh: "垃圾", en: "Spam", ja: "スパム" },
  "ov.likely": { zh: "疑似", en: "Likely", ja: "疑い" },
  "ov.uncertain": { zh: "不确定", en: "Uncertain", ja: "不明" },
  "ov.legit": { zh: "正常", en: "Legit", ja: "正常" },
  "act.badge": { zh: "仅标记", en: "Badge only", ja: "マークのみ" },
  "act.hide": { zh: "本地隐藏", en: "Hide locally", ja: "ローカル非表示" },
  "act.mute": { zh: "X 静音", en: "X mute", ja: "X ミュート" },
  "act.block": { zh: "X 拉黑", en: "X block", ja: "X ブロック" },

  "xb.search": { zh: "搜索 @handle / 显示名 / ID", en: "Search @handle / name / ID", ja: "@handle / 名前 / ID を検索" },
  "xb.count": { zh: "共 {n} 个 · 你 X 账号原生已拉黑的账号（只读同步，仅存本机）· 误拉黑的账号可在右侧「解除拉黑」恢复", en: "{n} total · accounts you natively blocked on X (read-only sync, local only) · undo any with Unblock on the right", ja: "計 {n} 件 · X でブロックしたアカウント（読み取り専用同期、端末内のみ）· 誤ブロックは右の「解除」で戻せます" },
  "xb.syncNow": { zh: "同步拉黑列表", en: "Sync block list", ja: "ブロック一覧を同期" },
  "xb.resync": { zh: "重新同步", en: "Re-sync", ja: "再同期" },
  "xb.syncing": { zh: "同步中…", en: "Syncing…", ja: "同期中…" },
  "xb.fetched": { zh: "已获取 {n} 个（{p} 页）· 保持一个 x.com 标签页打开", en: "Fetched {n} ({p} pages) · keep one x.com tab open", ja: "{n} 件取得（{p} ページ）· x.com のタブを開いたままに" },
  "xb.emptyNone": { zh: "没有匹配的账号", en: "No matching accounts", ja: "該当するアカウントはありません" },
  "xb.emptyNever": { zh: "还没有同步过——点上方「同步拉黑列表」获取你 X 账号过往已拉黑的账号", en: "Never synced — click Sync block list above to pull accounts you blocked on X", ja: "未同期 — 上の「ブロック一覧を同期」で過去のブロックを取得できます" },
  "xb.unblock": { zh: "解除拉黑", en: "Unblock", ja: "ブロック解除" },
  "xb.unblocking": { zh: "解除中…", en: "Unblocking…", ja: "解除中…" },
  "xb.lastSync": { zh: "上次同步", en: "Last sync", ja: "前回の同期" },
  "xb.never": { zh: "从未", en: "never", ja: "未実施" },
  "xb.autoNote": { zh: "每 6 小时自动同步一次", en: "Auto-syncs every 6 hours", ja: "6 時間ごとに自動同期" },
  "xb.needLogin": { zh: "需要 GitHub 之外的 X 登录态：点同步后浏览器会跳到 X 授权，保持登录即可", en: "Needs your X session: after clicking sync, the browser opens X for authorization — just stay logged in", ja: "X のセッションが必要：同期ボタンを押すと X の認証へ移動します。ログイン状態を保ってください" },

  "about.body": {
    zh: "X(Twitter) 反垃圾 / 色情机器人扩展。被动检测：公共名单由扩展定期从官方源自动同步（只下载公开名单数据，不上传任何内容），比对全部在本机完成。如在「设置」里把手动或自动动作选为 X 静音 / 拉黑，则会用你当前的 X 登录态调用 X 自家接口对账号生效（仍不经过我们的服务器、不收集任何数据）。",
    en: "An anti-spam / anti-porn-bot extension for X (Twitter). Passive detection: the public list auto-syncs from official sources on a schedule (downloads only — nothing is uploaded), and all matching happens locally. If you set manual or auto actions to X mute / block in Settings, it calls X's own API with your X session (still never touching our servers, collecting nothing).",
    ja: "X (Twitter) 向けアンチスパム / アダルト bot 拡張。受動的検出：公開リストは公式ソースから定期同期（取得のみ、何も送信しません）、照合はすべて端末内。設定で X ミュート / ブロックを選ぶと、あなたの X セッションで X の API を呼び出します（当方サーバー経由なし、データ収集なし）。",
  },
  "about.license": { zh: "许可证", en: "License", ja: "ライセンス" },
  "about.repo": { zh: "仓库", en: "Repository", ja: "リポジトリ" },
  "about.publicList": { zh: "公榜", en: "Public list", ja: "公開リスト" },
  "about.recent100": { zh: "最近 100 条已确认 ↗", en: "Last 100 confirmed ↗", ja: "直近 100 件の確定分 ↗" },
  "about.governance": { zh: "治理", en: "Governance", ja: "ガバナンス" },
  "about.appeal": { zh: "申诉与移除机制 ↗", en: "Appeals & removal ↗", ja: "申し立てと削除 ↗" },
  "about.privacy": {
    zh: "隐私：除公开的 X 数字 ID 外不存储任何个人信息，数据默认仅在本机。AI 判定永不自动公开，须人工或社区共识（≥3 个独立 GitHub 上报人）确认。",
    en: "Privacy: nothing personal is stored beyond public X numeric IDs; data stays on your machine by default. AI verdicts are never auto-published — human or community consensus (≥3 independent GitHub reporters) required.",
    ja: "プライバシー：公開されている X の数字 ID 以外の個人情報は保存しません。データは既定で端末内のみ。AI 判定は自動公開されず、人手またはコミュニティの合意（独立した GitHub 報告者 3 名以上）が必要です。",
  },

  "lang.current": { zh: "当前生效", en: "Active", ja: "現在の言語" },
  "lang.autoNote": { zh: "（按浏览器语言解析为 {loc}）", en: "(resolved from your browser language: {loc})", ja: "（ブラウザ言語から {loc} に解決）" },
  "lang.scope": {
    zh: "覆盖范围：浏览器弹窗（popup）、x.com 上的徽标与 KOL 悬浮卡、本管理面板已支持三语。",
    en: "Coverage: the browser popup, badges & KOL card on x.com, and this dashboard are fully trilingual.",
    ja: "対応範囲：ブラウザポップアップ、x.com のバッジと KOL カード、この管理パネルは 3 言語対応です。",
  },
  "lang.autoBrowser": { zh: "自动（浏览器语言）", en: "Auto (browser language)", ja: "自動（ブラウザ言語）" },
  "lang.zh": { zh: "中文", en: "Chinese", ja: "中国語" },
  "lang.en": { zh: "English", en: "English", ja: "英語" },
  "lang.ja": { zh: "日本語", en: "Japanese", ja: "日本語" },
} as const satisfies Record<string, Row>;

/** 取一条文案（已解析语言）。 */
export function pick(locale: ResolvedLocale, key: string, vars?: Record<string, string | number>): string {
  let s: string = D[key]?.[locale] ?? D[key]?.zh ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}
