# qq-reply —— 指令中心（被@回复 + 指令）

官方 QQ 机器人通道下的**被动回复容器**：监听群聊 / 私聊消息，识别**被 @** 与**指令前缀**后自动回复。与 `ths-news`（主动定时推送）互补，构成「主动推 + 被动答」的完整机器人。

> 历史上接的是 NapCat（个人号），2026-08-26 起改接 `official-bot-gateway`（官方开放平台）。环境变量名沿用 `NAPCAT_*` 未改，指向的已是网关了。

## 触发规则与权限

| 场景 | 行为 |
|------|------|
| 群聊 · 任意人 @ + **闲聊** | **忽略**（只有特定指令才触发，防止被随便 @ 刷屏） |
| 群聊 · @ + 指令 | 响应；普通成员仅可使用 `groupRestrictedCmds` 内指令，其余回 `restrictedMsg` |
| 群聊 · 不在 `groupWhitelist` 的群 | 完全忽略 |
| 群聊 · 管理员（`admins`）直接发磁链（无需 @） | 自动预览（普通成员无 @ 发磁链仍忽略） |
| 私聊 · 白名单（`privateWhitelist`） | 仅响应指令 / 磁链，闲聊忽略 |
| 私聊 · 非白名单 | 回 `deniedMsg` 拒绝提示（置空则完全忽略） |

> 全部规则通过 `config.json` 调整，**每次收到消息热加载，改完立即生效、无需重启**。

## 架构

```
QQ 用户 ──@ / 指令──▶ 官方 QQ 开放平台 ──▶ official-bot-gateway
                                              │ WS :3101 事件推送
                                              ▼
                                    qq-reply 容器（node:22-alpine，零依赖）
                                              │ 识别 @ / 指令 → 渲染图表
                                              ▼ HTTP :3100（send_group_msg / send_private_msg）
                                        官方网关 ──▶ QQ 回复
```

- **零依赖**：Node ≥ 21 内置全局 `WebSocket`（事件通道）与 `fetch`（HTTP 回复），无需 `npm install`。
- **唯一外部库**：`@resvg/resvg-js`，从 `ths-news-modules` 卷**只读共享**（渲染 `/ss` `/stock` `/zj` 图表用）。
- **断线自愈**：WS 断开后每 5 秒自动重连。
- **发送重试**：`send_*` 端点 5 次 × 5s，抵御网关间歇超时。
- **配置热加载**：`config.json` 每次收到消息时重新读盘。

## 快速开始

前置：`official-bot-gateway` 已启动、机器人已登录（`docker logs official-bot-gateway` 看到「✅ 官方机器人已连接 Gateway」）。

```bash
# 1. 生成配置文件（可选，默认值即可直接用）
cp reply/config.json.example reply/config.json

# 2. 启动
docker compose up -d qq-reply

# 3. 看日志确认 WS 已连接
docker compose logs -f qq-reply
```

看到 `✅ WebSocket 已连接 ws://official-bot-gateway:3101` 即就绪；然后在群里 @机器人 或在私聊里发 `/help` 验证。

## 指令表

### 📈 行情与图表

| 指令 | 别名 | 说明 |
|------|------|------|
| `/ss` | `/指数` | 指数行情图：上证 / 沪深300 / 全市场成交额 / 申万二级资金流 |
| `/stock <周期> <代码或名称>` | `/股票` `/K线` | K线图 / 分时图 / 文本速查。周期 `-d -w -M -1m -5m -30m -1h -t`；支持 A股/港股/美股/ETF/国际商品/全球指数 |
| `/zj <1\|2> [t\|d]` | `/资金` | 申万行业资金流：留空=当前排行 TOP10；`t`=分时波动曲线；`d`=日级流入曲线 |

### 📊 个股与基金

| 指令 | 别名 | 说明 |
|------|------|------|
| `/info <代码或名称> [条数]` | `/个股` `/资料` | 个股速查（**仅 A股**）：行情 / 公司概况 / 公告 / 新闻。默认 3 公告 + 5 新闻 |
| `/etfinfo <代码或名称>` | `/etf` `/基金持仓` | ETF 速查：前十持仓 + 跟踪指数；非 ETF（股票/指数/港股/美股/商品）明确说明原因，宽基指数会给出对应 ETF 代码 |

### 📰 资讯

| 指令 | 别名 | 说明 |
|------|------|------|
| `/快讯` | `/news` `/资讯` | 同花顺官方「重要」快讯，最近 10 条（条数由 `NEWS_QUERY_LIMIT` 控制） |

### 🛠️ 工具

| 指令 | 别名 | 说明 |
|------|------|------|
| `/help` | `/菜单` | 显示指令菜单 |
| `/ping` | `/存活` | 存活检测，返回运行时长与当前时间 |
| `/status` | `/状态` | 服务状态：机器人信息 / 事件通道 / 运行时长 + **监控指标**（模拟硬件温度/频率/显存/内存，仅展示用，不读真实硬件） |
| `/echo <内容>` | `/复读` | 复读一段文本 |
| `/preview <磁链或40位hash>` | `/预览` `/磁力预览` `/seed` | **磁力预览**：调 WhatsLink 公开 API，返回名称/大小/文件数 + 截图（机器人主动限制最多 10 张，逐张转发） |
| 直接发一条 `magnet:?xt=...` 链接 | 自动 | 自动触发 `/preview`（同一权限规则） |

> `/stock` 各周期的品种降级规则、`/zj` 的级别说明、全部上游数据源，见[仓库根 README](../README.md#指令中心qq-reply)。
>
> 扩展新指令：编辑 `reply/index.js` 的 `routeCommand()`，追加一个 `case` 即可，`docker compose restart qq-reply` 生效。
> `/preview`（含磁链自动预览）需管理员权限：群聊普通成员即使 `@` 也会被 `groupRestrictedCmds` 拦下。

## 配置

### 环境变量（docker-compose 已设，一般无需改）

| 变量 | 当前值 | 说明 |
|------|------|------|
| `NAPCAT_WS_URL` | `ws://official-bot-gateway:3101` | 事件通道（OneBot 风格 WS） |
| `NAPCAT_URL` | `http://official-bot-gateway:3100` | 发送地址（OneBot 兼容 HTTP） |
| `NAPCAT_TOKEN` | 空 | access token（若启用） |
| `BOT_UIN` | `${QQBOT_APP_ID}` | 机器人标识，用于识别「@」 |
| `NEWS_QUERY_LIMIT` | `10` | `/快讯` 返回条数 |
| `DAILY_PUSH_ENABLED` | `false` | 每日 21:30 汇总推送总开关（用户已取消，默认关） |
| `DAILY_PUSH_HOUR` / `DAILY_PUSH_MIN` | `21` / `30` | 汇总推送时间 |

### config.json（挂载 `/app/config.json`）

| 字段 | 默认 | 说明 |
|------|------|------|
| `groupAtOnly` | `true` | 群聊仅响应被 @ 的消息 |
| `privateAlways` | `true` | 私聊总是响应（总开关，需配合 `privateWhitelist` 使用） |
| `admins` | `[]` | 管理员 QQ 列表（群聊中可用全部指令） |
| `privateWhitelist` | `[]` | 私聊白名单（名单外账号私聊一律拒绝；空数组 = 不限制） |
| `groupWhitelist` | `[]` | 群白名单（非空 = 仅响应列表内群；空数组 = 不限制） |
| `groupAdminOnly` | `false` | 群聊仅管理员可触发（非管理员消息一律不响应） |
| `groupRestrictedCmds` | `[]` | 群聊非管理员可用指令名白名单（如 `["ping","status"]`；空数组 = 不限制） |
| `groupImages` | `false` | 群聊预览是否带图。**腾讯对群聊批量图片有安全审核**（批量图连发会被静默拦截、sendMsg 超时），默认 `false` = 群聊只发文本预览，图片自动**私聊补发**给触发者；`true` = 群聊直接带图 |
| `restrictedMsg` | 见文件 | 群聊非管理员使用受限指令时的提示 |
| `deniedMsg` | 见文件 | 私聊非白名单账号的拒绝提示；置 `""` 则完全忽略不回复 |
| `unknownMsg` | 见文件 | 未识别指令的提示 |
| `welcome` | 见文件 | 非指令消息的引导语；置 `""` 则不回复 |

> 指令名取 `routeCommand()` 返回的 `name`（不含 `/`）：`help` / `ping` / `status` / `echo` / `preview` / `news` / `ss` / `stock` / `zj` / `info` / `etfinfo`。别名（如 `/存活`、`/K线`）映射到同名 `name`，权限判断按 `name` 生效。

## 排障

- **改了指令没生效**：`index.js` 是 bind mount，但 Node 启动时载入内存，必须 `docker compose restart qq-reply`；改 `config.json` 则无需重启。
- **日志显示 WebSocket 一直重连**：`official-bot-gateway` 未启动或已重启。确认网关在跑（`docker compose ps`），日志里看到 `✅ WebSocket 已连接 ws://official-bot-gateway:3101` 即就绪。
- **@ 不识别**：确认 `BOT_UIN` 与网关转发的 `at` 标识一致（当前取 `${QQBOT_APP_ID}`）。可用 `/status` 查看机器人信息与通道状态。
- **私聊不响应**：检查 `privateAlways` 是否为 `false`，或你的 QQ 不在 `privateWhitelist` 内（收到 `deniedMsg` 说明被白名单拦截）。
- **群聊指令被拒**：普通成员仅可用 `groupRestrictedCmds` 内指令，属预期；如需放行，将该指令名加入 `groupRestrictedCmds`，或把账号加入 `admins`。
- **群聊收不到图**：`groupImages: false` 时群聊只发文本、图片自动私聊补发给触发者，属预期。
- **图表「没字」**：容器内缺 `/app/fonts/cjk_sub.ttf`。在宿主执行 `bash ths-news/setup_fonts.sh` 补齐，bind mount 实时生效、无需重启。

## 上游数据源

| 用途 | 来源 |
|---|---|
| 实时快照（指数/ETF/港股/美股） | 腾讯 `qt.gtimg.cn`（GBK） |
| 日 / 周 / 月 K（320 根，前复权） | 腾讯 `web.ifzq.gtimg.cn` fqkline |
| 分钟 K（1/5/30/60m） | 腾讯 `proxy.finance.qq.com` mkline |
| 当日分时 | 腾讯 minute/query、东财 `push2his` trends2 |
| 名称 → 代码搜索 | 腾讯 `smartbox.gtimg.cn`（GBK） |
| 国际商品分时 | 新浪 `GlobalFuturesService` |
| 申万行业资金流 | 腾讯 `getRank`（`hy` / `hy2`） |
| 板块资金流曲线 | 东财 `clist` + `fflow` |
| 个股公告 / 新闻 | 东财 `np-anotice-stock` / `search-api-web` |
| 基金资料 / 前十持仓 | 东财 `fundmobapi` + `fundf10` jjcc |
| 重要快讯 | 同花顺 7×24 官方接口 |
| 磁力预览 | WhatsLink 公开 API |
