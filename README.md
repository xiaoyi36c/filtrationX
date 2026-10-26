# filtrationX

> 本地优先的 X（原 Twitter）垃圾账号过滤浏览器扩展——广告号、色情机器人、互关农场自动识别隐藏。基于 make-x-great-again 二次开发。

![在 X 上自动识别垃圾账号](extension/store-assets/v0.5.0/01-on-x-detection.jpg)

## ✨ 功能亮点

- **本地优先**：匹配逻辑全部本地运行，账号与浏览数据只存本机，默认不上传
- **垃圾账号自动过滤**：社区公开黑名单 6 小时自动同步 + 关键词规则 + 本地反养号启发式（互关农场 / 问候模板刷屏 / 高频发帖 / 电商促销墙）；处理动作可选仅标记、本地隐藏、静音、拉黑
- **批量拉黑 / 一键关注**：限速 + 失败熔断 + 断点续传，降低账号风控风险；失效账号自动识别跳过
- **拉黑列表同步**：读取你在 X 上已拉黑的账号，分页浏览，支持一键解除
- **NSFW&成人榜单**：聚合福利鉴 / 女菩萨 / NSFW 导航三个公开榜单（仅存本机），按筛选一键关注
- **KOL 可信悬浮卡**：悬停即看账号年龄、原创占比、可信评分（本地采样，可选 GraphQL 提精度）
- **白名单迁移 + 词库双向同步**：账号改名可迁移白名单资格；本机规则 ↔ 你的 GitHub 仓库
- **UI 多语言**：中 / 英 / 日，跟随浏览器语言

## 🚀 快速安装

1. 前往 [Releases](https://github.com/xiaoyi36c/filtrationX/releases) 下载 `filtrationX-*-chrome-mv3.zip` 并解压
2. 打开 `chrome://extensions`，开启开发者模式
3. 「加载已解压的扩展程序」→ 选中解压后的文件夹
4. 打开 [x.com](https://x.com) 自动生效

> ⚠️ 若已安装原版 MXGA，请先禁用，避免冲突。

源码构建：

```bash
git clone https://github.com/xiaoyi36c/filtrationX.git
cd filtrationX/extension
npm install
npm run build   # 产物在 .output/chrome-mv3
```

## 🤝 贡献指南

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 📄 许可证

[AGPL-3.0](LICENSE)。账号与浏览数据只保存在本地；词库同步仅读写你指定的 GitHub 仓库；拉黑/关注操作复用你浏览器的 X 登录态，不上传浏览信息。
