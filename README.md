# QQ 机器人（官方开放平台通道）

基于**官方 QQ 机器人**（[q.qq.com](https://q.qq.com) 开放平台的 AppID + AppSecret）+ 一个 **OneBot 兼容网关**，把三条自动化链路和一套指令中心拧在一起：

| 链路 | 服务 | 运行形态 | 职责 |
|---|---|---|---|
| **通道网关** | `official-bot-gateway` | 容器 | 官方开放平台 ↔ OneBot 协议互转（HTTP `3100` / WS `3101`） |
| **指令中心** | `qq-reply` | 容器 | 群聊被 @ / 私聊发指令 → 行情图、K线、资金流、个股资料、ETF 持仓、快讯、磁力预览 |
| **快讯转发** | `ths-news` | 容器 | 每 5 分钟拉取同花顺官方「重要」快讯，渲染中文图片卡片推送 |
| **A股复盘推送** | `a-share-report` | 宿主机脚本 | 把 A股 复盘 HTML 渲染成长图推送到 QQ |

> **历史沿革**：项目早期基于 **Koishi + NapCat**（个人号方案）。Koishi 栈已完全移除；2026-09-02 起默认部署切换为官方机器人通道。NapCat 仍作为非官方备用通道保留，相关服务在 `docker-compose.yml` 中默认不启动，可按需恢复（见 [NapCat 备用通道](#napcat-备用通道默认未启动)）。

---

## 为什么换成官方机器人

| | NapCat（非官方备用通道，默认未启动） | 官方机器人（默认适配器） |
|---|---|---|
| 掉线 | 频繁，需扫码 / 密码回退 | **不掉线** |
| 账号风险 | 高，有封号风险 | 官方合规通道 |
| 身份标识 | 真实 QQ 号 | **openid**（平台不认 QQ 号） |
| 主动推送 | 无限制 | **有配额**：单用户/单群 1000 条/天、20 条/分钟 |
| 被动回复 | 无时效 | 群 @ 后 **5 分钟**、私聊 **60 分钟**内回复有效 |

**关于目标寻址**：官方平台只认 openid、不认 QQ 号。本项目网关做了一层映射：**已与机器人互动过的目标，仍可直接填 QQ 号 / 群号**（网关查表换算），和以前一样用。

```
openidByQq(QQ号)  || QQ号     // 私聊：已学习到的 QQ 号可直接用
groupOpenidByQq(群号) || 群号   // 群聊：已学习到的群号可直接用
```

代价只有一个：**没互动过的目标必须先"见过"一次**——owner 私聊发 `bind-owner` 绑定，群则需要把机器人拉进去并 @ 一次。学习结果用 `curl -s http://127.0.0.1:3100/bindings` 查看。从未互动过的目标则只能填 openid。

---

## 架构

```
QQ 用户（群 @机器人 / 私聊发指令）
        │
        ▼
官方 QQ 开放平台  q.qq.com        ← AppID + AppSecret
        │
        ▼
official-bot-gateway  （OneBot 兼容层，本仓库自研）
        ├── HTTP :3100   ← 发送出口（ths-news / a-share-report / qq-reply）
        └── WS   :3101   → 事件入口（qq-reply 订阅）
                │
                ├──▶ qq-reply    指令中心：行情 / 资料 / 资讯 / 工具
                └──▶ ths-news    图片卡片快讯推送
```

发送走官方媒体上传（图片 ≤ 30MB，自动分块）；`message` 格式为 OneBot 数组，图片用 `base64://`：

```json
[{ "type": "text", "data": { "text": "..." } },
 { "type": "image", "data": { "file": "base64://..." } }]
```

---

## 目录结构

```
qq-koishi-bot/
├── docker-compose.yml                # 容器编排（official-bot-gateway + qq-reply + ths-news）
├── .env.example                      # 凭证模板（复制为 .env）
├── .gitignore
├── official-bot-gateway/             # ★ 官方机器人网关（OneBot 兼容层）
│   ├── index.js                        # HTTP 3100 + WS 3101；openid 绑定学习
│   ├── bindings.json                   # openid 绑定表（owner / users / groups）
│   ├── create_panels.mjs               # 生成面板辅助脚本
│   └── README.md
├── reply/                            # ★ 指令中心（容器，模块化 Node 服务）
│   ├── index.js                        # 主服务：WS 事件监听与指令路由
│   ├── commands/                       # 各指令实现（/an、/t、/ss 等）
│   ├── market.js / gateway.js          # 行情数据层与网关发送层
│   ├── chart-fonts.js                  # 图表字体初始化
│   ├── package.json                    # Canvas / Resvg 渲染依赖
│   ├── config.json                     # 权限配置（官方通道用）
│   ├── config.napcat.json              # 权限配置（NapCat 备用通道）
│   ├── data/                           # /stocks 组合数据（可写挂载；portfolios.json 已 gitignore）
│   └── README.md
├── ths-news/                         # ★ 同花顺重要资讯转发
│   ├── fetch_ths_news.js               # 主脚本（过滤/去重/渲染/推送）
│   ├── start_news_cron.sh              # 容器内循环拉取 + 首启装 resvg
│   ├── ths_news_targets.json           # 推送目标（含真实 QQ 号 / openid，已 gitignore）
│   ├── setup_fonts.sh                  # 从本机复制中文字体（避免提交 22MB）
│   ├── fonts/                          # cjk.ttc（卡片）/ cjk_sub.ttf（图表子集）
│   └── README.md / PROMPTS.md / SKILL.md
├── a-share-report/                   # ★ A股 复盘推送（宿主机脚本，非容器）
│   ├── push_report.js                  # 主脚本：健康检查 → 渲染 → 推送
│   ├── render_report.js                # 仅渲染不推送（手动预览）
│   └── push_targets.json               # 推送目标（已 gitignore）
└── napcat/                           # NapCat 备用通道运行数据（登录态，已 gitignore）
```

---

## 快速开始（首次部署）

前置：**Docker** + **Docker Compose**；已有一个通过审核、拿到 **AppID / AppSecret** 的官方 QQ 机器人。

### 1. 填凭证

```bash
cp .env.example .env
```

编辑 `.env`：

```ini
# 官方机器人（必填）—— q.qq.com → 你的机器人 → 开发配置
QQBOT_APP_ID=你的AppID
QQBOT_APP_SECRET=你的AppSecret

# 以下仅 NapCat 备用通道需要，官方通道可留空
# QQ_ACCOUNT=你的小号QQ
# QQ_QUICK_PASSWORD=
```

> ⚠️ `.env` 含密钥且已 gitignore，**不要提交、不要外传**。

### 2. 配推送目标

```bash
cp ths-news/ths_news_targets.json.example    ths-news/ths_news_targets.json
cp a-share-report/push_targets.json.example a-share-report/push_targets.json
```

目标可以**直接填 QQ 号 / 群号**（例如 `1547450303` / `609994072`），前提是网关已经"学习"过该目标——见第 5 步。**首次部署建议先留空**，等学完再回填。

```json
{
  "private": ["你的QQ号"],
  "groups":  ["群号"],
  "imageWidth": 600,
  "imageScale": 2
}
```

> 从未与机器人互动过的目标没有映射，只能填 openid（从 `/bindings` 拿）。

### 3. 准备中文字体（关键！否则推出去的图片「没字」）

```bash
bash ths-news/setup_fonts.sh
```

脚本会从本机系统字体复制一款 CJK 到 `ths-news/fonts/`。**两种字体各司其职**：

| 文件 | 使用者 | 说明 |
|---|---|---|
| `cjk.ttc` | ths-news 快讯卡片 | 完整 CJK 字体（约 22MB） |
| `cjk_sub.ttf` | qq-reply 的 `/ss` `/stock` `/stocks` `/zj` 图表 | 裁剪子集（约 3.7MB，resvg 加载更快） |

### 4. 启动

```bash
docker compose up -d
docker compose ps                       # 三个服务都应为 Up
docker logs -f official-bot-gateway     # 看到「✅ 官方机器人已连接 Gateway」即成功
```

### 5. 绑定管理员 + 让机器人进群

官方平台只认 openid、不认 QQ 号，所以目标必须先让网关"见"到一次，才能把 QQ 号 / 群号映射过去：

```bash
# ① 绑 owner：用你的 QQ 私聊机器人发一条
bind-owner
#   机器人回「✅ 已绑定为管理员」即成功

# ② 让机器人进群：把它拉进目标群，群里随便 @ 一次（openid 被自动学习）

# ③ 查看学到的绑定
curl -s http://127.0.0.1:3100/bindings
```

学完之后，第 2 步的两个 JSON 文件里**直接填 QQ 号 / 群号**即可（**推送目标配置热加载，改完无需重启**）。

### 6. 验证

```bash
# 私聊机器人发指令
/ping
/ss
/stock -d 600519

# 快讯筛选结果（不推送）
docker exec ths-news node /app/fetch_ths_news.js --dry-run
```

---

## 指令中心（qq-reply）

`reply/index.js` 负责事件监听和路由，具体命令拆分在 `reply/commands/`，行情与网关逻辑分别位于 `reply/market.js`、`reply/gateway.js`。图表依赖由 `reply/package.json` 管理：`@napi-rs/canvas` 为主渲染器，`@resvg/resvg-js` 为兜底；本地可在 `reply/` 下执行 `npm install` 后预览。

### 权限模型

| 场景 | 行为 |
|------|------|
| 群聊 · 普通成员 @ + **闲聊** | **忽略**（只有特定指令才触发，防止被随便 @ 刷屏） |
| 群聊 · @ + 指令 | 响应；普通成员仅可使用 `groupRestrictedCmds` 内指令，其余回 `restrictedMsg` |
| 群聊 · 管理员（`admins`）直接发磁链（无需 @） | 自动预览 |
| 群聊 · 不在 `groupWhitelist` 的群 | 完全忽略 |
| 私聊 · 在 `privateWhitelist` | 仅响应指令 / 磁链，闲聊忽略 |
| 私聊 · 不在 `privateWhitelist` | 回 `deniedMsg` 拒绝提示 |
| **写操作**（`/stocks -add` / `-update` / `-del`）· 任何场景 | **只认 `owners`（主人 QQ 号）**，与 `admins` 无关；其他人一律回「🛡️ 组合的增删改仅限机器人主人」。`owners` 为空 = 谁都不能写（fail-closed） |

> **两层权限不要混淆**：`groupRestrictedCmds` / `admins` 只管「这条指令名能不能调」；`owners` 只管「组合能不能被写」。两者独立叠加——非管理员可以查询 `/stocks` 与 `-list`；而管理员即使能调 `stocks`，不在 `owners` 里照样写不了。

> **当前生效配置**（`reply/config.json`）：管理员与私聊白名单均为 `1547450303`，`owners` 为 `["1547450303"]`；群聊开放指令集为 `ping / status / ss / stock / stocks / zj / info / echo / news / help`（**`/preview` 磁力预览仅管理员**；**`/stocks -add` `-update` `-del` 仅主人**，查询与 `-list` 所有人可用）；`groupImages: false`。

### 指令表

**📈 行情与图表**

| 指令 | 别名 | 说明 |
|---|---|---|
| `/ss` | `/指数` | 指数行情图：上证 / 沪深300 / 全市场成交额（盘中含预计全天成交量）/ 申万二级资金流 |
| `/stock <周期> <代码或名称>` | `/股票` `/K线` | K线图 / 分时图 / 美股盘前图 / 文本速查；名称搜索返回多个候选时仍按腾讯首个匹配出图，并在同一条图片回复中附市场、代码、名称列表（详见下节） |
| `/fc [周期] <国内品种/合约 或 国际行情>` | `/期货` | 国内期货、伦敦金现货及国际期货 K线/分时图：`黄金`=沪金，`伦敦金`=`XAU/USD` 原始美元/盎司点位，`COMEX黄金`=纽约黄金期货（详见下节） |
| `/fx [周期] <货币对或名称>` | `/外汇` `/汇率` | **外汇行情**：`-t` 最近滚动24小时（默认），支持 `-1m/-5m/-30m/-1h/-2h` 分钟K及 `-d/-w/-m` 长周期；`/fx -list` 查看货币代码和品种解释；大陆直连新浪外汇源（详见下节） |
| `/an <代码或名称>` | `/分析` `/技术分析` | 多周期技术分析：完整文字分析图 → 日/周/月技术图；全文保留结构、确认/失效、风险及相对沪深300/行业强弱（详见 `reply/AN_GUIDE.md`） |
| `/t <代码或名称> [-sw 震荡] [-tr 单边]` | `/做T` | 做T参谋：完整文字分析图 → 分时技术图；全文保留当前动作、卖出/买回区、分时确认与执行纪律（详见 `reply/T_GUIDE.md`） |
| `/stocks <周期> <组合名 或 股票...>` | `/组合` `/自选` | **股票组合拼图**：一张卡片式长图并列多看；单个组合最多保存 20 只，单张图最多展示前 16 只；支持 `-t/-pre/-d/-w/-m`。查询 / `-list` 所有人可用，`-add` / `-update` / `-del` 仅主人（详见下节） |
| `/zj <1\|2> [3\|5\|10\|15\|20\|30\|60\|120]` | `/资金` | 申万行业资金流：不写周期显示当前排行；数字周期显示近 N 日汇总；`d` 兼容为近 5 日，`t` 分时已停用（详见下节） |
| `/zjl <股票或ETF>` | `/flow` `/资金流` `/资金流向` | 个股已完成交易日资金流：主力 / 超大单 / 大单 / 中单 / 小单及多周期汇总 |

**📊 个股与基金**

| 指令 | 别名 | 说明 |
|---|---|---|
| `/info <代码或名称> [条数]` | `/个股` `/资料` | 个股速查（**仅 A股**）：行情 / 公司概况 / 公告 / 新闻。条数默认 3 公告 + 5 新闻 |
| `/etfinfo <代码或名称>` | `/etf` `/基金持仓` | ETF 速查：前十持仓 + 跟踪指数；非 ETF 会明确说明原因 |

**📰 资讯**

| 指令 | 别名 | 说明 |
|---|---|---|
| `/快讯` | `/news` `/资讯` | 同花顺官方「重要」快讯：跨页补足最近 10 条，按主题/事件等级渲染为一张长图 |

**🛠️ 工具**

| 指令 | 别名 | 说明 |
|---|---|---|
| `/help` | `/菜单` | 指令菜单 |
| `/ping` | `/存活` | 存活检测（运行时长 + 当前时间） |
| `/status` | `/状态` | 服务状态 + 监控指标（模拟硬件温度/频率，纯展示） |
| `/echo <内容>` | `/复读` | 复读 |
| `/preview <磁链或40位hash>` | `/预览` `/磁力预览` `/seed` | 磁力预览：名称/大小/文件数 + 截图（**仅管理员**） |
| 消息含 `magnet:?xt=...` | 自动 | 自动触发 `/preview`（同一权限规则） |

### `/stock` 详解

```
/stock <周期> <代码或名称>
```

**周期参数**（不写默认日线）：

| 参数 | 周期 | 备注 |
|---|---|---|
| `-d` | 日线 | 默认；含均线 + BOLL |
| `-w` / `-week` / `周线` / `周k` | 周线 | |
| `-M` / `-m` / `-month` / `月线` / `月k` | 月线 | ⚠️ `-m` 是**月线**不是分钟 |
| `-1m` | 1 分钟 | |
| `-5m` | 5 分钟 | |
| `-30m` | 30 分钟 | |
| `-1h` | 60 分钟 | |
| `-t` / `-time` / `分时` | 当日分时 | |
| `-pre` / `pre` / `盘前` | 美股盘前 | 美东 04:00–09:30；支持普通美股与美股 ETF |

> 名称搜索由腾讯 `smartbox` 返回候选。存在多个候选时，图表仍使用当前解析到的首个匹配，同时在同一条图片消息中附最多 5 个候选的市场、代码和名称；直接输入代码或只有一个候选时不附列表。

**品种覆盖与降级规则**：

| 品种 | 输入示例 | 支持周期 | 说明 |
|---|---|---|---|
| A股 | `600519` `贵州茅台` | 全部 | 6 位代码直用；中文名走搜索解析 |
| ETF | `510300` `沪深300ETF` | 全部 | |
| 港股 | `00700` `hk00700` | `-d` `-w` `-M` `-t` | 数据源无分钟 K，会明确提示 |
| 美股 | `AAPL` `usAAPL` | `-d` `-w` `-M` `-t` `-pre` | 分钟 K 不支持；`-pre` 使用美股盘前成交，支持普通美股与 ETF；**盘后 `-t` 显示上个交易日** |
| 国际商品 | `伦敦金` `COMEX黄金` `布伦特原油` | `-d` `-w` `-M` `-t` | 新浪全球行情源；`伦敦金` 是 XAU/USD 现货美元/盎司原价，不换汇；数据源无分钟 K，周/月由日 K 本地聚合 |
| 全球指数 | `道琼斯` `恒指` | 见说明 | 恒指：全部周期出图（腾讯）；道指/标普500：`-d -w -M` 出图（东财）、`-t` 文本速查；纳指综合：仅文本速查（无免费 K 线源） |

**示例**：

```bash
/stock -d 600519          # 贵州茅台日线
/stock -5m 贵州茅台        # 5 分钟 K
/stock -t 00700           # 腾讯控股当日分时
/stock -pre NVDA          # 英伟达美股盘前（美东 04:00–09:30）
/stock AAPL               # 苹果日线（默认周期）
/stock -d 伦敦金          # 伦敦金现货，美元/盎司原始点位
/stock -d COMEX黄金       # COMEX 纽约黄金期货日线
/stock -w 布伦特原油        # 布油周线
/stock -t 布伦特原油        # 商品分时
/stock 道琼斯              # 指数文本速查（-d/-w/-M 走东财 K 线出图；纳指综合仅文本）
```

> **国际商品的数据细节**（踩过的坑）：
> - **交易时段不是 24 小时，是每天约 23 小时**：伦敦金现货、COMEX黄金/白银、WTI、天然气、美铜北京时间通常从 **06:00** 开始新的交易日，约在次日 **05:00** 前后结束；布伦特原油（ICE）通常为 **08:00 → 次日 07:00**。具体以分时标题实际起止时刻为准。伦敦金使用独立 `hf_XAU` 行情，不套沪金交易时段。
> - **分时图右端是「最后一个数据点」，不是「现在」**：A股/港股/美股的横轴按**分钟**映射（`tmin(t)/TOT`），午休会体现为一段压缩区间；商品沿用**索引等距映射**（`mapX = X`），所以即使休市、曲线也会铺满整幅图。判断是否实时要看**标题里的时段标注**（形如 `分时 09-10 06:00 至 09-11 01:33`）与横轴右端时刻。
> - 新浪全球期货日 K 从 2016-09 起约 2500+ 根，单次响应近 400KB → 进程内缓存 10 分钟，上游偶发失败时退回旧数据而不是报错。
> - **日 K 的最后一根是「已收盘」那根**，快照现价属于下一交易时段（外盘近 24h 连续交易），所以图上「今日价格」的涨跌取**快照自带值**，不按 K 线相邻两根反算——否则会出现图上 `-0.97%` 与标题 `-0.03%` 自相矛盾。
> - 快照第 3 个字段**不是**昨收（与自带涨跌额对不上，如 `hf_GC` 现价 4402.84 / 涨跌 -1.30 / 该字段 4406.00），不要拿它当基准。
> - **成交量**：布油 / 伦铜有量，黄金 / 白银 / 原油 / 天然气 / 美铜恒为 0 → 图上画「该品种数据源不提供成交量」占位，不留空面板。
> - 分时标题的时段分隔用「至」而不是箭头 `→`——图表用的中文字体子集（`cjk_sub.ttf`）**没有 `→`/`←`/`»`/`…` 的字形**，画出来是空白。

### `/fx` 详解

```text
/fx -list              # 查看货币代码、报价方向和全部支持品种
/fx [周期] <货币对或名称>
```

货币对按市场标准方向报价，并非按汇率数值大小排列。斜杠前是**基础货币**，后面是**计价货币**：`EUR/JPY 177.00` 表示 `1 欧元 = 177.00 日元`。反向 `JPY/EUR` 可用 `1 ÷ 177.00` 计算，但不是常用交易报价方向。

外汇为 **24 小时 × 每周 5 天（24×5）** 连续交易，周末休市。`-t` 展示新浪返回的最近 1440 根 1 分钟数据，即滚动约 24 小时；休市时显示最后一个交易时段，不把旧数据伪装成实时行情。

货币对支持斜杠、连续代码、空格和中文四种输入，命令名、周期及英文代码均不区分大小写，中文名称支持半角或全角空格。例如 `/fx EUR/JPY`、`/FX eurjpy`、`/fx eUr JpY`、`/fx 欧元 日元` 均等价。

| 参数 | 周期 | 说明 |
|---|---|---|
| `-t` / `t` / `分时` / `24h` | 最近24小时价格线 | 默认；滚动窗口，不是自然日 00:00–24:00 |
| `-1m` / `1m` | 1分钟K | 数据源最多 1440 根；图中最近 120 根（约2小时） |
| `-5m` / `5m` | 5分钟K | 原生周期；图中最近 120 根（约10小时） |
| `-30m` / `30m` | 30分钟K | 原生周期；图中最近 120 根（约2.5个交易日） |
| `-1h` / `1h` / `60m` | 1小时K | 原生60分钟；图中最近 120 根（约5个交易日） |
| `-2h` / `2h` / `120m` | 2小时K | 由1小时K按自然双小时聚合；图中最近 120 根（约10个交易日） |
| `-d` / `d` / `日线` | 日线 | MA5/10/20 + BOLL |
| `-w` / `w` / `周线` | 周线 | 日 K 本地聚合 |
| `-m` / `m` / `月线` | 月线 | 日 K 本地聚合 |

```bash
/fx USD/CNH          # 美元兑离岸人民币最近24小时
/fx -1m EUR/USD      # 欧元兑美元1分钟K
/fx -5m EUR/JPY      # 欧元兑日元5分钟K
/fx -30m USD/SGD     # 美元兑新加坡元30分钟K
/fx -1h USD/MXN      # 美元兑墨西哥比索1小时K
/fx -2h 欧元英镑      # 欧元兑英镑2小时K
/fx -d EUR/USD       # 欧元兑美元日线
/fx -w 英镑美元       # 英镑兑美元周线
/fx -m 美元日元       # 美元兑日元月线
```

完整支持的 22 个货币对（均已验证分钟K、日线和实时快照）：

- **主要直盘**：`USD/CNH`、`EUR/USD`、`GBP/USD`、`USD/JPY`、`AUD/USD`、`USD/CHF`、`USD/CAD`、`NZD/USD`、`EUR/CNY`
- **欧元交叉盘**：`EUR/JPY`、`EUR/GBP`、`EUR/CHF`、`EUR/AUD`、`EUR/CAD`、`EUR/NZD`
- **亚洲与新兴市场**：`USD/HKD`、`USD/SGD`、`USD/SEK`、`USD/NOK`、`USD/TRY`、`USD/MXN`、`USD/ZAR`

同时支持相应中文名称。外汇现货没有统一交易所集中成交量，图中不会绘制伪成交量；数据源为新浪 `NewForexService`，大陆服务器可直连，不依赖 Yahoo 或代理。`GBP/JPY`、`AUD/JPY`、`USD/CNY` 等虽然存在快照或日线，但新浪分钟K为空，暂不混入完整支持列表。

### `/fc` 详解

```
/fc [周期] <品种 或 合约>
```

国内期货（上期所 / 大商所 / 郑商所 / 上期能源 / 广期所 / 中金所）以及常见国际期货 K线 / 分时图。国内期货按合约交易，支持“品种 + 月份”和主力连续；国际期货复用新浪全球期货行情，使用明确的市场名称避免与国内同名品种混淆：

| 写法 | 解析结果 |
|---|---|
| `生猪2701` / `lh2701` / `LH2701` | 生猪 2027-01 合约（`LH2701`） |
| `生猪` / `生猪主力` / `LH` / `LH0` | 主力连续（`LH0`） |
| `TA701` | 郑商所原生 3 位月份 → 自动补全为 `TA2701` |
| `PVC` / `PTA` / `LPG` | 常用英文简称也可用（→ `V` / `TA` / `PG`） |
| `/fc 黄金` | 国内沪金主力连续 `AU0`（国内品种优先，兼容旧行为） |
| `/fc COMEX黄金` / `/fc 纽约黄金` | COMEX 黄金期货 |
| `/fc WTI` / `/fc 布伦特原油` | WTI / 布伦特原油期货 |
| `/fc 美豆` / `/fc 美豆粕` / `/fc 美玉米` | 美国农产品期货 |
| `/fc 伦铜` / `/fc 美铜` | LME 铜 / COMEX 铜期货 |
| `/fc 伦敦金` / `/fc XAU/USD` | 伦敦金现货；直接显示美元/盎司原始点位，不换汇、不折算沪金 |
| `/fc 伦敦银` | 暂未接入 XAG/USD；会提示改用 COMEX 白银期货或国内沪银 |

**周期参数**（不写默认日线）：国内期货支持下表全部周期；国际期货仅支持分时、日、周、月，不支持分钟K。

| 参数 | 周期 | 备注 |
|---|---|---|
| `-d` / `d` / `日线` | 日线 | 默认；含 MA5/10/20 + BOLL |
| `-w` / `w` / `周线` | 周线 | 日 K 本地聚合 |
| `-M` / `M` / `月线` / `mon` | 月线 | 日 K 本地聚合 |
| `m` / `-m` / `1m` | 1 分钟 | 仅国内期货 |
| `5m` / `15m` / `30m` / `60m` | 5 / 15 / 30 / 60 分钟 | 仅国内期货 |
| `-t` / `t` / `分时` | 当日分时 | 含夜盘 |

> ⚠️ 与 `/stock` 不同：`/fc` 里 **`m` = 1 分钟**，**月线用 `-M` / `M` / `月线`**（期货看分钟图更常见）。周期可放合约前或后：`/fc 5m 生猪2701` 与 `/fc 生猪2701 5m` 等价。

```bash
/fc 生猪2701          # 生猪 2027-01 日线
/fc 螺纹钢            # 螺纹钢主力连续（RB0）
/fc 5m 沪金2612       # 沪金 2612 五分钟
/fc -t IF2612         # 沪深300股指期货分时
/fc -t COMEX黄金     # COMEX 黄金期货分时
/fc -d WTI           # WTI 原油期货日线
/fc -w 布伦特原油     # 布伦特原油期货周线
/fc -M 美豆           # 美国大豆期货月线
/fc -t 伦敦金        # 伦敦金现货分时（XAU/USD，美元/盎司原价）
/fc                   # 无参数时输出用法 + 全量品种表
```

> **口径与数据细节**（踩过的坑）：
> - **伦敦金不做换汇或沪金折算**：`/fc 伦敦金` 直接使用新浪 `hf_XAU` 的 XAU/USD 现货报价，图中 `4800 / 4750` 等数值就是美元/盎司原始点位；它与 `/fc 黄金`（沪金 `AU0`）和 `/fc COMEX黄金`（纽约黄金期货 `hf_GC`）是三个独立标的。
> - **涨跌以「昨结算价」为基准**，不是股票式昨收——与交易所涨跌停口径一致，图例/分时参考线写的是**昨结**。生猪日线可能同时出现「昨结 11365 / 昨收 11235」这种差 1% 的情况，属正常（结算价是当日成交量加权均价），不是数据错。
> - **当日那根 K 是本地补的**：新浪日 K 不返回当日未收盘那根，命令用快照（开/高/低/最新/量）拼一根补上，否则日线图会停在昨天。
> - **两套快照字段布局**：商品期货以合约名开头（昨结算在第 11 位），中金所以数值开头、名称在末位（昨结算在第 15 位）——按首字段是否为纯数字自动分派。
> - **分时含夜盘、按索引等距铺满**：期货含 21:00 夜盘，横轴按数据点等距映射（同国际商品），不套 A股 240 分钟口径。
> - **价格精度按数据推断**：生猪/螺纹钢等整数品种 0 位小数，国债 3 位（109.515）、黄金 2 位、股指 1 位。
> - **60 分钟线是交易所时段划分**（新浪原生数据），不是严格 60 分钟——国内期货软件的 60 分钟线同样按时段切。
> - 已到期合约：K 线仍可出图，但取不到快照，文案会标注「该合约可能已到期」。

### `/stocks` 详解

一篮子票拼成一张图，适合手机上一次性扫完自选或持仓。

```
/stocks <周期> <组合名 或 股票...>          # 出图（所有人）
/stocks -list                               # 列出已保存组合（所有人）
/stocks -add <股票...> -name <组合名>       # 新建/覆盖组合（仅主人）
/stocks -update <组合名> <股票...>          # 整组替换成分股（仅主人）
/stocks -del <组合名>                       # 删除组合（仅主人）
```

> **权限**：只有 `-add` / `-update` / `-del` 三个写操作限主人（`owners` 名单），**其余全部所有人可用**（含私聊白名单内任意账号、群内任意成员）。写操作**只认主人 QQ 号**（`admins` 不生效），回执里会列出实际解析到的全部标的，便于发现误匹配。

**周期**（**单选**，不写默认日线）：`-t` 分时 / `-pre` 美股盘前 / `-d` 日线 / `-w` 周线 / `-m` 月线。比 `/stock` 少——分钟/小时图对组合视角没意义，已移除。`-pre` 对组合内美股（含普通股票和 ETF）显示美东盘前；混合组合中的非美股标的仍按普通分时展示。

```bash
/stocks -d 我的持仓                # 展开组合出日线拼图
/stocks -t 600519 000858           # 直接给多只股票，按输入顺序出图
/stocks -pre 美股组合             # 美股普通股票/ETF 盘前组合图
/stocks -add 600519 300750 002594 -name 我的持仓   # 新建（主人）
/stocks -update 我的持仓 600519 000858            # 换成这 2 只（主人）
/stocks -del 我的持仓                             # 删除（主人）
/stocks -list                      # 看有哪些组合
```

**`-update` 边界规则**（`-add` 同理）：

| 输入 | 行为 |
|---|---|
| 组合不存在 | 拒绝，并提示 `-add` + 列出已有组合名 |
| 只给组合名、不给股票 | **拒绝**（不会把组合清空）；想清空请用 `-del` |
| 股票全部解析失败 | **拒绝，原组合原样保留**（不会存成空组） |
| 部分解析失败 | 成功的照常写入，回执里单列「已跳过」 |
| 超过 20 只 | 拒绝，**不静默截断** |
| 重复股票 | 按代码去重，保留首次出现的顺序 |
| `-name` 后缺值 | 拒绝（组合名不允许含空格，`-name` 只吃紧跟的一个 token） |
| 组合名非法 | 拒绝（中英文/数字/下划线打头，后接中英文/数字/下划线/点/短横线，1–12 字符） |
| 一次给多个操作符（如 `-add` + `-del`） | 拒绝并提示只能一种 |
| 带周期参数（如 `-update -d ...`） | 拒绝，编辑指令不出图 |

回执形如：`✏️ 已更新组合【我的持仓】：4 只 → 2 只 / ＋ 新增：五粮液 / － 移除：宁德时代、比亚迪 / 当前：贵州茅台、五粮液`。

**出图规格**（按手机可读性倒推）：

| 项 | 做法 |
|---|---|
| 画布 | 1080px 宽竖版长图，单张 PNG 直出 |
| 列数 | 自适应：1 只→1 列；2–4 只→2 列；5–9 只→3 列；10–16 只→4 列（**每行最多 4 个**） |
| 子图 | 独立圆角白卡内的精简版：无成交量/均线/BOLL；K 线为“上涨红色空心、下跌绿色实心”，分时为价格线 + 均价线 |
| 纵轴 | **各自价格轴**，配灰色虚线基准（K 线=区间起点收盘，分时=昨收） |
| 配色 | 涨红跌绿（`#f5222d` / `#0aa869`） |
| 顶部 | 组合名 + 周期/时间（左）；平均涨跌幅 + `N 只 · M 涨 K 跌`（右） |
| 卡片信息 | 名称 + 当日涨跌幅 + 图内现价；底部代码 + 区间涨跌幅（分时为振幅） |
| 容错 | 单只取数失败 → 该卡灰底占位，其余照常出图；失败或截断提示合并在图内页脚 |

> 组合数据落在 `reply/data/portfolios.json`（宿主可写挂载 `/app/data`，gitignored）。格式见 `reply/data/portfolios.json.example`。
>
> 列数与字号是按**实测字宽**定的：1080px 画布缩到 390pt 手机屏只有 0.36 倍，26px 字到手机上仅剩约 9.4pt——所以 4 列已是可读极限，代码里会自动降级（3 列去掉「现价」、4 列去掉「区间」前缀）以避免文字重叠。

### `/zj` 详解

```
/zj <级别> [3|5|10|15|20|30|60|120]
```

- **级别**：`1` / `一级` / `sw1` → 申万一级（31 个行业）；`2` / `二级` / `sw2` → 申万二级（124 个行业）。
- **第二参数**：留空 = 当前排行 TOP10；数字 = 近 N 日主力净流入汇总；`d` / `日` / `日线` = 近 5 日（兼容旧写法）。
- **分时已停用**：`t` / `分时` / `time` 会提示改用日级汇总，避免分时接口触发风控。
- ⚠️ `3` 申万三级**无公开免费数据源**（腾讯 `hy3` 实测无数据）。

```bash
/zj 1        # 申万一级当前资金流排行
/zj 2 5      # 申万二级近 5 日主力净流入汇总
/zj 2 30     # 申万二级近 30 日主力净流入汇总
/zj 2 d      # 兼容旧写法，等价近 5 日
```

### 数据源一览

| 数据 | 来源 |
|---|---|
| 实时快照（含指数/ETF/港股/美股） | 腾讯 `qt.gtimg.cn`（GBK） |
| 日 / 周 / 月 K（320 根，前复权） | 腾讯 `web.ifzq.gtimg.cn` fqkline |
| 分钟 K（1/5/30/60m） | 腾讯 `proxy.finance.qq.com` mkline |
| 当日分时 | 腾讯 minute/query、东财 `push2his` trends2 |
| 美股盘前（普通美股 / ETF） | Yahoo Finance chart（`includePrePost=true`，美东 04:00–09:30） |
| 外汇最近24小时 / 分钟K / 日线 | 新浪 `NewForexService`（`getMinKline`：1/5/30/60分钟；2小时本地聚合；`getDayKLine`：日线，周/月本地聚合） |
| 名称 → 代码搜索 | 腾讯 `smartbox.gtimg.cn`（GBK） |
| 国际商品分时 / 日线 | 新浪 `GlobalFuturesService`（`getGlobalFuturesMinLine` / `getGlobalFuturesDailyKLine`） |
| 国内期货快照（商品 / 中金所两套字段） | 新浪 `hq.sinajs.cn` `nf_<合约>`（GBK，需 Referer） |
| 国内期货 日 / 分钟 / 分时 K | 新浪 `InnerFuturesNewService`（`getDailyKLine` / `getFewMinLine` / `getMinLine`） |
<!-- // codeflicker-fix: MAINT-Issue-002/o3sn6pyhqtq9bpazla39 -->
| 申万行业资金流 | 腾讯 `getRank`（`hy` / `hy2`，字段 `zljlr`） |
| 板块资金流曲线 | 东财 `clist` + `fflow`（分时/日级） |
| `/an` 行业归属 / 行业涨幅排行 / 行业日线 | 东财 `stock/get` + 行业 `clist` + 板块日K（统一行业口径） |
| 个股公告 | 东财 `np-anotice-stock` |
| 个股新闻 | 东财 `search-api-web` |
| 基金资料 / 前十持仓 | 东财 `fundmobapi` + `fundf10` jjcc |
| 重要快讯 | 同花顺 7×24 官方接口 |
| 磁力预览 | WhatsLink 公开 API |

### 配置

**环境变量**（`docker-compose.yml` 已设，一般无需改）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `NAPCAT_WS_URL` | `ws://official-bot-gateway:3101` | OneBot 事件通道（变量名沿用历史命名） |
| `NAPCAT_URL` | `http://official-bot-gateway:3100` | OneBot HTTP 发送地址 |
| `NAPCAT_TOKEN` | 空 | access token（若启用） |
| `BOT_UIN` | `${QQBOT_APP_ID}` | 机器人标识，用于识别「@」 |
| `NEWS_QUERY_LIMIT` | `10` | `/快讯` 返回条数 |
| `DAILY_PUSH_ENABLED` | `false` | 每日 21:30 汇总推送总开关（用户已取消，默认关） |
| `DAILY_PUSH_HOUR` / `DAILY_PUSH_MIN` | `21` / `30` | 汇总推送时间 |

**`config.json`**（挂载 `/app/config.json`，**每次收到消息热加载，改完立即生效**）：

| 字段 | 当前值 | 说明 |
|---|---|---|
| `groupAtOnly` | `true` | 群聊仅响应被 @ 的消息 |
| `privateAlways` | `true` | 私聊响应总开关（配合 `privateWhitelist`） |
| `admins` | `["1547450303"]` | 管理员，群聊中可用全部指令。**只认主人 QQ 号 + 其他用户的 openid**——非主人的 QQ 号填了也匹配不上 |
| `owners` | `["1547450303"]` | **机器人主人**：写操作（`/stocks` 的 `-add` / `-update` / `-del`）的唯一凭据，填 **QQ 号**。空数组 = 谁都不能写（fail-closed） |
| `privateWhitelist` | `["1547450303"]` | 私聊白名单（不在此列表一律拒绝；空数组 = 不限制） |
| `groupWhitelist` | `[]` | 群白名单（非空 = 仅响应列表内群；空数组 = 不限制） |
| `groupAdminOnly` | `false` | 群聊仅管理员可触发 |
| `groupRestrictedCmds` | 10 条 | 群聊非管理员可用指令名白名单（空数组 = 不限制）。`stocks` 放行只代表「能调这条指令」——查询 / `-list` 所有人开放，写操作由 `owners` 独立把关 |
| `groupImages` | `false` | 群聊是否带图。腾讯对群聊批量图片有安全审核，默认只发文本、图片私聊补发 |
| `restrictedMsg` / `deniedMsg` / `unknownMsg` / `welcome` | 见文件 | 各类提示文案；置 `""` 则完全忽略不回复 |

> 指令名取 `routeCommand()` 返回的 `name`（不含 `/`）。加新指令：在 `reply/index.js` 的 `routeCommand()` 里追加 `case`，然后 `docker compose restart qq-reply`。
>
> **两层权限不要混淆**：`groupRestrictedCmds` / `admins` 决定「指令名能不能调」；`owners` 决定「组合能不能被写」。`owners` 填 **QQ 号**（不是 openid）——只有主人的 `user_id` 会由网关还原成纯 QQ 号，其他用户一律是 openid，所以 `owners` 名单里放别人的 openid 是无效的（那些人本就无权写）。

### 排障

- **指令改了没生效**：`index.js` 是 bind mount，但 Node 启动时载入内存，必须 `docker compose restart qq-reply`。改 `config.json` 则**无需**重启。
- **WS 一直重连**：确认 `official-bot-gateway` 已在跑且 3101 端口正常；日志里看到 `✅ WebSocket 已连接 ws://official-bot-gateway:3101` 即就绪。
- **@ 机器人无反应**：`BOT_UIN` 必须与网关转发的 `at` 标识一致（当前取 `${QQBOT_APP_ID}`）。可用 `/status` 查看机器人信息与通道状态。
- **私聊不响应**：检查 `privateAlways`，以及你的 QQ 是否在 `privateWhitelist` 内。
- **群聊指令被拒**：普通成员只能用 `groupRestrictedCmds` 内指令，属预期；放行需把指令名加进该列表，或把账号加进 `admins`。
- **`/stocks -add` / `-update` / `-del` 报「仅限机器人主人」**：编辑命令只认 `owners`，`admins` 不生效。确认 `reply/config.json` 的 `owners` 填的是**主人 QQ 号**（不是 openid）；改完无需重启（热加载）。
- **主人能查询却不能写**：`owners` 里填成了 openid。代码会在网关可用时自动用其下发的 `owner.openid` 兜底识别主人，但**前提是网关侧主人身份正确**（私聊发过 `bind-owner`、且没被重置）。可用 `curl -s http://127.0.0.1:3100/bindings` 核对 `owner` 段。
- **图片发不出去 / 群聊没图**：`groupImages: false` 时群聊只发文本、图片自动私聊补发，属预期。官方通道对同一条消息的图片数量与频次有限制。
- **图表「没字」**：容器内缺 `/app/fonts/cjk_sub.ttf`。执行 `bash ths-news/setup_fonts.sh`，bind mount 实时生效、无需重启。
- **`/stocks -add` 报「保存失败（服务端写盘异常）」**：`./reply/data` 未正确挂载或不可写。确认 docker-compose 里是 `./reply/data:/app/data`（**不能带 `:ro`**），且宿主 `reply/data/` 目录存在。首次部署务必先 `mkdir -p reply/data && echo '{}' > reply/data/portfolios.json`——否则 Docker 会把不存在的宿主路径**当成目录**创建。

---

## 快讯转发（ths-news）

每 **5 分钟**（`NEWS_INTERVAL=300`）拉取同花顺官方 7×24「重要」快讯，渲染成中文 SVG→PNG 图片卡片推送到 QQ。**分级聚合**——命中必推关键词的极重要资讯立即推，其余重要资讯攒够 8 条（`AGG_COUNT`）或到整点/半点（每 30 分钟）再推一批。

```
同花顺官方接口（import>0 即「重要」）
        │  每 5 分钟（start_news_cron.sh 循环）
        ▼
fetch_ths_news.js ── 过滤(import>0) + 去重(state) + 组装条目
        │
        ▼  buildCardSvg() → 中文 SVG 卡片
   @resvg/resvg-js → PNG（挂载字体 cjk.ttc）
        │
        ▼  official-bot-gateway HTTP :3100（base64 图片消息）
   QQ 私聊 / 群
```

| 变量 | 当前值 | 说明 |
|---|---|---|
| `NAPCAT_URL` | `http://official-bot-gateway:3100` | 发送出口 |
| `NEWS_INTERVAL` | `300` | 拉取间隔（秒） |
| `THS_STATE` | `/app/state/ths_news_state.json` | 去重状态文件（持久卷 `ths-news-state`） |
| `IMPORT_ONLY` | `true` | `true` = 仅官方「重要」；`false` = 退化为关键词加权 |
| `URGENT_KEYWORDS` | 见代码 | 极重要（立即推）必推关键词，逗号分隔，可环境变量覆盖 |
| `AGG_COUNT` | `8` | 普通重要资讯聚合阈值：攒够该条数即推一批（否则整点/半点推） |

**排障**：

- **图片「没字」**：容器内 `/app/fonts/cjk.ttc` 缺失。`docker exec ths-news ls -la /app/fonts/cjk.ttc` 确认；宿主执行 `setup_fonts.sh` 补齐即可（实时生效）。
- **周六 / 休市收不到**：正常。非交易时段 `import=0` 居多，`--dry-run` 会显示「本次新候选 0 条」。
- **@resvg 没装上**：`start_news_cron.sh` 首启装带 5 次重试；卷损坏可 `docker compose down -v` 重建，或 `docker exec ths-news npm install @resvg/resvg-js`。

> 详见 [`ths-news/README.md`](./ths-news/README.md) 与 [`ths-news/PROMPTS.md`](./ths-news/PROMPTS.md)。

---

## A股 复盘推送（a-share-report）

把 WorkBuddy 自动化 / `a-share-daily-review` skill 生成的 **A股 复盘 HTML 报告**渲染成适合手机阅读的长图并推送。**跑在宿主机**（非容器），依赖本机 Chrome + `puppeteer-core`——因为需要真实浏览器渲染 ECharts 图表（与 ths-news 的纯 resvg 路线不同）。

> 发送出口同样是官方网关，默认 `NAPCAT_URL=http://127.0.0.1:3100`（宿主直连）。

**前置**：Node ≥ 18、一款 Chrome / Chromium（macOS 默认 `/Applications/Google Chrome.app/...`，其它平台用 `CHROME_PATH` 覆盖）、`puppeteer-core`（放在可被 `NODE_PATH` 找到的 `node_modules` 下）、机器人已上线且网关已学习到目标映射。

```bash
# 自动推送（传入报告路径；目标与尺寸读 push_targets.json）
NODE_PATH=<ws>/node_modules node a-share-report/push_report.js /path/to/A股-YYYY-MM-DD-复盘.html

# 不传路径时，按当天日期在 REPORT_DIR 下自动查找
NODE_PATH=<ws>/node_modules node a-share-report/push_report.js

# 仅渲染成 PNG 预览（不推送）
NODE_PATH=<ws>/node_modules node a-share-report/render_report.js /path/to/report.html /tmp/preview.png
```

| 变量 | 默认 | 说明 |
|---|---|---|
| `CHROME_PATH` | macOS Chrome 路径 | 换平台/换电脑时必设 |
| `NODE_PATH` | 运行时前缀传入 | 指向含 `puppeteer-core` 的 `node_modules` |
| `REPORT_DIR` | `/Users/zhangxu/WorkBuddy/个人demo/daily-review` | 不传报告路径时按当天日期查找的目录（**其他端务必覆盖**） |
| `PUSH_TARGETS` | 脚本同目录 `push_targets.json` | 推送目标配置 |
| `NAPCAT_URL` | `http://127.0.0.1:3100` | 官方网关地址（宿主直连） |
| `QQ_PRIVATE_IDS` / `QQ_GROUP_IDS` | 读配置文件 | 临时覆盖推送目标（逗号分隔） |
| `REPORT_CAPTION` | 读配置文件 | 图片前的文字说明 |
| `IMAGE_WIDTH` / `IMAGE_SCALE` | `600` / `2` | 输出图片宽度（CSS px）与倍率 |
| `REPORT_PNG` | `/tmp/a_share_report.png` | 渲染输出 PNG 路径 |

> 详见 [`a-share-report/SKILL.md`](./a-share-report/SKILL.md)。

---

## NapCat 备用通道（默认未启动）

NapCat 是保留的非官方个人号备用通道。由于个人号存在掉线和风控风险，当前 `docker-compose.yml` 默认使用官方适配器，NapCat 服务段保持注释、按需恢复：

1. 取消 `napcat` 与 `qq-reply-napcat` 两段注释；
2. `.env` 填入 `QQ_ACCOUNT`（建议小号）；
3. `docker compose up -d napcat qq-reply-napcat`；
4. 访问 `http://localhost:6099` 扫码登录（登录态存于 `napcat/QQ/`，重启自动复用）。

该通道使用**独立权限配置** `reply/config.napcat.json`，与官方通道的 `config.json` 互不影响。

旧 `monitor/` 自动守护已删除：该方案无法在机器人彻底掉线时通过机器人自身可靠感知和送达告警。恢复 NapCat 后请通过 WebUI、容器日志或独立于 QQ 机器人的外部监控检查登录状态。

---

## 常用运维命令

```bash
# 服务状态
docker compose ps

# 实时日志
docker logs -f official-bot-gateway
docker compose logs -f qq-reply
docker compose logs -f ths-news

# 重启单个服务（改完 index.js 必须重启）
docker compose restart qq-reply

# 查看目标绑定（QQ 号 / 群号 → openid 映射）
curl -s http://127.0.0.1:3100/bindings

# 查看 /stocks 已保存的组合
cat reply/data/portfolios.json

# 停止 / 删除全部
docker compose down
```

---

## 注意事项

1. **凭证保密**：`.env` 里的 `QQBOT_APP_SECRET` 等同于机器人密码，切勿提交或外传。
2. **openid 与 QQ 号的关系**：官方平台只认 openid。本项目网关做了映射层，**已互动过的目标仍可直接填 QQ 号 / 群号**；没互动过的目标必须先"见"一次（owner 私聊 `bind-owner`、群需被 @ 一次），或用 openid。映射表用 `/bindings` 查看。**注意**：这个「openid → QQ 号」的反查只对 `bindings.owner` 生效，其余用户拿到的事件里 `user_id` 仍是 openid——因此 `reply/config.json` 的 `admins` 若要给非主人放权，必须填 **openid**；而 `owners` 填 **QQ 号**即可（代码另有网关 `owner.openid` 兜底）。
3. **主动推送配额**：单用户/单群 1000 条/天、20 条/分钟；用户可关闭「允许主动发送」，关闭后主动消息会失败。**被动回复不受此限**，但有 5 分钟 / 60 分钟时效。
4. **登录态保密**：`napcat/QQ/` 含 QQ session（备用通道），已 gitignore，不要上传公开仓库。
5. **字体授权**：中文字体体积大且涉及授权，已 gitignore，用 `setup_fonts.sh` 从本机系统复制。
6. **持仓保密**：`reply/data/portfolios.json` 记录 `/stocks` 保存的组合（等同个人持仓/自选），已 gitignore，不要提交或外传。
6. **配置保密**：`ths_news_targets.json` / `push_targets.json` / `bindings.json` 含真实 QQ 号 / openid，均 gitignore，勿提交。
7. **如果恢复 NapCat 通道**：建议用小号，不要用主号。

---

## 相关 Skill（WorkBuddy 可复用）

**仓库内**（项目级，`.workbuddy/skills/`）：

| Skill | 职责 |
|---|---|
| `qq-reply-service` | qq-reply 指令服务的部署 / 排障 / 扩展经验 |

**全局**（用户级，组成「A股复盘推送」自动化包）：

| Skill | 职责 |
|---|---|
| `a-share-daily-review` | 生成 A股 复盘 HTML 报告（含 ECharts） |
| `a-share-report-push` | 把报告渲染成图并推到 QQ |
| `ths-news-forwarder` | 同花顺官方「重要」快讯 → 中文图片卡片 → QQ |

三者配合：`a-share-daily-review` 生成报告 → `a-share-report-push` 推送；`ths-news-forwarder` 另起一条 5 分钟循环的资讯转发。**共用同一个官方机器人网关。**
