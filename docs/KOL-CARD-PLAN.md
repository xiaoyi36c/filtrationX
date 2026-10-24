# KOL 浮卡实施规划（上游计划目标 02）

> 状态：M1、M2、M3、M4 全部实现 ✅（P2 完整收尾）。M3 为可选增强，设置页默认关。
> 目标（来自上游 roadmap 02）：一看就知道这个 KOL 靠谱不 —— 鼠标停在 @handle 上 → 浮卡：账号年龄、原创比、主题集中度、交互质量。

## 一、交互设计

- 触发：`document` 级 `mouseover` 委托，命中 `[data-testid="User-Name"]` 内的 @handle 链接，450ms hover-intent 延迟后显示。
- 浮卡复用 `lib/ui.ts` popover 的交互骨架：顶层单例 overlay（规避 transformed 祖先的 fixed 定位问题）、视口翻转定位、rAF 跟随、120ms 延迟隐藏 + 卡片悬停保活、CSS 变量主题（明暗 + X 三主题）。
- 着色：白名单 = 绿；账号年龄 < 30 天 = 琥珀；其余品牌蓝。M2 引入综合可信分后细化为四档。

## 二、指标定义与数据源

| 指标 | 计算方式 | 数据源 | 阶段 |
| --- | --- | --- | --- |
| 账号年龄 | `now - accountCreatedAt` | fiber/bridge（`data-mxga-u`，`lib/x-user-bridge.ts`） | M1 ✅ 零 API |
| 互动效率（M1 近似） | 赞粉比 `favouritesCount/followersCount`、均赞/推 `favouritesCount/statusesCount` | 同上 | M1 ✅ 零 API |
| 原创比 | 原创推文 / 总采样推文（statusId 去重；socialContext 转推行记给转推者） | M2 ✅：scan 累积采样（`lib/kol-signals.ts`）；M3：UserTweets GraphQL `legacy.retweeted` | M2 ✅ / M3 |
| 主题集中度 | 最近采样推文文本本地分词（CJK 二元组 + 拉丁词）→ 词的推文覆盖度（文档频率）→ 随机两条推文的期望共享词数 / 单条平均词数，只存计数不存原文 | M2 ✅：scan 推文文本采样；M3：UserTweets | M2 ✅ / M3 |
| 综合可信分 | 年龄 30% + 关注网络形态 25% + 互动形态 25% + 原创比 20%，缺项回中性；四档着色（靠谱/一般/存疑/高风险）；卡片展示分项 | `lib/kol-signals.ts` trustAssessment | M2 ✅ / M4 ✅ |
| 精确交互质量 | 单条推文 reply/retweet/like 中位数 vs 粉丝数（买粉死号/刷赞号现形），互动分优先用它 | M3 ✅：UserTweets GraphQL（默认关，hover 按需 + 限速 + 缓存 3 天） | M3 ✅ |

关键事实：X 的 MAIN-world React fiber 里免费携带 `accountCreatedAt / followersCount / followingCount / statusesCount / favouritesCount`（`lib/detect.ts` readFiberUser），经 `entrypoints/x-bridge.content.ts` stamp 到 DOM 后，isolated world 零成本读取——M1 的全部指标因此零网络请求。

## 三、数据获取分层

- **L1 页面免费数据（M1 ✅）**：fiber/bridge 档案 + User-Name 显示名提取。桥未 stamp 的节点静默不显示（白名单账号除外——只报身份标识）。
- **L2 本地累积画像（M2 ✅）**：按作者聚合到 `lib/kol-signals.ts` 采样缓存（单键 map：key=lowercase handle，TTL 3 天惰性过期，上限 600 条按 updatedAt 淘汰）；scan 对每条可见推文记一笔——可见作者计原创（statusId 环去重 40 条），socialContext 转推行把该笔记给转推者（`rt:` 前缀）；原创推文文本本地分词累积词频（只存计数不存原文）；写入 2s 防抖合并，content script 失效时落盘。
- **L3 GraphQL 精确增强（M3，默认关）**：UserTweets 拉最近 20 条 → 精确原创比 / 主题 / 交互；新建轻量读限速器（~400ms 间隔 + 429 冷却，独立于写操作的 1.2s 预算）；hover-intent 触发 + 缓存优先。

## 四、模块

| 模块 | 职责 | 状态 |
| --- | --- | --- |
| `lib/kol-card.ts` | 浮卡 UI（单例 overlay、定位、主题、行渲染、四档着色、数据源标注、冷启动提示） | M1 ✅ / M2 ✅ / M4 ✅ |
| `entrypoints/content.ts` | mouseover 委托 + 450ms hover-intent + 桥数据装配 + scan 采样钩子 | M1 ✅ / M2 ✅ |
| `lib/settings.ts` | `kolCardEnabled` 开关（默认开，同时门控采样） | M1 ✅ |
| `lib/kol-signals.ts` | 采样缓存（TTL 3 天 / statusId 去重 / 词频）+ 综合可信分 + 存储侧统计/清空（M4，含 onChanged 内存同步） | M2 ✅ / M4 ✅ |
| `entrypoints/options/App.tsx` `KolSignalsManager` | 采样画像统计 + 一键清空（danger 确认弹窗） | M4 ✅ |
| `test/kol-signals.test.ts` | 分词 / 去重 / 集中度 / 可信分 / TTL 回读 / 统计清空测试 | M2 ✅ / M4 ✅ |
| `lib/x-graphql.ts` + `lib/read-limiter.ts` | UserTweets 读封装（解析容错 / 精确中位数 / 3 天缓存 / queryId 失效会话禁用）+ 读限速（串行 400ms + 429 冷却 10 分钟） | M3 ✅ |
| `test/x-graphql.test.ts` | 限速串行 / 冷却 / 解析双入口形状 / 中位数与原创比测试 | M3 ✅ |

## M4 落地说明

- **数据源标注**：页脚 `档案实时 + 采样N条 · 不联网` 区分 L1 档案数据与 L2 累积采样；原创比行自带样本量。
- **冷启动提示**：样本不足时显示「采样不足 N/5 条 · 浏览中累积」，不再静默缺行。
- **采样管理入口**：设置 → 检测规则 → KOL 悬浮卡下方，展示账号数 / 样本量 / 最近采样，清空走 danger 确认；内容脚本内存经 storage.onChanged 同步清空（否则防抖 flush 会写回）。
- **i18n**：卡片语言跟随 X 的 UI 语言（`<html lang>`），支持 zh / en / ja（默认中文）；计数格式化随语言切换（万/亿 vs K/M）。
- **可信分分项透明度**：综合可信行下展示四个子维度分（年龄 / 关注网 / 互动 / 原创），缺数据维度 = 50 一眼可见。

## 五、风险与约束

1. X DOM/aria-label 数字格式随 locale 变化（"1.2万" / "12K"）——计数提取器需多语言解析（已有 `REPLYING_TO_RE` 多语言先例）。
2. GraphQL 读接口同样有配额——M3 必须默认关闭、缓存优先、hover-intent 触发。
3. 隐私红线：所有计算本地完成，不上传任何浏览数据（延续上游原则）；浮卡明确标注「本地数据 · 不联网查询」。
4. 性能：mouseover 委托保持轻量（closest 判断），采样只做 Map 计数，不触发布局。
