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
| **F1** | 自定义词库 GitHub 同步 | 本机 ↔ 你的仓库双向同步，写权限鉴权 |
| **F2** | 白名单改绑 | 账号改名后迁移已批准名额（Issue 通道 + 可选自部署自动） |
| **F3** | 黑名单一键拉黑 | 多层限速 + 单次限量 + 失败熔断，防风控 |
| **F4** | X 原生拉黑列表 | 同步已拉黑账号，支持一键解除 |
| **F5** | 本地规则动作开关 | 默认仅隐藏；可开启后按策略执行静音/拉黑 |
| **F6** | KOL 悬浮卡 | 悬停 @handle 显示年龄、原创比、主题集中度、可信分（本地采样，可选 GraphQL 精确增强） |

另外已支持：全局 UI 多语言（跟随浏览器 / 可切换）、KOL 卡 zh/en/ja、AI 干净账号绿色幽灵徽标等。

---


## 安装

### 普通用户（推荐）

1. 打开 [Releases](https://github.com/xiaoyi36c/filtrationX/releases)
2. 下载最新 `filtrationX-*-chrome-mv3.zip` 并解压
3. 浏览器打开 `chrome://extensions` → 开启「开发者模式」
4. 「加载已解压的扩展程序」→ 选择解压目录
5. 访问 [x.com](https://x.com)，扩展自动生效

> 若已安装商店版 MXGA，建议先禁用，避免两个扩展同时检测同一页面。

### 从源码构建

```bash
git clone https://github.com/xiaoyi36c/filtrationX.git
cd filtrationX/extension
npm install          # 或 pnpm install
npm run build        # 产物在 .output/chrome-mv3
```

---

---

## 服务端（可选）

`services/edge` 新增 `POST /v1/whitelist/apply/rebind`：与首次申请共用 GitHub 身份和反滥用校验，要求名下存在仍生效的已批准申请；配套迁移 `services/edge/migrations/2026-10-24-whitelist-rebind.sql`。

不部署不影响扩展其他功能；自部署后在「设置 → 高级」把服务地址改成你的 Worker 即可启用全自动改绑。

## 隐私与许可

数据仅存本机；词库同步只读写你指定的那个仓库文件，拉黑同步不上传任何内容。

隐私细节见上游 [PRIVACY](https://github.com/foru17/make-x-great-again#privacy) 与本仓库 [docs/PRIVACY.md](./docs/PRIVACY.md)。许可证沿用上游 [AGPL-3.0](./LICENSE)。
