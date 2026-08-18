# qq-reply —— 被@回复 + 指令服务

NapCat QQ 机器人的「被动回复」容器：监听群聊 / 私聊消息，检测**被 @** 与**指令前缀**后自动回复。与 `ths-news`（主动定时推送）互补，构成「主动推 + 被动答」的完整机器人。

## 触发规则与权限

| 场景 | 行为 |
|------|------|
| 群聊 · 任意人 @ + **闲聊** | **忽略**（只有特定指令才触发） |
| 群聊 · @ + 指令 | 响应；普通成员仅可使用受限指令集（默认 `["ping","status"]`，见 `groupRestrictedCmds`），其余回 `restrictedMsg` |
| 群聊 · 管理员（`admins`）直接发磁链（无需@） | 自动预览（普通成员无@发磁链仍忽略） |
| 私聊 · 白名单（`privateWhitelist`） | 仅响应指令 / 磁链，闲聊忽略 |
| 私聊 · 非白名单 | 回 `deniedMsg` 拒绝提示（置空则完全忽略） |

> 全部规则通过 `config.json` 调整（`groupAtOnly` / `privateAlways` / `admins` / `privateWhitelist` / `groupRestrictedCmds` / `groupImages`），**每次收到消息热加载，改完立即生效**。

## 架构

```
QQ 用户 ──@ / 指令──▶ NapCat（OneBot 网关）
                          │ 正向 WebSocket 事件上报 :3001
                          ▼
                     qq-reply 容器（node:22-alpine，零依赖）
                          │ 识别 @ / 指令
                          ▼ NapCat HTTP API :3000（send_group_msg / send_private_msg）
                     QQ 回复
```

- **零依赖**：Node ≥ 21 内置全局 `WebSocket`（事件通道）与 `fetch`（HTTP 回复），无需 `npm install`。
- **断线自愈**：WS 断开后每 5 秒自动重连。
- **配置热加载**：`config.json` 每次收到消息时重新读盘，改完立即生效、无需重启。

## 快速开始

前置：`napcat` 已启动并登录（NapCat 侧已开启正向 WebSocket `:3001` 事件上报）。

```bash
# 1. 生成配置文件（可选，默认值即可直接用）
cp reply/config.json.example reply/config.json

# 2. 启动
docker compose up -d qq-reply

# 3. 看日志确认 WS 已连接
docker compose logs -f qq-reply
```

看到 `✅ WebSocket 已连接` 即就绪；然后在群里 @机器人 或在私聊里发 `/help` 验证。

## 指令表

| 指令 | 说明 |
|------|------|
| `/help`（`/菜单`） | 显示指令菜单 |
| `/ping`（`/存活`） | 存活检测，返回运行时长与当前时间 |
| `/status`（`/状态`） | 服务状态：机器人信息 / 事件通道 / 运行时长 + **监控指标**（模拟硬件温度/频率/显存/内存，仅展示用，不读真实硬件） |
| `/echo <内容>`（`/复读`） | 复读一段文本 |
| `/preview <磁链或40位hash>`（`/预览` `/磁力预览`） | **磁力预览**：调 WhatsLink 公开 API，返回名称/大小/文件数 + 最多 4 张内容截图 |
| 直接发一条 `magnet:?xt=...` 链接 | 自动触发 `/preview`（同一权限规则） |

> 扩展新指令：编辑 `reply/index.js` 的 `routeCommand()`，追加一个 `case` 即可，重启容器生效。
> `/preview` 默认不在 `groupRestrictedCmds`，即群聊普通成员默认不可用；如需放开，把 `"preview"` 加进 `groupRestrictedCmds`。

## 配置

### 环境变量（docker-compose 已设，一般无需改）

| 变量 | 默认 | 说明 |
|------|------|------|
| `NAPCAT_WS_URL` | `ws://napcat:3001` | NapCat 正向 WebSocket 事件上报地址 |
| `NAPCAT_URL` | `http://napcat:3000` | NapCat OneBot HTTP API 地址 |
| `NAPCAT_TOKEN` | 空 | NapCat access token（若启用） |
| `BOT_UIN` | `${QQ_ACCOUNT}` | 机器人 QQ 号，用于识别「@」 |

### config.json（挂载 `/app/config.json`）

| 字段 | 默认 | 说明 |
|------|------|------|
| `groupAtOnly` | `true` | 群聊仅响应被 @ 的消息 |
| `privateAlways` | `true` | 私聊总是响应（总开关，需配合 `privateWhitelist` 使用） |
| `admins` | `[]` | 管理员 QQ 列表（群聊中可用全部指令） |
| `privateWhitelist` | `[]` | 私聊白名单（名单外账号私聊一律拒绝；空数组 = 不限制） |
| `groupRestrictedCmds` | `[]` | 群聊非管理员可用指令名白名单（如 `["ping","status"]`；空数组 = 不限制） |
| `groupImages` | `false` | 群聊预览是否带图。**腾讯对群聊批量图片有安全审核**（批量涉黄图连发会被静默拦截、sendMsg 超时），默认 `false` = 群聊只发文本预览，图片自动**私聊补发**给触发者；`true` = 群聊直接带图 |
| `restrictedMsg` | 见文件 | 群聊非管理员使用受限指令时的提示 |
| `deniedMsg` | 见文件 | 私聊非白名单账号的拒绝提示；置 `""` 则完全忽略不回复 |
| `unknownMsg` | 见文件 | 未识别指令的提示 |
| `welcome` | 见文件 | 非指令消息的引导语；置 `""` 则不回复 |

> 指令名取 `routeCommand()` 返回的 `name`（不含 `/`）：`help` / `ping` / `status` / `echo`；别名（如 `/存活`）映射到同名 `name`，权限判断按 `name` 生效。

## 排障

- **日志显示 WebSocket 一直重连**：NapCat 未开启事件上报或已重启。确认 `napcat/config/onebot11_<QQ号>.json` 的 `network.websocketServers` 含端口 3001 的项，然后 `docker compose restart napcat`。
- **@ 不识别**：确认 docker-compose 中 `BOT_UIN` 与 QQ 账号一致（`echo ${QQ_ACCOUNT}`）；`reportSelfMessage` 需为 `false`（默认已关，避免收到自己消息）。
- **私聊不响应**：检查 `privateAlways` 是否为 `false`，或你的 QQ 不在 `privateWhitelist` 内（收到 `deniedMsg` 说明被白名单拦截）。
- **群聊指令被拒**：普通成员仅可用 `groupRestrictedCmds` 内指令，属预期；如需放行，将该指令名加入 `groupRestrictedCmds`，或把账号加入 `admins`。
- **改了指令没生效**：修改后 `docker compose restart qq-reply`；改 `config.json` 则无需重启。
