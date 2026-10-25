# filtrationX

**本地优先的 X（Twitter）垃圾号过滤扩展**

社区共建公开黑名单 + 本地关键词 + KOL 可信信号。  
基于 [Make X Great Again (MXGA)](https://github.com/foru17/make-x-great-again) 二次开发，AGPL-3.0。

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.2.2-green.svg)](https://github.com/xiaoyi36c/filtrationX/releases)
[![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge%20%7C%20Brave%20%7C%20Arc-lightgrey.svg)](#安装)

---

## 这是什么

filtrationX 帮你在刷 X 时自动标出广告号、色情 bot 等垃圾账号，支持本地隐藏 / 静音 / 拉黑，并提供 KOL 可信度悬浮卡。

- **本地优先**：名单与规则在本地匹配，默认不上传浏览内容
- **社区名单**：每 6 小时同步公开黑名单
- **可扩展**：自定义规则可双向同步到你自己的 GitHub 仓库
- **隐私可控**：X 原生拉黑 / 静音仅用你的登录态，结果只存本机

上游完整文档、治理与隐私说明见：[foru17/make-x-great-again](https://github.com/foru17/make-x-great-again)

---

## 功能一览

### 继承自上游（MXGA）

| 能力 | 说明 |
|------|------|
| 公开黑名单 | 6 小时同步，本地匹配 |
| 关键词规则 | 官方规则 + 本地自定义 |
| 处理动作 | 仅标记 / 本地隐藏 / X 静音 / X 拉黑 |
| 在线 AI 检测 | GitHub 登录后可选 |
| 本地白名单 | 最高优先级，永不处理 |

### 本分支增强

| # | 功能 | 简介 |
|---|------|------|
| **F1** | 自定义词库 GitHub 同步 | 本机 ↔ 你的仓库双向同步，登录后自动识别账号与可写仓库，写权限鉴权 |
| **F2** | 白名单改绑 | 账号改名后迁移已批准名额（Issue 通道 + 可选自部署全自动） |
| **F3** | 黑名单一键拉黑 | 限速队列 + 单次限量 + 失败熔断，进度持久化、可暂停续跑 |
| **F4** | X 原生拉黑列表 | 只读同步已拉黑账号，行内一键解除误拉黑 |
| **F5** | 本地规则动作开关 | 默认仅隐藏；开启后按类别策略执行静音 / 拉黑 |
| **F6** | KOL 悬浮卡 | 悬停 @handle 显示年龄、原创比、主题集中度、综合可信分（本地采样；可选 GraphQL 精确互动） |

另外：全局界面多语言（默认跟随浏览器语言，可切换中文 / English / 日本語）、AI 判定干净的账号显示低调的绿色「已检」徽标、绿鸟图标（滤鸟）。

---


## 安装

### 普通用户（推荐）

1. 打开 [Releases](https://github.com/xiaoyi36c/filtrationX/releases)
2. 下载最新 `filtrationX-v0.2.2-chrome-mv3.zip` 并解压
3. 浏览器打开 `chrome://extensions` → 开启「开发者模式」
4. 「加载已解压的扩展程序」→ 选择解压目录
5. 访问 [x.com](https://x.com)，扩展自动生效

> 若已安装商店版 MXGA，建议先禁用，避免两个扩展同时检测同一页面。

### 从源码构建

```bash
git clone https://github.com/xiaoyi36c/filtrationX.git
cd filtrationX/extension
npm install
npm run build        # 产物在 .output/chrome-mv3
```

---


## 功能详情

<details>
<summary><b>F1 · 词库托管到自己的仓库</b></summary>

自定义关键词以 JSON 文件（默认 `mxga-custom-rules.json`）存在你自己的仓库里：

- 本机增删关键词后自动推送；在 GitHub 网页上直接编辑，每 6 小时自动合并回本机，也可手动双向同步
- 登录后 owner 自动取自登录账号，仓库以下拉列出（自动过滤出你有写权限的）
- 上传前校验令牌写权限；官方同步的关键词照常生效，两套词库互不影响

入口：设置 → 检测规则 → 自定义规则 → 「同步到我的 GitHub 仓库」

</details>

<details>
<summary><b>F2 · 白名单改绑</b></summary>

账号改名后，已批准的官方白名单名额可以迁到新 id。

- 新 id 取自当前登录的 X 账号，与首次申请同一套鉴权和人工审核
- 批准时名额自动迁移，旧 id 退出白名单并保留审计记录
- 自动改绑端点需自部署 edge；未部署时扩展生成预填好的 GitHub Issue 走人工通道

入口：白名单页 → 已批准面板 → 「改绑新的 X id」

</details>

<details>
<summary><b>F3 · 黑名单一键拉黑</b></summary>

把公共黑名单条目用你的 X 登录态批量原生拉黑，节奏是刻意放慢的：

- 限速：后台泵 2.5 秒 + 随机抖动，叠加 1.2 秒限速队列，实际约 4–5 秒一个
- 限量：单次执行 100 / 300 / 500 自选，绝不整表跑
- 熔断：连续 5 次失败自动停止
- 需保持一个打开的 x.com 标签页作为执行器；支持暂停 / 继续 / 停止，进度本地持久化，关浏览器不丢
- 已处理过、白名单和你自己的账号一律跳过，结果落账到「处理记录」

入口：概览页 → 「黑名单一键拉黑」任务卡

</details>

<details>
<summary><b>F4 · 拉黑同步与误操作恢复</b></summary>

把 X 账号过往已拉黑的账号拉回来看——新装扩展显示 0，点「同步拉黑列表」即可。

- 分页拉取 X 的 `blocks/list.json`（只读，每页 200 个，页间自动停顿），存本机
- 「拉黑同步」页提供搜索过滤，样式与处理记录一致
- 误拉黑的账号在行内点「解除拉黑」恢复，走同一套限速队列，成功即时生效
- 同步与解除都是单账号只读 / 单条操作，结果仅存本机

入口：概览页卡片（同步）→ 侧边栏「拉黑同步」页（明细与解除）

</details>

<details>
<summary><b>F5 · 本地规则命中也执行动作</b></summary>

默认关闭，此时关键词命中最多本地隐藏。开启后规则命中按各类别设定的动作执行（含 X 静音 / 拉黑），仍受自动收录档位与「仅推文评论区」范围限制。

入口：设置 → 自动处理策略

</details>

<details>
<summary><b>F6 · KOL 悬浮卡（上游目标 02）</b></summary>

悬停在 @handle 上，浮卡展示账号可信信号：

- **档案指标**（M1）：账号年龄、粉丝 / 关注 / 推文、赞粉比、均赞/推——读自页面自身的 React fiber 桥，零联网
- **本地采样**（M2）：原创比、主题集中度、综合可信分（靠谱 / 一般 / 存疑 / 高风险四档 + 分项），随浏览累积，只存词频计数不存推文原文
- **精确互动**（M3，默认关）：悬停时按需拉取最近 20 条推文，计算单条获赞 / 转推 / 回复中位数与粉丝数之比，买粉号和刷赞号现形；独立读限速（≥400ms、429 冷却 10 分钟），结果缓存 3 天

入口：设置 → 开关「KOL 悬浮卡」；下方可查看 / 清空采样画像。使用时直接悬停任意 @handle。设计细节见 `docs/KOL-CARD-PLAN.md`。

---

</details>

---

## 更新日志

见 [CHANGELOG.md](./CHANGELOG.md)。v0.2.2（2026-10-25）要点：

- KOL 悬浮卡完整落地（M1 档案 → M2 采样 → M3 可选精确互动 → M4 打磨）
- 全局多语言：popup、管理面板框架、悬浮卡三语；语言独立设置页
- 「已检」标、徽标与悬浮卡互斥、同账号可反复悬停
- 词库同步自动识别账号与仓库；绿鸟图标

## 服务端（可选）

`services/edge` 新增 `POST /v1/whitelist/apply/rebind`：与首次申请共用 GitHub 身份和反滥用校验，要求名下存在仍生效的已批准申请；配套迁移 `services/edge/migrations/2026-10-24-whitelist-rebind.sql`。

不部署不影响扩展其他功能；自部署后在「设置 → 高级」把服务地址改成你的 Worker 即可启用全自动改绑。

## 隐私与许可

数据仅存本机；词库同步只读写你指定的那个仓库文件，拉黑同步不上传任何内容。

隐私细节见上游 [PRIVACY](https://github.com/foru17/make-x-great-again#privacy) 与本仓库 [docs/PRIVACY.md](./docs/PRIVACY.md)。许可证沿用上游 [AGPL-3.0](./LICENSE)。
