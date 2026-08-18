---
name: qq-reply-service
description: NapCat QQ 机器人的「被@回复 + 指令 + 磁力预览」容器服务（qq-reply）全生命周期管理。覆盖部署（NapCat 开正向 WS 事件上报 + compose 加服务）、配置（触发规则/权限模型 config.json 热加载）、指令扩展（routeCommand）、磁力预览（WhatsLink API）、以及全部已踩坑排障（compose 挂载目录化 EISDIR、崩溃 bug 教训、NapCat sendMsg 间歇超时、腾讯群聊批量图片安全审核致静默超时）。触发场景：用户问"给机器人加指令/被@回复/qq-reply 容器/磁力预览 /preview/群里没反应/私聊限制/权限配置"等。关键用户偏好：群聊必须特定指令才触发（闲聊一律忽略）；私聊同样只响应指令/磁链；私聊白名单 1547450303；群聊普通成员仅 /ping /status。
agent_created: true
---

# qq-reply：被@回复 + 指令 + 磁力预览服务

NapCat（OneBot 11）QQ 机器人的**被动回复**容器：监听消息事件，检测 @ 与指令前缀自动回复；支持磁力链接预览（WhatsLink API）。与 `ths-news`（主动定时推送）互补。

关键路径：
- 服务源码：`/Users/zhangxu/Desktop/qq-koishi-bot/reply/index.js`（**零依赖**：Node ≥21 内置 WebSocket/fetch，无 npm install）
- 配置模板：`reply/config.json.example`；运行配置：`reply/config.json`（**gitignore，含真实 QQ 号，不入库**）
- 文档：`reply/README.md`
- compose：`docker-compose.yml` 的 `qq-reply` 服务（node:22-alpine，挂载 reply/ 三个文件，env: NAPCAT_WS_URL/NAPCAT_URL/BOT_UIN=${QQ_ACCOUNT}）
- NapCat 事件通道：`napcat/config/onebot11_<QQ号>.json` 的 `network.websocketServers`（正向 WS :3001，**gitignore 不入库，新机器部署时需手动配置**）

## 架构

```
QQ 用户 ──@ / 指令──▶ NapCat（OneBot 网关）
                          │ 正向 WebSocket 事件上报 :3001（network.websocketServers 配置）
                          ▼
                     qq-reply 容器（零依赖）
                          │ 识别 @ / 指令 / 磁链
                          ▼ NapCat HTTP API :3000（send_group_msg / send_private_msg，带 5 次×5s 重试）
                     QQ 回复（含图片：WhatsLink 预览图 / 私聊补发）
```

## 部署流程（新机器）

1. **NapCat 开正向 WS**：编辑 `napcat/config/onebot11_<QQ号>.json`，`network.websocketServers` 加：
   ```json
   { "enable": true, "name": "qq-reply", "host": "0.0.0.0", "port": 3001,
     "messagePostFormat": "array", "token": "", "debug": false, "reportSelfMessage": false }
   ```
   然后 `docker compose restart napcat`（日志出现 `WebSocket服务: 0.0.0.0:3001 已启动` 即生效）。
2. **生成配置**：`cp reply/config.json.example reply/config.json`，填 `admins`/`privateWhitelist` 为管理员 QQ。
3. **⚠️ 必须先建好 config.json 再 `docker compose up`**：compose 挂载源文件不存在时 Docker 会把挂载点建成**目录**（容器内 `/app/config.json` 变成目录、node 读它报 `EISDIR`，且后续 `cp` 会复制进目录里）。已踩坑：修复 = rm 掉误建目录 → 重建 config.json → `docker compose up -d --force-recreate qq-reply`。
4. 启动验证：`docker compose logs -f qq-reply` 看到 `✅ WebSocket 已连接` + `✅ 机器人 HTTP API 在线`。

## 触发规则与权限模型（用户确认的最终版）

| 场景 | 行为 |
|---|---|
| 群聊 · 任意人 @ + 闲聊 | **忽略**（不回复） |
| 群聊 · @ + 指令 | 响应；非管理员仅 `groupRestrictedCmds` 内指令（当前 `["ping","status"]`），其余回 restrictedMsg |
| 群聊 · 管理员（admins）直接发磁链（无@） | 自动预览（普通成员无@发磁链仍忽略） |
| 私聊 · 白名单（privateWhitelist） | 仅响应指令/磁链；闲聊忽略 |
| 私聊 · 非白名单 | 回 deniedMsg 拒绝 |

## config.json 字段（热加载：每次收到消息重新读盘，改完无需重启）

| 字段 | 默认 | 说明 |
|---|---|---|
| `groupAtOnly` | true | 群聊仅响应被 @（管理员发磁链例外） |
| `privateAlways` | true | 私聊总开关 |
| `admins` | [] | 管理员 QQ（群聊全指令 + 无@磁链自动预览） |
| `privateWhitelist` | [] | 私聊白名单；名单外拒绝 |
| `groupRestrictedCmds` | [] | 群聊非管理员可用指令名白名单 |
| `groupImages` | false | 群聊预览是否带图（见「腾讯群聊图片审核」） |
| `restrictedMsg` / `deniedMsg` / `unknownMsg` / `welcome` | 见 example | 各类提示文案 |

## 指令集与扩展

| 指令 | 别名 | 说明 |
|---|---|---|
| `/help` | `/菜单` | 指令菜单 |
| `/ping` | `/存活` | 存活检测 |
| `/status` | `/状态` | 服务状态 + 监控指标（模拟数据，随机范围：CPU 72~79℃/4.2~4.5GHz、GPU 65~75℃/显存28~31G、内存45~55℃） |
| `/echo <内容>` | `/复读` | 复读 |
| `/preview <磁链|hash>` | `/预览` `/磁力预览` `/seed` | 磁力预览；消息文本含 magnet 链接自动触发 |

**扩展新指令**：编辑 `reply/index.js` 的 `routeCommand()` 加 case（返回 `{name, type:'text'|'status'|'preview', text}`），权限按 `name` 判断；改代码后 `docker compose restart qq-reply`。

## 磁力预览（/preview）

- API：`GET https://whatslink.info/api/v1/link?url=<magnet>`（免费匿名）。
- **坑：参数名是 `url` 不是 `link`**（用 link 恒返回 UNKNOWN）；magnet 需 `encodeURIComponent`（`?` 会破坏 query）。
- 响应：`{type, file_type, name, size, count, screenshots:[{time, screenshot:URL}]}`；未收录时 `name` 空/`type=UNKNOWN`；截图仅视频类资源有，URL 直接可用作图片消息。
- 发送：单条消息图片上限 4 张（`sendReply` slice(0,4)），提示文案会如实说明。
- 测试磁链（已收录）：`magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10`（Sintel）。

## 腾讯群聊图片安全审核（重要踩坑）

- 现象：群里发「文本+多张涉黄预览图」→ NapCat `sendMsg` 必超时（复测多次均失败）；同内容私聊成功、单张图群发成功、电影图 4 连发成功。
- 结论：**腾讯对群聊批量图片有安全审核**，批量涉黄图连发被静默拦截（挂起到 Timeout），私聊不受限。这是平台策略，不是 NapCat 故障。
- 对策：`groupImages: false`（默认）→ 群聊只发文本预览，图片**自动私聊补发**给管理员；私聊照常带图。

## 排障速查

- **群聊/私聊"没反应"**：按序查 ①触发（napcat 日志 `接收 <-` 看消息是否到、是否 @）②权限（受限/白名单）③发送（qq-reply 日志有无 `send_group_msg 失败`）④内容差异对照（curl 原样复刻消息，成功=触发/权限问题，失败=内容被平台拦截）。**NapCat sendMsg Timeout 排查 = 触发→权限→通道(curl 直测)→消息内容对照**。
- **sendMsg 间歇超时**：风控(168)下 NapCat 内核发消息 10-20s 超时窗口，时好时坏；`get_status` online 不代表能发（假在线）。应对：发送重试 5 次×5s（已内置）+ 必要时 `docker compose restart napcat`。根治靠官方手机 QQ 登录清 serverErrorCode 168 风控。
- **进程崩溃循环（曾踩坑）**：给运行中服务加"失败路径"代码后**必须显式测试失败分支**。曾因 `let ok` 声明在 for 循环内、循环外引用 → ReferenceError 崩溃→容器反复重启；cmdPreview 曾漏返回 `images` 字段 → `r.images.length` 崩溃。已修复并统一返回 `{text, images:[]}` + 调用方 `(r.images||[])` 兜底。
- **@ 不识别**：确认 compose 的 `BOT_UIN` = `${QQ_ACCOUNT}`；`reportSelfMessage` 需 false。
- **预览提示"无预览索引"**：该磁链 whatsLink 未收录（截图仅热门资源有），换资源或换 Sintel 测试磁链。

## 测试方法（改代码后必跑）

`reply/index.js` 底部 `module.exports` 暴露内部函数；用 mock fetch 跑场景用例（node -e 或临时脚本）：

```bash
# 语法
node --check reply/index.js
# 权限/触发用例：mock global.fetch 拦截 send_*，断言回复内容/是否忽略
# 已覆盖用例：私聊白名单拒绝、群聊受限/放行、管理员全权、无@忽略、磁链自动预览、5图/3图/未收录/非磁链、闲聊忽略
```
