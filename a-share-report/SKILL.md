---
name: a-share-report-push
description: >-
  A股 复盘 HTML 报告 → 渲染成 PNG 长图 → 经官方 QQ 机器人网关（OneBot 兼容 HTTP）推送到 QQ 私聊/群 的自动化推送 skill，覆盖渲染、健康检查、多目标推送、验证与排障。与 a-share-daily-review（生成报告）、ths-news-forwarder（资讯转发）组成「A股复盘推送」三件套。触发词：复盘推送、报告推QQ、推送到QQ、渲染复盘图、A股报告推送、push_report。
agent_created: true
version: 1.0.0
display_name: "A股复盘推送"
display_name_en: "A-Share Report Pusher"
description_zh: "把 A股 复盘 HTML 渲染成图片，经官方 QQ 机器人网关推送到 QQ 私聊/群。"
description_en: "Render A-share review HTML to image and push to QQ via the official QQ bot gateway."
visibility: "public"
---

# A股 复盘报告推送（a-share-report-push）

## 能力概览

把 WorkBuddy 自动化 / `a-share-daily-review` skill 生成的 **A股 复盘 HTML 报告**，渲染成适合手机端阅读的长图，并推送到 **QQ 私聊 / 群**。核心特性：

- **渲染**：`puppeteer-core` + 本机 Chrome，把 HTML（含 ECharts 图表）截成全页 PNG。与 `ths-news-forwarder` 的纯 resvg 路线不同——这里需要真实浏览器渲染图表。
- **推送**：官方 QQ 机器人网关（`official-bot-gateway`，OneBot 兼容 HTTP），图片以 `base64://` 消息发送（支持 array 段格式与旧式 CQ 码）。
- **健壮性**：推送前先做网关登录健康检查，机器人未就绪立即告警退出，不浪费一次渲染；代理环境变量自动清除，确保直连本机网关（`127.0.0.1:3100`）。
- **多目标**：私聊 + 群可同时推，多个目标逗号分隔。

## 何时使用

- 用户要让「A股 复盘报告」推送到 QQ（私聊或群）
- `a-share-daily-review` 生成 HTML 后，接本 skill 完成推送闭环
- 用户报告「推送失败 / 收到空白图 / 推不出去 / 网关连不上」
- 用户要迁移到其他电脑 / 从 GitHub 克隆部署

## 架构与依赖

```
A股复盘 HTML → push_report.js(puppeteer-core 渲染 PNG) → official-bot-gateway(OneBot HTTP, base64图片) → QQ 私聊/群
                         ↑ render_report.js 仅渲染不推送（预览用）
```

- **Node.js ≥ 18**：脚本运行环境（跑在**宿主机**，非 Docker 容器）。
- **Chrome / Chromium**：渲染引擎。`CHROME_PATH` 覆盖默认路径（换平台必设）。
- **puppeteer-core**：放在可被 `NODE_PATH` 找到的 `node_modules` 下（脚本不自带依赖）。
- **official-bot-gateway**：官方 QQ 机器人网关（OneBot 兼容层），提供 OneBot HTTP（`http://127.0.0.1:3100`）。需先于推送运行、日志里看到「已连接 Gateway」。

> **历史沿革**：2026-08-26 起推送从 NapCat（个人号）改为官方网关，2026-09-02 NapCat 通道整体停用。环境变量名 `NAPCAT_URL` 沿用未改，指向的已是网关（默认已改为 `3100`）。

## 推送目标怎么填（重要）

官方开放平台只认 **openid**，不认识 QQ 号。本网关做了一层映射：

```
groupOpenidByQq(群号) || 群号     // 已学习到的 QQ 群号可直接用
openidByQq(QQ号)    || QQ号      // 已学习到的 QQ 号可直接用
```

所以规则是：

- **已与机器人互动过的目标**（owner 私聊过 / 群被 @ 过）→ 直接填 **QQ 号 / 群号** 即可，和以前一样。
- **从未互动过的目标** → 网关没有映射，必须先制造一次互动让网关学习（或直接填 openid）。
- 学习结果查看：`curl -s http://127.0.0.1:3100/bindings`。owner 首次需私聊机器人发 `bind-owner` 绑定。
- **群必须补一个前提**：机器人得先被拉进群。

## 文件

```
a-share-report/
├── push_report.js              # 主脚本：健康检查 → 渲染 → 推送 QQ
├── render_report.js            # 仅渲染不推送（手动预览用）
├── push_targets.json.example   # 推送目标模板
└── push_targets.json           # 真实目标（勿提交 Git，.gitignore 已忽略）
```

> 代码源头在 GitHub 仓库 `ZHXU98/qq-koishi-bot` 的 `a-share-report/` 目录；本 skill 已内嵌同款脚本，可直接使用，无需先克隆仓库。

## 前置（宿主机）

```bash
# 1. Node.js ≥ 18（确认）
node -v

# 2. 安装 puppeteer-core 到某个 node_modules（记下路径 <ws>）
npm install puppeteer-core --prefix /path/to/ws
# 或全局安装后用 `npm root -g` 拿到 <ws>

# 3. 准备一款 Chrome：
#    macOS 默认 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
#    Linux 例如 /usr/bin/google-chrome
#    Windows 例如 C:\Program Files\Google\Chrome\Application\chrome.exe
#    用 CHROME_PATH 环境变量覆盖默认。

# 4. 准备推送目标（从模板复制后填写）
cp a-share-report/push_targets.json.example a-share-report/push_targets.json
# 编辑 push_targets.json：填 private（QQ 号）/ groups（群号），前提是网关已学习到映射

# 5. 确认网关在跑
curl -s http://127.0.0.1:3100/bindings    # 应能看到 owner / groups
```

## 用法

```bash
# 自动推送（报告路径传入；目标/尺寸读 push_targets.json）
NODE_PATH=<ws>/node_modules node a-share-report/push_report.js /path/to/A股-YYYY-MM-DD-复盘.html

# 不传路径时，按当天日期在 REPORT_DIR 下自动查找 A股-YYYY-MM-DD-复盘.html
NODE_PATH=<ws>/node_modules node a-share-report/push_report.js

# 仅渲染成 PNG 预览（不推送），用于手动检查
NODE_PATH=<ws>/node_modules node a-share-report/render_report.js /path/to/report.html /tmp/preview.png
```

### 环境变量（均可覆盖默认值）

| 变量 | 默认 | 说明 |
|------|------|------|
| `CHROME_PATH` | macOS Chrome 路径 | Chrome 可执行文件，**换平台/电脑时必设** |
| `NODE_PATH` | 运行命令时前缀传入 | 指向含 `puppeteer-core` 的 `node_modules` |
| `REPORT_DIR` | 原作者机器路径（**其他端务必覆盖**） | 不传报告路径时按当天日期自动查找的目录 |
| `PUSH_TARGETS` | 脚本同目录 `push_targets.json` | 推送目标配置文件路径 |
| `NAPCAT_URL` | `http://127.0.0.1:3100` | 官方网关地址（宿主直连；变量名沿用历史命名） |
| `NAPCAT_TOKEN` | 空 | access token（若配置了） |
| `QQ_PRIVATE_IDS` / `QQ_GROUP_IDS` | 读配置文件 | 临时覆盖推送目标（逗号分隔多个） |
| `REPORT_CAPTION` | 读配置文件 | 图片前的文字说明 |
| `IMAGE_WIDTH` / `IMAGE_SCALE` | 600 / 2 | 输出图片宽度(CSS px)与倍率（像素=宽×倍率） |
| `REPORT_PNG` | `/tmp/a_share_report.png` | 渲染输出 PNG 路径（覆盖时用） |
| `MESSAGE_FORMAT` | `array` | `array`(结构化推荐) 或 `string`(旧式CQ码) |

> **跨端关键点**：`REPORT_DIR` 默认指向原作者机器路径，**其他端必须**用 `REPORT_DIR` 环境变量或直接在命令里传报告绝对路径覆盖。脚本其余逻辑均平台无关。

## 推送目标配置（push_targets.json）

```json
{
  "private": ["1547450303"],
  "groups": ["609994072"],
  "caption": "AI每日A股自动化复盘",
  "imageWidth": 600,
  "imageScale": 2
}
```

- `private` / `groups`：QQ 号 / 群号数组（网关已学习到映射时可直接填号码；未学习过则填 openid）；环境变量 `QQ_PRIVATE_IDS` / `QQ_GROUP_IDS` 可临时覆盖。
- `caption`：图片前的文字说明；`REPORT_CAPTION` 可临时覆盖。
- `imageWidth` / `imageScale`：图片尺寸，按手机阅读优化（越大越清晰但体积也大）。

## 验证与排障

**验证推送链路（不依赖交易时段）**：可直接用 `render_report.js` 渲染任意已生成的 HTML 检查图片是否正常，再用 `push_report.js` 推一张到自己的 QQ 私聊确认收到。

排障要点：

1. **`❌ 无法连接官方网关` / `登录态异常`**：网关未启动或机器人未就绪。先 `curl -s -X POST http://127.0.0.1:3100/get_login_info` 看返回；`docker compose ps` 确认 `official-bot-gateway` 在跑，`docker logs official-bot-gateway` 看到「已连接 Gateway」。脚本会先于渲染做健康检查，避免白渲染。
2. **收到空白/纯白图**：HTML 里 ECharts 未渲染完——脚本已 `waitUntil: networkidle0` + 2s 等待；若仍空白，检查 HTML 内联 JS 是否 `node --check` 通过、是否有跨域/CDN 被拦截。
3. **`Could not find Chrome` / 启动报错**：`CHROME_PATH` 没设对或 Chrome 没装。用 `CHROME_PATH=/usr/bin/google-chrome` 之类覆盖。
4. **`Cannot find module 'puppeteer-core'`**：`NODE_PATH` 没指向含 puppeteer-core 的 node_modules。用 `npm root -g` 拿到全局路径，或 `--prefix` 安装的本地路径。
5. **图片太大发不出去 / 官方限流**：调小 `IMAGE_SCALE`（如 2→1.5）或 `IMAGE_WIDTH`；超长报告可分段。官方通道主动推送配额为单用户/单群 1000 条/天、20 条/分钟。
6. **代理导致连不上本机网关**：脚本已自动清除 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY` 并设 `NO_PROXY=*`，确保直连 127.0.0.1。

## 跨端部署（新机器 / 从 GitHub 克隆）

```bash
git clone https://github.com/ZHXU98/qq-koishi-bot.git && cd qq-koishi-bot
# 本 skill 已内嵌同款脚本，也可直接从此仓库 a-share-report/ 取
cp .env.example .env      # 填 QQBOT_APP_ID / QQBOT_APP_SECRET，docker compose up -d 起网关
curl -s http://127.0.0.1:3100/bindings    # 确认 owner / groups 已学习
cp a-share-report/push_targets.json.example a-share-report/push_targets.json
# 编辑填 QQ / 群号（需网关已学习到映射）
# 设置运行环境：
export CHROME_PATH=<你的Chrome路径>
export NODE_PATH=<含puppeteer-core的node_modules>
# 推送（报告绝对路径必须传，或设 REPORT_DIR）
NODE_PATH=$NODE_PATH node a-share-report/push_report.js /abs/path/A股-YYYY-MM-DD-复盘.html
```

> 推送脚本不依赖 Docker，纯宿主机 Node + Chrome 即可；但**网关是 Docker 服务**，需在宿主机可达（默认 `127.0.0.1:3100`）。配置 `push_targets.json` 含真实 QQ 号/openid，属敏感信息，已被 `.gitignore` 忽略，勿提交。

## 相关 Skill（协作链路）

本 skill 是「A股复盘推送」三件套之一，三者互相配合：

| Skill | 职责 | 在链路中的位置 |
|-------|------|----------------|
| [`a-share-daily-review`](../a-share-daily-review/SKILL.md) | 生成 A股 复盘 HTML 报告（含 ECharts） | 第 1 步：产出 HTML |
| **`a-share-report-push`（本 skill）** | 渲染 HTML 成图并推到 QQ | 第 2 步：把报告送达 |
| [`ths-news-forwarder`](../ths-news-forwarder/SKILL.md) | 同花顺官方「重要」快讯 → 中文图片卡片 → QQ | 并行/独立：资讯转发渠道 |

典型闭环：`a-share-daily-review` 生成报告 → `a-share-report-push` 推送到 QQ；`ths-news-forwarder` 另起一条 **5 分钟**循环的资讯转发。三者共用同一个官方 QQ 机器人。

## 数据红线

- 推送目标（QQ 号 / openid）属敏感信息，存 `push_targets.json`（已 gitignore），勿入库、勿在报告或日志里明文暴露。
- 报告内容遵循 `a-share-daily-review` 的红线圈（不编造数据、不暴露数据源细节）。
- 以上推送行为仅做信息同步，不构成投资建议。
