# 同花顺重要资讯转发（ths-news）

把**同花顺官方 7×24「重要」财经快讯**自动转发到 **QQ 私聊 / 群**，以**中文图片卡片**形式推送（标题在上、摘要在下）。

- 数据源：同花顺官方 7×24 接口，每条自带 `import` 字段（`import>0` 即官方标记的「重要」），比关键词加权更准。
- 重要性显示：保留原有消息格式，在标题前按官方 `import` 层级追加圆点：`import=3` 为 `🔴`、`import=2` 为 `🟡`、`import=1` 为 `🔵`，`import=0` 或未知值不追加。
- 风险分类：圆点只表示同花顺官方重要性，不改变项目按关键词和主题规则计算的 `重大异动 / 关注事件 / 重要资讯` 事件等级。
- 渲染：纯 Rust 的 `@resvg/resvg-js` 把 SVG 渲染成 PNG（**无 Chrome / 无 puppeteer 依赖**）。
- 推送：经 **`official-bot-gateway`**（官方开放平台通道，OneBot 兼容 HTTP）推到 QQ。
- 自动化：容器内 `start_news_cron.sh` 每 **5 分钟**拉取一次；同花顺已标记为重要（`import>0`）的资讯再经过**事件等级 + 主题规则**分类：红色风险/商品强事件立即推，黄色关注与普通重要仍按原有缓冲聚合推送。
- 主题：覆盖黄金避险、原油能源、天然气煤炭、工业金属、新能源资源、农产品、利率汇率、宏观政策、地缘供应链、科技产业、地产金融；同一条卡片展示时间、主题和事件等级标签。

> 当前 Compose 默认通过官方网关推送；NapCat 非官方通道仍作为备用保留、默认未启动。历史变量名 `NAPCAT_URL` 实际表示 OneBot HTTP 地址。

---

## 架构

```
同花顺官方接口 (import>0 即「重要」)
        │  每 5 分钟（start_news_cron.sh 循环）
        ▼
fetch_ths_news.js  ── 过滤(import>0) + 去重(seen) + 事件/主题分类 + 队列聚合
        │
        ▼  buildCardSvg() → 中文 SVG 卡片
   @resvg/resvg-js  →  PNG（挂载的中文字体 cjk.ttc）
        │
        ▼  official-bot-gateway HTTP :3100 (base64 图片消息)
   QQ 私聊 / 群 (ths_news_targets.json 配置)
```

依赖服务：`official-bot-gateway`（官方机器人 OneBot 兼容层）。ths-news 容器通过 `botnet` 网络访问 `http://official-bot-gateway:3100`。

---

## 目录结构

```
qq-koishi-bot/
├── docker-compose.yml        # official-bot-gateway + qq-reply + ths-news 编排（部署入口）
├── .env.example              # 凭证模板（QQBOT_APP_ID / QQBOT_APP_SECRET）
├── .gitignore                # 已忽略字体/密钥/日志
├── official-bot-gateway/     # 官方机器人网关（OneBot 兼容层）
├── napcat/                   # NapCat 备用通道运行数据（默认未启动）
└── ths-news/                 # ★ 本服务全部源码与文档
    ├── fetch_ths_news.js        # 主脚本（含全部渲染/过滤/推送逻辑）
    ├── news_rules.json             # ★ 事件等级/主题词库（每轮热加载，无需重启）
    ├── start_news_cron.sh       # 容器内 5 分钟循环 + 首启装 resvg
    ├── ths_news_targets.json.example  # 推送目标模板
    ├── setup_fonts.sh           # 从本机复制中文字体（避免提交 22MB）
    ├── fonts/                   # 中文字体目录（.ttc / .ttf 不入库）
    │   └── .gitkeep
    ├── README.md                # 本文件
    ├── PROMPTS.md               # 可直接复制粘贴的提示词
    └── SKILL.md                 # WorkBuddy Skill 定义（AI 可复用）
```

---

## 快速开始（首次部署）

前置：安装好 **Docker** 与 **Docker Compose**，并已有一个通过审核的官方 QQ 机器人（AppID / AppSecret）。

```bash
# 1. 克隆仓库
git clone <your-repo-url> qq-koishi-bot && cd qq-koishi-bot

# 2. 准备官方机器人凭证
cp .env.example .env
#   编辑 .env，填入 q.qq.com 拿到的 QQBOT_APP_ID / QQBOT_APP_SECRET

# 3. 准备推送目标
cp ths-news/ths_news_targets.json.example ths-news/ths_news_targets.json
#   目标可直接填 QQ 号 / 群号，前提是网关已"学习"到映射（见下），首次部署可留空：
#   私聊机器人发 bind-owner 绑 owner，再把机器人拉进群并 @ 一次，映射即被自动学习
#   用 curl -s http://127.0.0.1:3100/bindings 查看，再回填 private / groups

# 4. 准备中文字体（关键！否则推到 QQ 的图片「没字」）
bash ths-news/setup_fonts.sh
#   会自动从本机系统字体复制一款 CJK 字体到 ths-news/fonts/cjk.ttc
#   macOS / Linux 常见字体均已内置候选；找不到时按提示手动放置

# 5. 启动
docker compose up -d

# 6. 验证（可选）
docker exec ths-news node /app/fetch_ths_news.js --dry-run   # 看筛选结果，不推送
```

---

## 配置说明

### `ths_news_targets.json`

```json
{
  "private": ["1547450303"],        // 私聊接收者（数组，可多个）：QQ 号（已学习映射）或 openid
  "groups":  ["609994072"],         // 群接收者（数组，可多个）：群号（已学习映射）或群 openid
  "imageWidth": 600,               // 卡片宽度（px，仅记录用）
  "imageScale": 2                  // 渲染倍率（仅记录用）
}
```

脚本优先读取 `ths_news_targets.json`，不存在时回退 `push_targets.json`，再回退默认（仅私聊空）。

### `news_rules.json`：事件等级与主题词库

规则文件由 `ths-news` 每轮抓取时重新读取，修改后**无需重启容器**。它只对同花顺已标记为重要（`import>0`）的资讯做内部优先级整理，不会把普通快讯无条件放大。

- `redRisk`：**明确重大风险或冲击短语**。例如退市风险、债务违约、行政处罚决定书、战争爆发、供应中断；只出现“停牌”“处罚”“破产”“加息”等单词不会直接红色。
- `priceShock`：价格冲击词，例如暴涨、跌超、跳水、失守、突破、历史首次站上。它必须和黄金、原油、汇率或大宗商品主题同时出现在**标题**中，才升级为红色。
- `predictiveWords`：预测性措辞，例如“预计、预期、或将、市场计价”。它会阻止“预计加息”等未来预期被误判为即时重大异动。
- `clarificationWords` / `equityMarketWords`：澄清否认和 A 股板块行情降噪词。前者避免“澄清未参与破产企业”误报，后者避免“煤炭板块涨停”被误当成煤价异动。

> 私聊和群聊推送目标、发送节流、重试、拆图逻辑均未改变，仍完全读取 `ths_news_targets.json` 的 `private` 与 `groups`。

同花顺 `import` 是官方重要性层级，项目自身的事件等级是另一套规则。标题显示保持原格式，只在标题前追加圆点：

| `import` | 标题前缀 | 含义 |
|---|---|---|
| `3` | `🔴` | 官方重要性最高 |
| `2` | `🟡` | 官方重要性次高 |
| `1` | `🔵` | 官方重要资讯 |
| `0` / 未知 | 无 | 不追加圆点 |

圆点会同时出现在图片卡片、主动推送的纯文本回退、`/快讯` 文本和每日汇总中；不会改变筛选、排序、聚合或事件等级判断。

### 三档等级：你会收到什么

| 等级 | 卡片标签 | 推送时机 | 典型例子 |
|---|---|---|---|
| 🔴 重大异动 | `重大异动` | 立即推送 | 现货黄金失守 4300、WTI 原油涨超 4%、原油历史首次站上关键价位、人民币急跌、债务违约、退市风险、供应中断 |
| 🟡 关注事件 | `关注事件` | 保留原有聚合规则 | EIA 库存、业绩预告、回购/重组、普通宏观数据、利率预期、人民币中间价 |
| ⚪ 重要资讯 | `重要资讯` | 保留原有聚合规则 | 板块涨跌、一般行业新闻、普通市场行情 |

**重大异动不等于利空。** 它表示市场状态发生了值得立刻查看的变化；黄金大涨、油价暴涨、汇率破位与公司退市风险都会显示为红色，但原因不同。

- 商品/汇率的红色规则：`主题 + 标题内价格冲击`。例如“黄金 + 失守”“WTI + 涨超”“沪铜 + 跳水”“人民币 + 急跌”。
- 预测不会自动红色：例如“机构预计美联储加息”仍是黄色；“美联储意外加息 / 美元跳涨”才可能是红色。
- A 股板块涨停不冒充商品异动：例如“煤炭板块涨停”仍按普通重要处理，不会被当成煤价异动。
- 红色即时推送与黄色/普通聚合推送，仍会同时发送到 `ths_news_targets.json` 中既有的 `private` 和 `groups`，目标与发送节流逻辑没有变化。

### 环境变量（容器 / docker-compose 已设）

| 变量 | 默认 | 说明 |
|---|---|---|
| `NAPCAT_URL` | `http://official-bot-gateway:3100` | 官方网关地址（变量名沿用历史命名） |
| `NAPCAT_TOKEN` | 空 | access token（若启用） |
| `THS_STATE` | `/app/state/ths_news_state.json` | 去重状态文件路径 |
| `THS_CONFIG` | `/app/ths_news_targets.json` | 推送目标配置路径 |
| `THS_FONT` | `/app/fonts/cjk.ttc` | 中文字体路径 |
| `THS_RULES` | `/app/news_rules.json` | 事件等级与主题词库路径；默认每轮热加载 |
| `NEWS_INTERVAL` | `300` | 拉取间隔（秒，即 5 分钟） |
| `IMPORT_ONLY` | `true` | `true`=仅同花顺「重要」；`false`=退化为关键词加权筛选 |

---

## 排障知识库

### 1. 推到 QQ 的图片「没字了」（文字空白，只剩红条/分隔线）
**根因**：脚本 `FONT_PATH` 默认 `/app/fonts/cjk.ttc`，但容器内该字体缺失 → resvg 加载不到字体 → 中文不渲染。
最常见诱因：`docker compose up -d` 重建容器时，bind mount `./ths-news/fonts:/app/fonts:ro` 用宿主目录覆盖了之前 `docker cp` 进去的 `cjk.ttc`。
**修复**：在宿主 `ths-news/fonts/` 放一份无空格文件名的 `cjk.ttc`（如 `bash setup_fonts.sh` 复制的），bind mount 实时生效，**无需重启容器**。
**验证**：`docker exec ths-news ls -la /app/fonts/cjk.ttc` 应能看到该文件。

### 2. 周六/休市时收不到推送
正常。同花顺官方接口在非交易时段返回的快讯几乎全是 `import=0`（普通），「重要」(`import>0`) 很少。脚本 `dry-run` 会显示「本次新候选 0 条」。交易时段出现「重要」快讯时自动捕捉。

### 3. 中文渲染验证（不推送）
`docker exec ths-news node /app/fetch_ths_news.js --dry-run` —— 只打印筛选结果。

### 4. 强推一张测试卡片（mock）
`docker exec ths-news node /app/fetch_ths_news.js --force` —— 立即推送本轮候选（交易时段有候选时）。要发固定 mock 内容，用仓库内验证脚本或临时改写候选数组。

### 5. @resvg 安装失败
`start_news_cron.sh` 首启会装 `@resvg/resvg-js`，带 5 次重试。若持久卷 `ths-news-modules` 已损坏，可 `docker compose down -v` 删卷后重建，或手动 `docker exec ths-news npm install @resvg/resvg-js`。

---

## 在其他电脑 / 从 GitHub 迁移

整个仓库即一个可移植单元：

1. `git clone` 到新机器
2. `cp .env.example .env` 填 QQ 号
3. `cp ths-news/ths_news_targets.json.example ths-news/ths_news_targets.json` 填接收者
4. `bash ths-news/setup_fonts.sh` 准备字体
5. `docker compose up -d`

**无需手动装 Node 依赖、无需配 Chrome、无需配字体授权**——Node 跑在容器里，resvg 首启自动装，字体从本机系统复制。

---

## 常用提示词

见 [PROMPTS.md](./PROMPTS.md) —— 可直接复制粘贴给 AI（或本仓库的 WorkBuddy Skill）使用。
