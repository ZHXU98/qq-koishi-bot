---
name: ths-news-forwarder
description: >-
  同花顺官方 7×24「重要」财经快讯 → 经 Docker 容器（Node + @resvg/resvg-js 渲染中文图片卡片）→ 官方 QQ 机器人网关推送到 QQ 私聊/群 的自动化转发系统，覆盖部署、配置、验证与排障。触发词：同花顺快讯、重要资讯转发、QQ 推送、ths-news、金融资讯订阅、财经快讯转发。
agent_created: true
version: 1.0.0
display_name: "同花顺重要资讯转发"
display_name_en: "THS Important News Forwarder"
description_zh: "同花顺官方「重要」快讯经 Docker + resvg 渲染成中文图片卡片，经官方 QQ 机器人网关推送到 QQ。"
description_en: "Forward THS official 'important' financial news as Chinese image cards to QQ via Docker + resvg + the official QQ bot gateway."
visibility: "public"
---

# 同花顺重要资讯转发（ths-news）

## 能力概览

把同花顺官方 7×24 财经直播中标记为「重要」的快讯，自动渲染成**中文图片卡片**并推送到 **QQ 私聊 / 群**。核心特性：

- **数据源**：同花顺官方接口，每条自带 `import` 字段（`import>0` 即官方「重要」标记），比关键词加权更准，且免去 RSSHub 公共实例不稳定问题。
- **渲染**：`@resvg/resvg-js`（纯 Rust SVG→PNG，**无 Chrome / 无 puppeteer**），挂载的中文字体确保中文可见。
- **推送**：官方 QQ 机器人网关（`official-bot-gateway`，OneBot 兼容 HTTP），图片以 `base64://` 消息发送；渲染失败自动回退纯文字。
- **自动化**：`start_news_cron.sh` 每 **5 分钟**循环拉取，**[有就发、不丢弃]**——本轮新「重要」快讯立即全推（按 `MAX_PUSH=8` 拆多张图，不丢任何一条）。
- **零配置部署**：整套是 Docker Compose 项目，换电脑克隆后 `docker compose up -d` 即可，Node 依赖在容器内、字体从本机系统复制，无需配 Chrome / 环境。

## 何时使用

- 用户要「订阅同花顺重要快讯 / 财经资讯转发到 QQ」
- 用户已在用官方 QQ 机器人，想加一个资讯转发渠道
- 用户报告「推到 QQ 的卡片没字 / 格式不对 / 收不到推送」需要排障
- 用户要迁移到新机器 / 从 GitHub 克隆部署
- 用户要改推送目标、频率、过滤规则或卡片样式

## 架构与依赖

```
同花顺官方接口 → fetch_ths_news.js(过滤import>0+去重) → buildCardSvg(SVG) → @resvg(resvg-js) PNG
   → official-bot-gateway(OneBot HTTP, base64图片) → QQ 私聊/群
```

- **Docker + Docker Compose**：部署载体。`docker-compose.yml` 编排 `official-bot-gateway` + `qq-reply` + `ths-news` 三服务，同处 `botnet` 网络。
- **official-bot-gateway**：官方 QQ 机器人网关（OneBot 兼容层），提供 OneBot HTTP（`http://official-bot-gateway:3100`）。凭证走 `.env` 的 `QQBOT_APP_ID` / `QQBOT_APP_SECRET`。推送目标**已学习到映射时可直接填 QQ 号 / 群号**，否则填 openid（平台只认 openid，网关负责换算）。
- **中文字体**：`ths-news/fonts/cjk.ttc`（挂载为容器内 `/app/fonts/cjk.ttc`）。**字体不入库**（体积大+授权），用 `setup_fonts.sh` 从本机系统字体复制。
- **持久卷**：`ths-news-state`（去重状态 `ths_news_state.json`）、`ths-news-modules`（`@resvg/resvg-js` node_modules，与 `qq-reply` 只读共享）。

> **历史沿革**：2026-08-26 起推送从 NapCat（个人号）改为官方网关，2026-09-02 NapCat 通道整体停用。环境变量名 `NAPCAT_URL` 沿用未改，指向的已是网关。

## 部署流程（新机器 / 首次）

```bash
git clone https://github.com/ZHXU98/qq-koishi-bot.git && cd qq-koishi-bot
cp .env.example .env          # 填 QQBOT_APP_ID / QQBOT_APP_SECRET
docker compose up -d          # 先起网关，让机器人上线
# 先私聊机器人发 bind-owner 绑定 owner；再把机器人拉进目标群并 @ 一次，学习群映射
curl -s http://127.0.0.1:3100/bindings                      # 查看学到的 QQ号/群号 → openid 映射
cp ths-news/ths_news_targets.json.example ths-news/ths_news_targets.json  # 回填 private / groups（QQ号 或 openid）
bash ths-news/setup_fonts.sh  # 从系统字体复制 CJK 到 ths-news/fonts/cjk.ttc
docker compose up -d
docker exec ths-news node /app/fetch_ths_news.js --dry-run   # 验证拉数与过滤，不推送
```

> 改 `ths-news/fetch_ths_news.js` 是改 **bind mount 源**（容器仓库里的那份），下一轮循环自动生效，无需重启容器。改 `docker-compose.yml` 环境变量后需 `docker compose up -d`。

## 配置

- `ths_news_targets.json`：`{ private:[QQ号或openid], groups:[群号或群openid], imageWidth, imageScale }`。脚本优先读它，回退 `push_targets.json`。**平台只认 openid，但网关已学习到映射的目标可直接填 QQ 号 / 群号**；目标配置热加载，改完无需重启。
- 环境变量（compose 已设）：`NAPCAT_URL`(默认 `http://official-bot-gateway:3100`，变量名沿用历史命名)、`THS_STATE`、`THS_CONFIG`、`THS_FONT`(/app/fonts/cjk.ttc)、`NEWS_INTERVAL`(300，即 5 分钟)、`IMPORT_ONLY`(true=仅重要；false=退化为关键词加权)。

## 验证与排障

**验证（不推送）**：`docker exec ths-news node /app/fetch_ths_news.js --dry-run`
**强制推送本轮候选**：`docker exec ths-news node /app/fetch_ths_news.js --force`（交易时段有「重要」候选时）

排障要点（务必先查再下结论）：

1. **「没字了」/ 文字空白**：容器内 `/app/fonts/cjk.ttc` 缺失 → resvg 无字体。先 `docker exec ths-news ls -la /app/fonts/`。宿主侧 `bash ths-news/setup_fonts.sh` 放一份 `cjk.ttc`（bind mount 实时生效，不重启）。验证：渲染中文 PNG 体积应远大于空白骨架（如 70KB vs 1.3KB）。
2. **收不到推送（周六/休市）**：正常——非交易时段 `import=0` 多，候选 0 条。dry-run 会显示「本次新候选 0 条」。
3. **@resvg 没装上**：`start_news_cron.sh` 首启装带 5 次重试；持久卷损坏可 `docker compose down -v` 删卷重建，或 `docker exec ths-news npm install @resvg/resvg-js`。
4. **想发固定 mock 卡片**：写临时脚本 `require('/app/fetch_ths_news.js')` 的 `renderCard`/`buildCardSvg`，构造中文 mock 条目渲染并推到 QQ（见 PROMPTS.md 第 5 条）。
5. **推不出去 / 目标全无反应**：目标从未与机器人互动过、网关没有映射。`curl -s http://127.0.0.1:3100/bindings` 核对（已学习到的目标可直接填 QQ 号 / 群号，否则填 openid），并确认 `docker logs official-bot-gateway` 里机器人已连接 Gateway。

## 常用命令

```bash
docker compose up -d                              # 启动全栈
docker compose ps                                 # 看服务状态
docker exec ths-news node /app/fetch_ths_news.js --dry-run   # 验证筛选
docker exec ths-news node /app/fetch_ths_news.js --force     # 强推本轮候选
docker exec ths-news ls -la /app/fonts/cjk.ttc    # 查字体是否在位
docker logs ths-news                               # 看循环日志（start_news_cron 输出到 ths_news.log）
```

## 排障知识库（给 Agent）

- **单源真值**：改代码只改容器仓库 `ths-news/fetch_ths_news.js`（bind mount 源），不要改容器里 `docker cp` 的副本；bind mount 实时同步。
- **`FONT_PATH` 默认 `/app/fonts/cjk.ttc`**：文件名必须无空格；宿主 `Hiragino Sans GB.ttc` 带空格不可用，需复制为 `cjk.ttc`。
- **`import` 过滤**：同花顺官方「重要」等价物，比 RSSHub「重要」标签更准；`IMPORT_ONLY=false` 退化为关键词加权。
- **格式细节**（buildCardSvg）：条目间 `#f0f0f0` 分隔线、标题↔摘要间距 10px、超 3 行末行加 `…`、行尾标点（。，！？；：、）强制贴当前行末尾（防孤立标点）。
- **不提交到 Git**：字体（`.ttc/.ttf/.otf`）、真实配置 `ths_news_targets.json`、`.env`、`napcat/config/`、`official-bot-gateway/bindings.json` 均已 `.gitignore`；用 `.example` 模板 + `setup_fonts.sh`。
- **GitHub 可移植**：克隆→填 `.env`+配置→`setup_fonts.sh`→`docker compose up -d`，无需配 Node/Chrome/字体授权。

## 相关 Skill（协作链路）

本 skill 是「A股复盘推送」三件套之一，三者互相配合：

| Skill | 职责 | 在链路中的位置 |
|-------|------|----------------|
| [`a-share-daily-review`](../a-share-daily-review/SKILL.md) | 生成 A股 复盘 HTML 报告（含 ECharts） | 第 1 步：产出 HTML |
| [`a-share-report-push`](../a-share-report-push/SKILL.md) | 渲染 HTML 成图并推到 QQ | 第 2 步：把报告送达 |
| **`ths-news-forwarder`（本 skill）** | 同花顺官方「重要」快讯 → 中文图片卡片 → QQ | 并行/独立：资讯转发渠道 |

典型闭环：`a-share-daily-review` 生成报告 → `a-share-report-push` 推送到 QQ；本 skill 另起一条 **5 分钟**循环的资讯转发。三者共用同一个官方 QQ 机器人。
