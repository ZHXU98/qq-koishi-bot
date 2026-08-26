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

## 切换到新途径（跑通验证后）

```bash
# qq-reply 指向网关（事件通道）
docker compose exec qq-reply sh -c "sed -i 's#ws://napcat:3001#ws://official-bot-gateway:3101#;s#http://napcat:3000#http://official-bot-gateway:3100#' /app/index.js"
docker compose restart qq-reply

# ths-news 指向网关（compose 环境变量）
# docker-compose.yml → ths-news.environment.NAPCAT_URL=http://official-bot-gateway:3100
docker compose up -d ths-news
```

## 已知差异 / 注意

- **openid 替代 QQ 号**：官方 API 只认 openid，QQ 号无法反查；所有目标先由事件学习（`/bindings` 查看），owner 用 `bind-owner` 口令绑定。
- **被动回复有时效**：群聊 @后 5 分钟、私聊 60 分钟内回复有效，超时需改主动推送（消耗配额）。
- **主动推送配额**：单用户/单群 1000 条/天、20 条/分钟；用户可关闭「允许主动发送」开关，关闭后主动消息失败。
- **掉线监控不再适用**：官方 Bot 不会掉线；monitor 若指向网关，`get_login_info` 恒在线，不会误报。
- 图片走官方媒体上传（≤30MB），自动分块，ths-news 卡片图（几百 KB）无压力。
