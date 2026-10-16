# official-bot-gateway — 官方 QQ 机器人网关（OneBot 兼容层）

官方 QQ 开放平台（AppID + AppSecret）的 OneBot 兼容适配器。当前 Compose 默认使用该适配器；NapCat 非官方通道仍作为备用保留、默认未启动。
对外暴露与 NapCat 兼容的 HTTP + WebSocket 接口，现有业务服务可通过 OneBot 地址选择通道。

## 快速开始

1. **填凭证**：编辑仓库根目录 `.env`，填入 QQ 开放平台（q.qq.com → 机器人 → 开发配置）的 AppID / AppSecret：
   ```
   QQBOT_APP_ID=你的AppID
   QQBOT_APP_SECRET=你的AppSecret
   ```

2. **启动**：
   ```bash
   docker compose up -d official-bot-gateway
   docker logs -f official-bot-gateway   # 看到 "✅ 官方机器人已连接 Gateway" 即成功
   ```

3. **绑定管理员（必做，用于按 QQ 号发私聊）**：用你的 QQ（1547450303）**私聊机器人**发一条：
   ```
   bind-owner
   ```
   机器人回「✅ 已绑定为管理员」后，`GET http://127.0.0.1:3100/bindings` 可看到 owner 的 openid。

4. **让机器人进群**：把机器人拉进目标群（609994072、528165429），群里随便 @ 一次，
   `GET /bindings` 会看到群 openid 被自动学习（`groups` 字段）。

## 依赖安装（首次部署必看）

`docker-compose.yml` 里本服务的启动命令是 **`node /app/index.js`**，**不再每次启动都跑 `npm install`**
（旧写法每次拉起都联网装依赖，DNS/网络抖动时会卡在装依赖这一步，把"掉线恢复"拖成几小时）。
依赖已持久化在 `./official-bot-gateway/node_modules`（bind mount 会保留），日常重启无需联网。

**首次部署、或改过 `package.json` 之后，必须手动装一次依赖**，否则容器会因 `Cannot find module` 起不来：

```bash
docker run --rm -v "$PWD/official-bot-gateway:/app" -w /app node:22-alpine \
  npm install --no-audit --no-fund --registry=https://registry.npmmirror.com
```

（也可以临时把 compose 的 `command` 换回 `sh -c "npm install … && exec node /app/index.js"` 先起一次。）

## DNS 与掉线恢复（2026-09-20 加固）

三个容器都配了固定 DNS（compose 的 `dns:` 段）：

| 顺序 | 地址 | 作用 |
|---|---|---|
| 1 | `223.5.5.5` | 固定首选（阿里公共 DNS） |
| 2 | `119.29.29.29` | 固定备选（腾讯 DNSPod） |
| 3 | `192.168.65.7` | **兜底**：Docker Desktop 内置解析器 —— 前两个都不可达时自动回落宿主解析（实测约 4s 后回落成功） |

- 容器名（`official-bot-gateway` / `ths-news`）由 Docker **内嵌 DNS** 解析，**不受**该列表影响。
- ⚠️ 固定 DNS 不可达时**不会**原生回落到宿主解析器（实测：5s 超时 → `EAI_AGAIN`），
  所以兜底项必须**显式**写进列表。
- `192.168.65.7` 是 Docker Desktop(macOS) 的内网解析器地址；Linux 宿主上该地址不同，
  若宿主本就能稳定解析，删掉这一项即可。

**启动失败自动重试**：`index.js` 中 `bot.start()` 失败不再 `process.exit(1)`，改为指数退避重试
（2→4→8→16→32→60s 封顶；连续 100 次仍失败才 `exit(1)` 交回容器重启）。
「取 access_token 时 DNS 不通」是最常见成因（实测 `getaddrinfo ENOTFOUND bots.qq.com`），
现在 DNS 一恢复即可自愈，无需人工干预或等容器重启。

> 背景：2026-09-14 曾因容器 DNS 失效（当天 `ENOTFOUND` 1018 次）+ 启动失败即 `exit(1)` + 每次启动都跑 npm install，
> 导致网关照 **8 小时**不恢复（17:07 断，次日 01:08 才恢复）。

## WS 连接保活（2026-10-08 加固）

**问题**：宿主休眠 / 切网 / Docker Desktop 暂停后，网关与下游（`qq-reply`）之间的 TCP 经常「半开」——
本地 `readyState` 仍是 `OPEN`，事件被静默写进黑洞，下游既收不到消息、也等不到 `onclose`，
于是**永久不重连**。表面现象极具迷惑性：**主动推送（`ths-news` 走 HTTP）一切正常，唯独指令不回复**。

**两道保险**（均以 `GW_HEARTBEAT_MS` 为周期，默认 30s）：

| 机制 | 作用 |
|---|---|
| 标准 ws `ping`/`pong` | 无 `pong` 的连接直接 `terminate()`，迫使下游收到 `onclose` 并重连 |
| 周期性下发 `meta_event` 心跳 | 给下游一个「网关仍在工作」的活性信号（`meta_event` 不参与业务路由） |
| `broadcast()` 写失败即 `terminate()` | 写失败说明对端已死，立即断开而不留死连接 |

下游 `qq-reply` 据此把「超 `WS_STALE_MS`（默认 90s）收不到任何推送」判定为僵尸连接并主动重连。
两边配合才能真正自愈（只靠单边都会漏）。

**日志**：入站消息到达时记一条 `[event] HH:MM:SS 群|私聊消息 → 转发 qq-reply`（不含正文）。
排障时用 `docker compose logs --timestamps official-bot-gateway` 比对时间：
若某段时间空白、随后突然补上，说明期间宿主休眠/断网（恢复后平台会补推旧事件，表现为「很久才回」）。

### 上游 QQ 网关侧加固（2026-10-08，同一根因的另一半）

**上面那套只保住了下游**。`gateway ↔ QQ 官方网关`（`wss://api.sgroup.qq.com/websocket`）这条**上游** WS
由 SDK 内部创建，同样会「半开/失聪」，而 SDK 有**两个缺口**：

1. `ws` 库不调 `setKeepAlive` → 套接字没有 TCP keepalive（容器 `tcp_keepalive_time` 默认 7200s）；
2. `gateway-connection.js` 里 `case GatewayOp.HEARTBEAT_ACK: break;` → 心跳 ACK 被吞，**没有任何活性看门狗**。

后果：连接「看着在线、其实收不到推送」，客户端要等 QQ 侧 **~1h 会话超时**（`1006` / `4009`）才重连；
这期间用户发的指令**没有任何日志**，重连时平台把积压事件**成批补投** → 表现为「延迟近一小时才回一堆」。
（`1006` 走 reconnect 默认分支 `clearSession:false`，只会 `RESUME`，不做新 `IDENTIFY`。）

**做法**：在 `https.request` 层挂钩（`ws` 用 `https.request` 建连，且是运行时取属性，patch 对其可见），
**仅对 WS Upgrade 请求**生效，不影响 QQ REST 短连接：

| 机制 | 说明 |
|---|---|
| `socket.setKeepAlive(true, GW_QQ_KEEPALIVE_MS)` | 默认 30s 起探，让内核兜住真正死掉的 TCP |
| 轮询 `socket.bytesRead` | 超过 `GW_QQ_STALL_MS`（默认 **240s**）无任何入站字节 → `socket.destroy()`，逼 SDK 收到 `onclose` 重连（`RESUME` 会补投积压消息） |

**阈值依据**：QQ 的 HELLO 里 `heartbeat_interval = 41250ms` → SDK 每 41.25s 发一次心跳、QQ 回 ACK，
**健康连接至少每 ~41s 有入站字节**；240s ≈ 漏掉 5.8 个 ACK 周期，因此不会误判。
可调：`GW_QQ_KEEPALIVE_MS` / `GW_QQ_STALL_MS`。

**日志**：加固成功会打 `[ws-guard] HH:MM:SS QQ WS 套接字已加固（TCP keepalive 起探 30s / 失联阈值 240s）`；
看门狗触发打 `[ws-guard] … 已 Ns 无入站字节（疑似半开/失联）→ 主动断开重连`。

**用 `[event]`/`[msg]` 定位是哪条链路丢了**（两端都改完才有这个能力）：

| 现象 | 结论 |
|---|---|
| 只有 `[event]`、没有 `[msg]` | **内部**（gateway↔qq-reply）链路丢 |
| `[event]` 时间明显晚于用户发送时间 | **上游**（gateway↔QQ）延迟 |
| 有 `[msg]`、没有 `[send]` | 路由/处理问题 |

## 接口（与 NapCat OneBot 兼容）

| 端点 | 说明 |
|---|---|
| `POST /send_private_msg` `{user_id, message, msg_id?}` | 私聊。user_id 支持 owner QQ 号或 openid |
| `POST /send_group_msg` `{group_id, message, msg_id?}` | 群聊。group_id 为**群 openid**（见 bindings） |
| `POST /send_msg` | 通用发送 |
| `POST /get_login_info` / `get_status` | 恒返回在线（官方 Bot 不掉线） |
| `GET /bindings` | 查看已学习的 openid 绑定 |
| `WS :3101` | OneBot 风格事件推送（给 qq-reply 等） |

`message` 格式：`[{type:"text",data:{text}}]` / `[{type:"image",data:{file:"base64://..."}}]`（兼容 ths-news 图片卡片）。
带 `msg_id` = 被动回复；不带 = 主动推送（受官方配额：单聊/群 1000 条/天）。

## 已接入（2026-09-02 完成）

迁移已落地，**无需任何手工步骤**——两个消费方都由 `docker-compose.yml` 的环境变量指向网关：

| 服务 | 配置项 | 值 |
|---|---|---|
| `qq-reply` | `NAPCAT_WS_URL` / `NAPCAT_URL` | `ws://official-bot-gateway:3101` / `http://official-bot-gateway:3100` |
| `ths-news` | `NAPCAT_URL` | `http://official-bot-gateway:3100` |
| `a-share-report`（宿主机脚本） | `NAPCAT_URL` | `http://127.0.0.1:3100`（脚本内默认值） |

```bash
docker compose up -d            # 三个容器一起起
docker logs -f official-bot-gateway
```

> `reply/` 当前以完整目录 bind mount 到 `/app`。请修改宿主的 `reply/` 源码，代码改动后执行 `docker compose restart qq-reply`；`config.json` 每条消息热加载，无需重启。变量名 `NAPCAT_*` 沿用历史命名，当前指向官方网关。

## 已知差异 / 注意

- **openid 与 QQ 号**：官方平台只认 openid、不认 QQ 号。本网关做了映射层——**已与机器人互动过的目标可直接填 QQ 号 / 群号**（`openidByQq(qq) || qq`、`groupOpenidByQq(gid) || gid`），没互动过的目标必须先学习（owner 私聊 `bind-owner`、群需被 @ 一次），或直接填 openid。映射表：`/bindings`。
- **被动回复有时效**：群聊 @后 5 分钟、私聊 60 分钟内回复有效，超时需改主动推送（消耗配额）。
- **主动推送配额**：单用户/单群 1000 条/天、20 条/分钟；用户可关闭「允许主动发送」开关，关闭后主动消息失败。
- **旧 NapCat monitor 已删除**：它依赖机器人自身状态与通知，无法在彻底掉线时形成可靠的独立告警链路。若启用 NapCat，请使用 WebUI、容器日志或外部监控。
- 图片走官方媒体上传（≤30MB），自动分块，ths-news 卡片图（几百 KB）无压力。
