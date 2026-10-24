// Two-way sync of user-authored custom keyword rules with a file in the
// USER'S OWN GitHub repository (Contents API). This is the 二开 answer to
// "本地关键词也支持上传到我的仓库文件，新增关键词能同步到仓库":
//
//   push  — overwrite the repo file with the local custom rules (backup /
//           publish semantics; local deletions propagate).
//   pull  — merge the repo file INTO local rules (union by pattern+field;
//           the local category wins a conflict; never removes local rows).
//   sync  — two-way merge: pull the union into local, then push the union
//           back. This is what the periodic background sync runs so a rule
//           edited directly in the GitHub file lands on the device, and a
//           rule added on the device lands in the repo. Deletions do NOT
//           propagate through sync (union semantics) — use push to prune.
//   auto  — when config.autoSync is on, every add/remove on this device
//           fires a push right after saving, and the background alarm runs
//           a two-way sync on the 6h cadence (mirrors the list sync).
//
// The repo file is therefore a CONFIGURABLE RULE SOURCE: the user keeps a
// keyword library in their own fork (e.g. xiaoyi36c/filtrationX), edits it on
// GitHub, and the extension keeps both sides converging — on top of the
// official repo's maintainer-curated rules, which remain untouched.
//
// Auth reuses the shared GitHub token (lib/auth.ts xss:ghToken). The token
// must carry repo write access: Device Flow now requests the "repo" scope
// (entrypoints/background.ts) and legacy read:user tokens fail with a clear
// "权限不足" message — re-login once to upgrade.
//
// The sync talks ONLY to api.github.com; the file content is the user's own
// rule list — nothing from X (no handles, no telemetry, no page content)
// is ever written.
import { validateCustomRules, type CustomRule } from "./local-rules";

export interface RulesSyncConfig {
  owner: string;
  repo: string;
  branch: string;
  /** Repo-relative file path, e.g. "mxga/custom-rules.json". */
  path: string;
  /** Push automatically after every local add/remove. */
  autoSync: boolean;
}

const CFG_KEY = "xss:rules:sync";

export const DEFAULT_SYNC_CONFIG: RulesSyncConfig = {
  owner: "",
  repo: "",
  branch: "main",
  path: "mxga-custom-rules.json",
  autoSync: false,
};

export async function getRulesSyncConfig(): Promise<RulesSyncConfig> {
  try {
    const got = await chrome.storage.local.get(CFG_KEY);
    const v = got[CFG_KEY] as Partial<RulesSyncConfig> | undefined;
    if (!v || typeof v !== "object") return { ...DEFAULT_SYNC_CONFIG };
    return {
      owner: typeof v.owner === "string" ? v.owner.trim() : "",
      repo: typeof v.repo === "string" ? v.repo.trim() : "",
      branch: typeof v.branch === "string" && v.branch.trim() ? v.branch.trim() : DEFAULT_SYNC_CONFIG.branch,
      path: typeof v.path === "string" && v.path.trim() ? v.path.trim() : DEFAULT_SYNC_CONFIG.path,
      autoSync: v.autoSync === true,
    };
  } catch {
    return { ...DEFAULT_SYNC_CONFIG };
  }
}

export async function saveRulesSyncConfig(cfg: RulesSyncConfig): Promise<RulesSyncConfig> {
  const clean: RulesSyncConfig = {
    owner: cfg.owner.trim().replace(/^\/+|\/+$/g, ""),
    repo: cfg.repo.trim().replace(/^\/+|\/+$/g, "").replace(/\.git$/i, ""),
    branch: cfg.branch.trim() || DEFAULT_SYNC_CONFIG.branch,
    path: cfg.path.trim().replace(/^\/+/, "") || DEFAULT_SYNC_CONFIG.path,
    autoSync: cfg.autoSync === true,
  };
  await chrome.storage.local.set({ [CFG_KEY]: clean });
  return clean;
}

export function isSyncConfigured(cfg: RulesSyncConfig): boolean {
  return !!cfg.owner && !!cfg.repo && !!cfg.path && !!cfg.branch;
}

// ---- Repo file shape ----

export interface RulesSyncFile {
  version: 1;
  updatedAt: string;
  rules: CustomRule[];
}

function parseRulesFile(raw: string): CustomRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("仓库文件不是合法 JSON");
  }
  // Accept both the wrapped {version, rules} shape and a bare CustomRule[]
  // so hand-edited repo files still load.
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as RulesSyncFile).rules)
      ? (parsed as RulesSyncFile).rules
      : null;
  if (!rows) throw new Error("仓库文件格式不识别（应为规则数组或 {rules:[…]}）");
  return validateCustomRules(rows);
}

// ---- UTF-8 safe base64 (Contents API content is base64) ----

function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(s: string): string {
  const bin = atob(s.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ---- GitHub Contents API ----

const API = "https://api.github.com";

function ghHeaders(token: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };
}

function contentsUrl(cfg: RulesSyncConfig): string {
  const segs = cfg.path.split("/").map(encodeURIComponent).join("/");
  return `${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${segs}?ref=${encodeURIComponent(cfg.branch)}`;
}

interface ContentsResponse {
  sha?: string;
  content?: string;
}

async function fetchRemote(token: string, cfg: RulesSyncConfig): Promise<{ sha: string | null; rules: CustomRule[] }> {
  const r = await fetch(contentsUrl(cfg), { headers: ghHeaders(token), cache: "no-store" });
  if (r.status === 404) return { sha: null, rules: [] }; // file (or repo/branch) doesn't exist yet
  if (r.status === 401) throw new Error("GitHub 令牌无效或已过期，请重新登录");
  if (r.status === 403) throw new Error("GitHub 拒绝访问（令牌缺少 repo 权限或触发限流），请重新登录授权");
  if (!r.ok) throw new Error(`读取仓库文件失败（HTTP ${r.status}）`);
  const j = (await r.json()) as ContentsResponse;
  if (!j.sha || !j.content) return { sha: j.sha ?? null, rules: [] };
  return { sha: j.sha, rules: parseRulesFile(b64decode(j.content)) };
}

async function putRemote(
  token: string,
  cfg: RulesSyncConfig,
  rules: CustomRule[],
  sha: string | null,
): Promise<void> {
  const file: RulesSyncFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    rules,
  };
  const r = await fetch(contentsUrl(cfg), {
    method: "PUT",
    headers: ghHeaders(token),
    body: JSON.stringify({
      message: `MXGA custom rules sync (${rules.length} rules)`,
      content: b64encode(JSON.stringify(file, null, 2) + "\n"),
      branch: cfg.branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (r.status === 401) throw new Error("GitHub 令牌无效或已过期，请重新登录");
  if (r.status === 403) throw new Error("GitHub 拒绝写入（令牌缺少 repo 写权限或触发限流），请重新登录授权");
  if (r.status === 404) throw new Error("仓库、分支或路径不存在，请检查配置");
  if (r.status === 409) throw new Error("仓库文件已被他人更新（冲突），请先拉取再上传");
  if (!r.ok) throw new Error(`写入仓库文件失败（HTTP ${r.status}）`);
}

// ---- Merge + public entry points ----

/** Union of local + remote by pattern(lower)+field; the LOCAL category wins a
 *  conflict (this device is the source of truth for its own rules). Exported
 *  for tests. */
export function mergeRules(
  local: CustomRule[],
  remote: CustomRule[],
): { merged: CustomRule[]; pulled: number } {
  const byKey = new Map<string, CustomRule>();
  for (const r of local) byKey.set(`${r.pattern.toLowerCase()}${r.field}`, r);
  let pulled = 0;
  for (const r of remote) {
    const key = `${r.pattern.toLowerCase()}${r.field}`;
    if (!byKey.has(key)) {
      byKey.set(key, r);
      pulled++;
    }
  }
  return { merged: [...byKey.values()], pulled };
}

export type RulesSyncOutcome =
  | { ok: true; action: "pushed" | "pulled"; ruleCount: number; pulled: number }
  | { ok: false; error: string };

function configError(cfg: RulesSyncConfig, hasToken: boolean): string | null {
  if (!hasToken) return "尚未登录 GitHub";
  if (!isSyncConfigured(cfg)) return "请先填写仓库（owner/repo）、分支与文件路径";
  return null;
}

// ---- Auth gate (二开: 鉴权后自定义数据才能同步上传到仓库) ----

export interface RepoAccess {
  ok: boolean;
  /** Token may WRITE to the repo (GitHub's permissions.push on /repos). */
  canPush: boolean;
  error?: string;
}

/** Explicit authorization check for the target repo, run BEFORE any write:
 *  valid token → repo visible → repo writable. Surfaces a distinct message
 *  for the legacy read:user token (logged in, but no repo scope) so the
 *  options page can send the user to re-login instead of a cryptic 403. */
export async function verifyRepoAccess(token: string, cfg: RulesSyncConfig): Promise<RepoAccess> {
  const err = configError(cfg, !!token);
  if (err) return { ok: false, canPush: false, error: err };
  try {
    const r = await fetch(
      `${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`,
      { headers: ghHeaders(token), cache: "no-store" },
    );
    if (r.status === 401) {
      return { ok: false, canPush: false, error: "GitHub 令牌无效或已过期，请重新登录" };
    }
    if (r.status === 404) {
      return { ok: false, canPush: false, error: "仓库不存在或该令牌无权访问，请检查 owner/repo 与登录身份" };
    }
    if (!r.ok) {
      return { ok: false, canPush: false, error: `检查仓库权限失败（HTTP ${r.status}）` };
    }
    const j = (await r.json()) as { permissions?: { push?: boolean } };
    if (j.permissions?.push !== true) {
      return {
        ok: false,
        canPush: false,
        error: "当前 GitHub 登录对该仓库没有写权限——若是旧版登录（仅 read:user），请退出后重新登录；若目标仓库不属于你，请改成你自己的仓库",
      };
    }
    return { ok: true, canPush: true };
  } catch (e) {
    return { ok: false, canPush: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Push: overwrite the repo file with the local custom rules. Gated by the
 *  auth check — a write NEVER goes out before the token has been verified
 *  against the target repo. */
export async function pushRules(token: string, cfg: RulesSyncConfig): Promise<RulesSyncOutcome> {
  const access = await verifyRepoAccess(token, cfg);
  if (!access.ok) return { ok: false, error: access.error ?? "鉴权未通过" };
  try {
    const local = validateCustomRules(
      (await chrome.storage.local.get("xss:rules:custom"))["xss:rules:custom"],
    );
    const remote = await fetchRemote(token, cfg);
    await putRemote(token, cfg, local, remote.sha);
    return { ok: true, action: "pushed", ruleCount: local.length, pulled: 0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Pull: merge the repo file into local rules and persist the union. */
export async function pullRules(
  token: string,
  cfg: RulesSyncConfig,
  persist: (rules: CustomRule[]) => Promise<CustomRule[]>,
): Promise<RulesSyncOutcome> {
  const err = configError(cfg, !!token);
  if (err) return { ok: false, error: err };
  try {
    const local = validateCustomRules(
      (await chrome.storage.local.get("xss:rules:custom"))["xss:rules:custom"],
    );
    const remote = await fetchRemote(token, cfg);
    const { merged, pulled } = mergeRules(local, remote.rules);
    if (pulled > 0) await persist(merged);
    return { ok: true, action: "pulled", ruleCount: merged.length, pulled };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Two-way sync (union on both sides): repo edits → local, local additions →
 *  repo. Runs from the background alarm when the user opted into auto sync.
 *  `persist` writes the merged set (lib/local-rules saveCustomRules); the
 *  hot-swap storage listener picks it up in every open tab. */
export async function syncRules(
  token: string,
  cfg: RulesSyncConfig,
  persist: (rules: CustomRule[]) => Promise<CustomRule[]>,
): Promise<RulesSyncOutcome> {
  // Two-way sync writes to the repo too, so the same auth gate applies.
  const access = await verifyRepoAccess(token, cfg);
  if (!access.ok) return { ok: false, error: access.error ?? "鉴权未通过" };
  try {
    const local = validateCustomRules(
      (await chrome.storage.local.get("xss:rules:custom"))["xss:rules:custom"],
    );
    const remote = await fetchRemote(token, cfg);
    const { merged, pulled } = mergeRules(local, remote.rules);
    if (pulled > 0) await persist(merged);
    // Push the union back only when the repo is actually behind (local rows
    // missing remotely). A no-change sync would burn an API call + a commit.
    const key = (r: CustomRule) => `${r.pattern.toLowerCase()}${r.field}`;
    const remoteKeys = new Set(remote.rules.map(key));
    const needsPush = merged.length !== remote.rules.length || merged.some((r) => !remoteKeys.has(key(r)));
    if (needsPush) await putRemote(token, cfg, merged, remote.sha);
    return { ok: true, action: "pulled", ruleCount: merged.length, pulled };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Convenience wrapper used by the background alarm: returns null when sync
 *  isn't configured (no config / no token / autoSync off) so the caller can
 *  skip silently. */
export async function syncRulesIfConfigured(
  persist: (rules: CustomRule[]) => Promise<CustomRule[]>,
): Promise<RulesSyncOutcome | null> {
  const cfg = await getRulesSyncConfig();
  if (!cfg.autoSync || !isSyncConfigured(cfg)) return null;
  try {
    const { getGhToken } = await import("./auth");
    const token = await getGhToken();
    if (!token) return null;
    return await syncRules(token, cfg, persist);
  } catch {
    return null;
  }
}
