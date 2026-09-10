# QQ 机器人（官方开放平台通道）

基于**官方 QQ 机器人**（[q.qq.com](https://q.qq.com) 开放平台的 AppID + AppSecret）+ 一个 **OneBot 兼容网关**，把三条自动化链路和一套指令中心拧在一起：

| 链路 | 服务 | 运行形态 | 职责 |
|---|---|---|---|
| **通道网关** | `official-bot-gateway` | 容器 | 官方开放平台 ↔ OneBot 协议互转（HTTP `3100` / WS `3101`） |
| **指令中心** | `qq-reply` | 容器 | 群聊被 @ / 私聊发指令 → 行情图、K线、资金流、个股资料、ETF 持仓、快讯、磁力预览 |
| **快讯转发** | `ths-news` | 容器 | 每 5 分钟拉取同花顺官方「重要」快讯，渲染中文图片卡片推送 |
| **A股复盘推送** | `a-share-report` | 宿主机脚本 | 把 A股 复盘 HTML 渲染成长图推送到 QQ |

> **历史沿革**：项目早期基于 **Koishi + NapCat**（个人号方案）。Koishi 栈已完全移除；NapCat 通道于 2026-09-02 停用（个人号频繁掉线、风控风险高），整体切到官方机器人通道。NapCat 相关服务在 `docker-compose.yml` 中保留为注释，可随时恢复（见[备用通道](#napcat-备用通道已停用)）。

---

## 为什么换成官方机器人

| | NapCat（个人号，已停用） | 官方机器人（现行） |
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
├── reply/                            # ★ 指令中心（容器，零依赖）
│   ├── index.js                        # 主服务：WS 事件监听 + 全部指令实现（单文件）
│   ├── config.json                     # 权限配置（官方通道用）
│   ├── config.napcat.json              # 权限配置（NapCat 通道备用，当前停用）
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
├── monitor/                          # NapCat 掉线监控（宿主机脚本，随 NapCat 一并停用）
└── napcat/                           # NapCat 运行数据（登录态，已 gitignore，保留备查）
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

单一文件 `reply/index.js` 实现全部指令，**零 npm 依赖**（Node ≥ 21 内置 `WebSocket` + `fetch`），外部依赖仅从 `ths-news-modules` 卷只读共享的 `@napi-rs/canvas`（主）+ `@resvg/resvg-js`（兜底），用于渲染图表。

### 权限模型

| 场景 | 行为 |
|------|------|
| 群聊 · 普通成员 @ + **闲聊** | **忽略**（只有特定指令才触发，防止被随便 @ 刷屏） |
| 群聊 · @ + 指令 | 响应；普通成员仅可使用 `groupRestrictedCmds` 内指令，其余回 `restrictedMsg` |
| 群聊 · 管理员（`admins`）直接发磁链（无需 @） | 自动预览 |
| 群聊 · 不在 `groupWhitelist` 的群 | 完全忽略 |
| 私聊 · 在 `privateWhitelist` | 仅响应指令 / 磁链，闲聊忽略 |
| 私聊 · 不在 `privateWhitelist` | 回 `deniedMsg` 拒绝提示 |

> **当前生效配置**（`reply/config.json`）：管理员与私聊白名单均为 `1547450303`；群聊开放指令集为 `ping / status / ss / stock / stocks / zj / info / echo / news / help`（**`/preview` 磁力预览、`/stocks -add` `-del` 仅管理员**）；`groupImages: false`。

### 指令表

**📈 行情与图表**

| 指令 | 别名 | 说明 |
|---|---|---|
| `/ss` | `/指数` | 指数行情图：上证 / 沪深300 / 全市场成交额 / 申万二级资金流 |
| `/stock <周期> <代码或名称>` | `/股票` `/K线` | K线图 / 分时图 / 文本速查（详见下节） |
| `/stocks <周期> <组合名 或 股票...>` | `/组合` `/自选` | **股票组合拼图**：一张图并列多看（详见下节） |
| `/zj <1\|2> [t\|d]` | `/资金` | 申万行业资金流（详见下节） |

**📊 个股与基金**

| 指令 | 别名 | 说明 |
|---|---|---|
| `/info <代码或名称> [条数]` | `/个股` `/资料` | 个股速查（**仅 A股**）：行情 / 公司概况 / 公告 / 新闻。条数默认 3 公告 + 5 新闻 |
| `/etfinfo <代码或名称>` | `/etf` `/基金持仓` | ETF 速查：前十持仓 + 跟踪指数；非 ETF 会明确说明原因 |

**📰 资讯**

| 指令 | 别名 | 说明 |
|---|---|---|
| `/快讯` | `/news` `/资讯` | 同花顺官方「重要」快讯，最近 10 条 |

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

**品种覆盖与降级规则**：

| 品种 | 输入示例 | 支持周期 | 说明 |
|---|---|---|---|
| A股 | `600519` `贵州茅台` | 全部 | 6 位代码直用；中文名走搜索解析 |
| ETF | `510300` `沪深300ETF` | 全部 | |
| 港股 | `00700` `hk00700` | `-d` `-w` `-M` `-t` | 数据源无分钟 K，会明确提示 |
| 美股 | `AAPL` `usAAPL` | `-d` `-w` `-M` `-t` | 数据源无分钟 K；**盘后显示上个交易日** |
| 国际商品 | `布伦特原油` `黄金` | 仅 `-t` | 新浪全球期货源；`-d` 退化为文本行情速查 |
| 全球指数 | `道琼斯` `恒指` | 文本速查 | 无 K 线；例外：恒指支持 `-t` 分时图 |

**示例**：

```bash
/stock -d 600519          # 贵州茅台日线
/stock -5m 贵州茅台        # 5 分钟 K
/stock -t 00700           # 腾讯控股当日分时
/stock AAPL               # 苹果日线（默认周期）
/stock -t 布伦特原油        # 商品分时
/stock 道琼斯              # 指数文本速查
```

### `/stocks` 详解

一篮子票拼成一张图，适合手机上一次性扫完自选或持仓。

```
/stocks <周期> <组合名 或 股票...>          # 出图
/stocks -add <股票...> -name <组合名>       # 保存/覆盖组合（严格管理员）
/stocks -del <组合名>                       # 删除组合（严格管理员）
/stocks -list                               # 列出已保存组合
```

**周期**（**单选**，不写默认日线）：`-t` 分时 / `-d` 日线 / `-w` 周线 / `-m` 月线。比 `/stock` 少——分钟/小时图对组合视角没意义，已移除。

```bash
/stocks -d 我的持仓                # 展开组合出日线拼图
/stocks -t 600519 000858           # 直接给多只股票，按输入顺序出图
/stocks -add 600519 300750 002594 -name 我的持仓   # 保存（仅管理员）
/stocks -list                      # 看有哪些组合
```

**出图规格**（按手机可读性倒推）：

| 项 | 做法 |
|---|---|
| 画布 | 1080px 宽竖版长图，单张 PNG 直出 |
| 列数 | 自适应：1 只→1 列；2–8 只→2 列；9–12 只→3 列；13–16 只→4 列（**每行最多 4 个**） |
| 子图 | 精简版：无成交量/均线/BOLL；K 线画蜡烛，分时画价格线 + 均价线 |
| 纵轴 | **各自价格轴**，配灰色虚线基准（K 线=区间起点收盘，分时=昨收） |
| 配色 | 涨红跌绿（`#e0483e` / `#12a05c`） |
| 顶部 | 组合名 + 周期/时间（左）；平均涨跌幅 + `N 只 · M 涨 K 跌`（右） |
| 容错 | 单只取数失败 → 该格灰底占位，其余照常出图 |

> 组合数据落在 `reply/data/portfolios.json`（宿主可写挂载 `/app/data`，gitignored）。格式见 `reply/data/portfolios.json.example`。
>
> 列数与字号是按**实测字宽**定的：1080px 画布缩到 390pt 手机屏只有 0.36 倍，26px 字到手机上仅剩约 9.4pt——所以 4 列已是可读极限，代码里会自动降级（3 列去掉「现价」、4 列去掉「区间」前缀）以避免文字重叠。

### `/zj` 详解

```
/zj <级别> [t|d]
```

- **级别**：`1` / `一级` / `sw1` → 申万一级（31 个行业）；`2` / `二级` / `sw2` → 申万二级（124 个行业）。
- **第二参数**（可省略）：留空 = 当前排行 TOP10 图；`t` / `分时` = 分时波动曲线；`d` / `日` / `日线` = 日级流入曲线。
- ⚠️ `3` 申万三级**无公开免费数据源**（腾讯 `hy3` 实测无数据），命令会明确提示。曲线图用东财行业分类（申万无免费时序源）。

```bash
/zj 1        # 申万一级当前资金流排行
/zj 2 t      # 申万二级分时波动曲线
/zj 2 d      # 申万二级日级流入曲线
```

### 数据源一览

| 数据 | 来源 |
|---|---|
| 实时快照（含指数/ETF/港股/美股） | 腾讯 `qt.gtimg.cn`（GBK） |
| 日 / 周 / 月 K（320 根，前复权） | 腾讯 `web.ifzq.gtimg.cn` fqkline |
| 分钟 K（1/5/30/60m） | 腾讯 `proxy.finance.qq.com` mkline |
| 当日分时 | 腾讯 minute/query、东财 `push2his` trends2 |
| 名称 → 代码搜索 | 腾讯 `smartbox.gtimg.cn`（GBK） |
| 国际商品分时 | 新浪 `GlobalFuturesService` |
| 申万行业资金流 | 腾讯 `getRank`（`hy` / `hy2`，字段 `zljlr`） |
| 板块资金流曲线 | 东财 `clist` + `fflow`（分时/日级） |
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
| `admins` | `["1547450303"]` | 管理员 QQ，群聊中可用全部指令 |
| `privateWhitelist` | `["1547450303"]` | 私聊白名单（不在此列表一律拒绝；空数组 = 不限制） |
| `groupWhitelist` | `[]` | 群白名单（非空 = 仅响应列表内群；空数组 = 不限制） |
| `groupAdminOnly` | `false` | 群聊仅管理员可触发 |
| `groupRestrictedCmds` | 10 条 | 群聊非管理员可用指令名白名单（空数组 = 不限制）。`stocks` 放行只代表可用查询 / `-list`，`-add` / `-del` 仍是代码内独立校验的严格管理员操作 |
| `groupImages` | `false` | 群聊是否带图。腾讯对群聊批量图片有安全审核，默认只发文本、图片私聊补发 |
| `restrictedMsg` / `deniedMsg` / `unknownMsg` / `welcome` | 见文件 | 各类提示文案；置 `""` 则完全忽略不回复 |

> 指令名取 `routeCommand()` 返回的 `name`（不含 `/`）。加新指令：在 `reply/index.js` 的 `routeCommand()` 里追加 `case`，然后 `docker compose restart qq-reply`。

### 排障

- **指令改了没生效**：`index.js` 是 bind mount，但 Node 启动时载入内存，必须 `docker compose restart qq-reply`。改 `config.json` 则**无需**重启。
- **WS 一直重连**：确认 `official-bot-gateway` 已在跑且 3101 端口正常；日志里看到 `✅ WebSocket 已连接 ws://official-bot-gateway:3101` 即就绪。
- **@ 机器人无反应**：`BOT_UIN` 必须与网关转发的 `at` 标识一致（当前取 `${QQBOT_APP_ID}`）。可用 `/status` 查看机器人信息与通道状态。
- **私聊不响应**：检查 `privateAlways`，以及你的 QQ 是否在 `privateWhitelist` 内。
- **群聊指令被拒**：普通成员只能用 `groupRestrictedCmds` 内指令，属预期；放行需把指令名加进该列表，或把账号加进 `admins`。
- **图片发不出去 / 群聊没图**：`groupImages: false` 时群聊只发文本、图片自动私聊补发，属预期。官方通道对同一条消息的图片数量与频次有限制。
- **图表「没字」**：容器内缺 `/app/fonts/cjk_sub.ttf`。执行 `bash ths-news/setup_fonts.sh`，bind mount 实时生效、无需重启。
- **`/stocks -add` 报「保存失败（服务端写盘异常）」**：`./reply/data` 未正确挂载或不可写。确认 docker-compose 里是 `./reply/data:/app/data`（**不能带 `:ro`**），且宿主 `reply/data/` 目录存在。首次部署务必先 `mkdir -p reply/data && echo '{}' > reply/data/portfolios.json`——否则 Docker 会把不存在的宿主路径**当成目录**创建。

---

## 快讯转发（ths-news）

每 **5 分钟**（`NEWS_INTERVAL=300`）拉取同花顺官方 7×24「重要」快讯，渲染成中文 SVG→PNG 图片卡片推送到 QQ。**「有就发、不丢弃」**——本轮新捞到的「重要」快讯全部立即推送。

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

## NapCat 备用通道（已停用）

NapCat（非官方个人号方案）于 **2026-09-02 停用**——个人号频繁掉线且风控风险高。相关服务在 `docker-compose.yml` 中**整体注释保留**，恢复步骤：

1. 取消 `napcat` 与 `qq-reply-napcat` 两段注释；
2. `.env` 填入 `QQ_ACCOUNT`（建议小号）；
3. `docker compose up -d napcat qq-reply-napcat`；
4. 访问 `http://localhost:6099` 扫码登录（登录态存于 `napcat/QQ/`，重启自动复用）。

该通道使用**独立权限配置** `reply/config.napcat.json`，与官方通道的 `config.json` 互不影响。

`monitor/check_napcat.sh` 是配套的掉线守护脚本（`online && good` 双真判断，掉线自动重启自愈、需扫码时导出二维码）。**官方机器人在线稳定，该监控对现行通道不再适用**。

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
2. **openid 与 QQ 号的关系**：官方平台只认 openid。本项目网关做了映射层，**已互动过的目标仍可直接填 QQ 号 / 群号**；没互动过的目标必须先"见"一次（owner 私聊 `bind-owner`、群需被 @ 一次），或用 openid。映射表用 `/bindings` 查看。
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
| `napcat-monitor` | NapCat 掉线监控与按需扫码工作流（随 NapCat 停用） |

**全局**（用户级，组成「A股复盘推送」自动化包）：

| Skill | 职责 |
|---|---|
| `a-share-daily-review` | 生成 A股 复盘 HTML 报告（含 ECharts） |
| `a-share-report-push` | 把报告渲染成图并推到 QQ |
| `ths-news-forwarder` | 同花顺官方「重要」快讯 → 中文图片卡片 → QQ |

三者配合：`a-share-daily-review` 生成报告 → `a-share-report-push` 推送；`ths-news-forwarder` 另起一条 5 分钟循环的资讯转发。**共用同一个官方机器人网关。**
