// 全局 UI 多语言基础设施 (M4.5)。
//
// 设计：
//   - 设置项 uiLocale: "auto" | "zh" | "en" | "ja"，默认 "auto"。
//   - "auto" 解析为【浏览器语言】（navigator.language）——不是 X.com 的
//     界面语言（那是 KOL 卡第一版的行为，用户明确否决：X 界面英文不代表
//     用户想看英文扩展）。
//   - 各模块自带 zh/en/ja 三语文案表，用 tr() 取值；缺译回退中文。
//
// 逐步铺开：popup / X 拉黑页 / KOL 卡已接入；其余管理面板页面仍为中文，
// 后续按页迁移。

export type UiLocale = "auto" | "zh" | "en" | "ja";
export type ResolvedLocale = "zh" | "en" | "ja";

export const UI_LOCALES: { value: UiLocale; label: string }[] = [
  { value: "auto", label: "自动" },
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
];

/** 浏览器语言 → 支持的三语之一（不支持的语言回退英文）。 */
export function browserLocale(): ResolvedLocale {
  try {
    const langs: string[] = [navigator.language, ...(navigator.languages ?? [])];
    for (const l of langs) {
      const s = (l || "").toLowerCase();
      if (s.startsWith("zh")) return "zh";
      if (s.startsWith("ja")) return "ja";
    }
  } catch {
    /* 无 navigator（极端环境）→ 英文 */
  }
  return "en";
}

export function resolveLocale(pref: UiLocale | undefined): ResolvedLocale {
  if (pref === "zh" || pref === "en" || pref === "ja") return pref;
  return browserLocale();
}

/** 三语字典取值：缺译回退中文，再不行回退任意有值的。 */
export function tr(
  locale: ResolvedLocale,
  dict: Partial<Record<ResolvedLocale, string>>,
): string {
  return dict[locale] ?? dict.zh ?? dict.en ?? dict.ja ?? "";
}