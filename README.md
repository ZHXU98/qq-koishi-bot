# QQ 机器人（NapCat + 同花顺资讯转发 + A股复盘推送）

基于 **NapCat**（OneBot 协议 QQ 机器人网关）的 Docker Compose 项目，包含两条自动化推送链路：

1. **同花顺重要资讯转发（`ths-news`，容器运行）**：每 10 分钟拉取同花顺官方「重要」快讯，渲染成中文图片卡片推到 QQ 私聊 / 群。
2. **A股 每日复盘推送（`a-share-report`，宿主机运行）**：把 WorkBuddy 生成的 A股 复盘 HTML 渲染成图，推到 QQ 私聊 / 群。

> 本项目**已不再使用 Koishi**，原 Koishi / RSSHub 相关配置与文档均已废弃移除。

---

## 目录结构

```
qq-koishi-bot/
├── docker-compose.yml          # 容器编排（napcat + ths-news）
├── .env.example                # QQ 账号模板（复制为 .env 填 QQ_ACCOUNT）
├── .gitignore
├── napcat/                     # NapCat 运行数据（登录态/配置，已 gitignore）
├── ths-news/                   # ★ 同花顺重要资讯转发服务（全部源码+文档+Skill）
│   ├── fetch_ths_news.js         # 主脚本（过滤/去重/渲染/推送）
│   ├── start_news_cron.sh        # 容器内 10 分钟循环 + 首启装 resvg
│   ├── ths_news_targets.json.example  # 推送目标模板
│   ├── setup_fonts.sh           # 从本机复制中文字体（避免提交 22MB）
│   ├── fonts/                   # 中文字体目录（.ttc 不入库）
│   ├── README.md / PROMPTS.md / SKILL.md
└── a-share-report/             # ★ A股 复盘推送（宿主机脚本，非容器）
    ├── push_report.js            # 主脚本：登录健康检查 → 渲染 → 推送 QQ
    ├── render_report.js          # 仅渲染不推送（手动预览）
    ├── push_targets.json.example # 推送目标模板
    └── SKILL.md
├── monitor/                    # ★ NapCat 掉线监控（宿主机脚本，非容器）
    ├── check_napcat.sh           # 掉线自动重启自愈；需扫码时导出二维码
    └── README.md                # WorkBuddy 自动化配置（微信推送/远程扫码交付）
```

---

## 快速开始

### 第一步：配置 QQ 账号

```bash
cp .env.example .env
# 编辑 .env：QQ_ACCOUNT=你的QQ号
```

### 第二步：ths-news 推送目标

```bash
cp ths-news/ths_news_targets.json.example ths-news/ths_news_targets.json
# 编辑 ths_news_targets.json：填 private（你的QQ）/ groups（群号）
```

### 第三步：准备中文字体（关键！否则推到 QQ 的图片「没字」）

```bash
bash ths-news/setup_fonts.sh
# 自动从本机系统字体复制一款 CJK 到 ths-news/fonts/cjk.ttc
# macOS / Linux 常见字体均已内置候选；找不到时按提示手动放置
```

### 第四步：启动全栈

```bash
docker compose up -d
```

### 第五步：QQ 登录（首次）

访问 NapCat Web 管理页扫码登录 QQ：

```
http://localhost:6099
```

> 登录态保存在 `napcat/QQ/` 目录，重启容器后**无需重复扫码**（除非 QQ 服务端主动让票据失效）。

### 第六步：验证

```bash
docker compose ps
docker exec ths-news node /app/fetch_ths_news.js --dry-run   # 看筛选结果，不推送
```

---

## 同花顺重要资讯转发（ths-news）

### 架构

```
同花顺官方接口 (import>0 即「重要」)
        │  每 10 分钟（start_news_cron.sh 循环）
        ▼
fetch_ths_news.js  ── 过滤(import>0) + 去重(seen) + 组装条目
        │
        ▼  buildCardSvg() → 中文 SVG 卡片
   @resvg/resvg-js  →  PNG（挂载的中文字体 cjk.ttc）
        │
        ▼  NapCat OneBot HTTP API (base64 图片消息)
   QQ 私聊 / 群 (ths_news_targets.json 配置)
```

- **数据源**：同花顺官方 7×24 接口，每条自带 `import` 字段（`import>0` 即官方「重要」标记），比关键词加权更准。
- **渲染**：纯 Rust 的 `@resvg/resvg-js` 把 SVG 渲染成 PNG（**无 Chrome / 无 puppeteer 依赖**）。
- **推送**：经 NapCat（OneBot 协议）推到 QQ，图片以 `base64://` 消息发送。
- **自动化**：`start_news_cron.sh` 每 10 分钟拉取，「**有就发、不丢弃**」——本轮新「重要」快讯立即全推。

### 配置

`ths_news_targets.json`：

```json
{
  "private": ["替换为你的QQ号"],
  "groups":  [],
  "imageWidth": 600,
  "imageScale": 2
}
```

环境变量（docker-compose 已设，一般无需改）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `NAPCAT_URL` | `http://napcat:3000` | NapCat OneBot 地址 |
| `NAPCAT_TOKEN` | 空 | NapCat access token（若启用） |
| `NEWS_INTERVAL` | `600` | 拉取间隔（秒） |
| `IMPORT_ONLY` | `true` | `true`=仅同花顺「重要」；`false`=退化为关键词加权筛选 |

### 排障

- **图片「没字了」**：容器内 `/app/fonts/cjk.ttc` 缺失 → resvg 加载不到字体。`docker exec ths-news ls -la /app/fonts/cjk.ttc` 确认；宿主侧 `bash ths-news/setup_fonts.sh` 放一份 `cjk.ttc`（bind mount 实时生效，无需重启）。
- **周六/休市收不到推送**：正常——非交易时段 `import=0` 多，候选 0 条。`--dry-run` 会显示「本次新候选 0 条」。
- **@resvg 没装上**：`start_news_cron.sh` 首启装带 5 次重试；持久卷损坏可 `docker compose down -v` 重建，或 `docker exec ths-news npm install @resvg/resvg-js`。

> 更完整文档见 [`ths-news/README.md`](./ths-news/README.md) 与 [`ths-news/PROMPTS.md`](./ths-news/PROMPTS.md)。

---

## A股 每日复盘推送（a-share-report，宿主机脚本）

把 WorkBuddy 自动化 / `a-share-daily-review` skill 生成的 **A股 复盘 HTML 报告**，渲染成适合手机阅读的长图并推送到 QQ。**这套脚本跑在宿主机（非 Docker 容器）**，依赖本机 Chrome + `puppeteer-core`（与 ths-news 的纯 resvg 路线不同，因为需要真实浏览器渲染 ECharts 图表）。

### 前置（宿主机）

- Node.js（建议 ≥ 18）
- 一款 Chrome / Chromium（macOS 默认 `/Applications/Google Chrome.app/...`，其它平台用 `CHROME_PATH` 覆盖）
- `puppeteer-core`（放在可被 `NODE_PATH` 找到的 `node_modules` 下）
- NapCat 已启动并登录（同上第五步）

```bash
# 准备推送目标
cp a-share-report/push_targets.json.example a-share-report/push_targets.json
# 编辑填 private（你的QQ）/ groups（群号）
```

### 用法

```bash
# 自动推送（报告路径传入；目标/尺寸读 push_targets.json）
NODE_PATH=<ws>/node_modules node a-share-report/push_report.js /path/to/A股-YYYY-MM-DD-复盘.html

# 不传路径时，按当天日期在 REPORT_DIR 下自动查找
NODE_PATH=<ws>/node_modules node a-share-report/push_report.js

# 仅渲染成 PNG 预览（不推送）
NODE_PATH=<ws>/node_modules node a-share-report/render_report.js /path/to/report.html /tmp/preview.png
```

### 环境变量（均可覆盖默认值）

| 变量 | 默认 | 说明 |
|------|------|------|
| `CHROME_PATH` | macOS Chrome 路径 | Chrome 可执行文件，换平台/电脑时必设 |
| `NODE_PATH` | 运行命令时前缀传入 | 指向含 `puppeteer-core` 的 `node_modules` |
| `REPORT_DIR` | 原作者机器路径（**其他端务必覆盖**） | 不传报告路径时按当天日期自动查找的目录 |
| `PUSH_TARGETS` | 脚本同目录 `push_targets.json` | 推送目标配置文件路径 |
| `NAPCAT_URL` | `http://127.0.0.1:3000` | NapCat OneBot 地址（宿主直连） |
| `NAPCAT_TOKEN` | 空 | NapCat access token |
| `QQ_PRIVATE_IDS` / `QQ_GROUP_IDS` | 读配置文件 | 临时覆盖推送目标（逗号分隔多个） |
| `REPORT_CAPTION` | 读配置文件 | 图片前的文字说明 |
| `IMAGE_WIDTH` / `IMAGE_SCALE` | 600 / 2 | 输出图片宽度(CSS px)与倍率 |
| `REPORT_PNG` | `/tmp/a_share_report.png` | 渲染输出 PNG 路径 |

> 迁移到其他电脑：克隆仓库后 `cp a-share-report/push_targets.json.example a-share-report/push_targets.json` 填入你的 QQ，并设置 `CHROME_PATH` 与 `NODE_PATH` 即可。脚本不依赖 Docker。
> 完整文档见 [`a-share-report/SKILL.md`](./a-share-report/SKILL.md)。

---

## 常用运维命令

```bash
# 查看服务状态
docker compose ps

# 实时日志
docker compose logs -f ths-news
docker compose logs -f napcat

# 重启单个服务
docker compose restart ths-news

# 停止 / 删除全部
docker compose down

# 更新基础镜像（升级 NapCat 版本）
docker compose build --no-cache napcat
docker compose up -d
```

---

## 注意事项

1. **QQ 封号风险**：建议使用小号，不要用主号。
2. **登录态保密**：`napcat/QQ/` 目录包含 QQ session，不要上传到公开 Git 仓库。
3. **字体授权**：中文字体体积大且涉及授权，已 `.gitignore`，用 `setup_fonts.sh` 从本机系统复制，不入库。
4. **配置保密**：`ths_news_targets.json` / `a-share-report/push_targets.json` 含真实 QQ 号，均 `.gitignore`，勿提交。
5. **控制台安全**：NapCat Web 管理页已开启登录验证，请设置强密码；如部署在公网需配置防火墙。

---

## NapCat 掉线监控（monitor，宿主机脚本）

`monitor/check_napcat.sh` 每小时守护 NapCat 在线状态（`online && good` 双真判断，能识别"假在线"）：

- **掉线自动自愈**：`docker compose restart napcat` 重启，恢复后发 QQ 提醒主号；
- **需扫码时**：30 分钟冷却内提醒一次，导出最新二维码到 `monitor/latest_qr.png`；
- **远程知悉**：由 WorkBuddy 自动化（每小时）触发，开启微信推送，掉线/扫码告警直达用户微信；需扫码时自动生成 `napcat_qr.html` 预览页，远程直接扫码。

> 掉线场景下 QQ 通道与桌面通知都不可达（bot 掉线发不出、远程看不到本机屏幕），故告警必须走微信推送这条与机器无关的通道。完整配置（rrule / push_to_wechat / prompt / 远程扫码交付流程）见 `monitor/README.md`。

---

## 相关 Skill（WorkBuddy 可复用）

本项目对应的三件套 skill，组成「A股复盘推送」自动化包：

| Skill | 职责 |
|-------|------|
| `a-share-daily-review` | 生成 A股 复盘 HTML 报告（含 ECharts） |
| `a-share-report-push` | 把报告渲染成图并推到 QQ |
| `ths-news-forwarder` | 同花顺官方「重要」快讯 → 中文图片卡片 → QQ |

三者配合使用：生成报告 → 推送到 QQ；ths-news 另起一条 10 分钟循环的资讯转发。共用同一个 NapCat 机器人。
