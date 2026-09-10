# official-bot-gateway — 官方 QQ 机器人网关（OneBot 兼容层）

用官方开放平台机器人（appid + appsecret）替代 NapCat，解决个人号被风控踢线问题。
对外暴露与 NapCat 兼容的 HTTP + WebSocket 接口，**现有服务（ths-news / qq-reply / a-share-report / monitor）几乎零改动即可切换**。

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

> 注意：**不要**试图在容器里改 `/app/index.js` —— 它是 `:ro` 只读挂载，`sed -i` 会失败。要改就改宿主的 `reply/index.js`（变量名 `NAPCAT_*` 沿用历史命名，指向的已是网关），改完 `docker compose restart qq-reply`。

## 已知差异 / 注意

- **openid 与 QQ 号**：官方平台只认 openid、不认 QQ 号。本网关做了映射层——**已与机器人互动过的目标可直接填 QQ 号 / 群号**（`openidByQq(qq) || qq`、`groupOpenidByQq(gid) || gid`），没互动过的目标必须先学习（owner 私聊 `bind-owner`、群需被 @ 一次），或直接填 openid。映射表：`/bindings`。
- **被动回复有时效**：群聊 @后 5 分钟、私聊 60 分钟内回复有效，超时需改主动推送（消耗配额）。
- **主动推送配额**：单用户/单群 1000 条/天、20 条/分钟；用户可关闭「允许主动发送」开关，关闭后主动消息失败。
- **掉线监控不再适用**：官方 Bot 不会掉线；monitor 若指向网关，`get_login_info` 恒在线，不会误报。
- 图片走官方媒体上传（≤30MB），自动分块，ths-news 卡片图（几百 KB）无压力。
