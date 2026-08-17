---
name: napcat-monitor
description: NapCat QQ 机器人（OneBot 11）掉线监控与扫码恢复工作流。用于检查 NapCat 是否真正在线（online && good 双真、账号校验，识别"假在线"）、掉线自愈（docker compose restart）、按需交付登录二维码。触发场景：用户问"检查 bot 状态 / NapCat 在线吗 / bot 掉线了 / 要二维码 / 帮我扫码登录 / 运行监控"等，以及每小时 NapCat 掉线监控自动化。关键用户偏好：自动推送只报原因不附二维码；二维码仅在用户对话中主动索取时实时导出交付。
agent_created: true
---

# NapCat 掉线监控与按需扫码

## 概述

监控 NapCat 容器（OneBot 11，HTTP 端口 3000）的真实在线状态，掉线时自动重启自愈，无法自愈则通知用户重新扫码登录。核心约束：**只做监控与汇报，禁止改动任何配置文件**（check_napcat.sh / docker-compose.yml / push_targets.json 等一律不修改）。

关键路径：
- 监控脚本：`/Users/zhangxu/Desktop/qq-koishi-bot/monitor/check_napcat.sh`
- 日志：`/Users/zhangxu/Desktop/qq-koishi-bot/monitor/monitor.log`
- 状态：`/Users/zhangxu/Desktop/qq-koishi-bot/monitor/state.json`
- 二维码：`/Users/zhangxu/Desktop/qq-koishi-bot/monitor/latest_qr.png`
- 预览页：`/Users/zhangxu/Desktop/qq-koishi-bot/monitor/napcat_qr.html`

## 探测原理（识别"假在线"）

要求 **online 与 good 同时为 true**，且登录账号为预期 bot 账号（user_id 2804223545，昵称 同花顺rssBOT），三者缺一即视为掉线（可识别连接已断但 API 仍响应的"假在线"）：

```bash
st=$(curl -s --noproxy '*' -m 5 -X POST http://127.0.0.1:3000/get_status)
info=$(curl -s --noproxy '*' -m 5 -X POST http://127.0.0.1:3000/get_login_info)
# 在线判定：$st 含 "online":true 且 "good":true，且 $info 含 "user_id":2804223545
```

## 标准监控流程

1. 执行：`/bin/bash /Users/zhangxu/Desktop/qq-koishi-bot/monitor/check_napcat.sh`（脚本自带探测→自愈重启→通知→导出二维码逻辑，离线告警有 30 分钟冷却）。
2. 读取 `monitor.log` 最后 8 行与 `state.json`，判断状态变化。
3. 按分支汇报（保持极简，正常时不打扰）：

| 状态 | 日志特征 | 汇报 |
|---|---|---|
| 正常（与上次一致） | 「在线（心跳正常）」 | 极简一句："NapCat 在线正常" |
| 刚从异常恢复 | 「状态恢复：在线」 | "曾掉线但已自动重启恢复，现已在线" |
| 掉线但自愈成功 | 「自动重启成功，已恢复在线」 | "曾掉线但已自动重启恢复" |
| 需重新扫码 | 「自动重启后仍无法连接（可能需重新扫码登录）」 | **只报原因**："⚠️ bot 需重新扫码登录（票据过期），如需扫码在对话中告知 AI 索取最新二维码即可" |

## 用户偏好（重要，勿违反）

- **自动推送（每小时自动化/微信推送）不附二维码**：用户不一定整点查看，二维码约 2 分钟即过期，推送附码无意义。禁止自动生成 napcat_qr.html、禁止自动 present_files 交付二维码。
- **二维码按需交付**：仅当用户在对话中主动索取（如"给我二维码/要重新登录/检查下 bot"）时，才实时导出并交付。

## 对话中按需交付二维码（用户索取时执行）

1. 检查状态（用上方探测命令）；若在线则告知"在线正常"无需扫码。
2. 若 offline，刷新二维码（**必须实时刷新**，旧的已过期）：
   ```bash
   docker cp napcat:/app/napcat/cache/qrcode.png /Users/zhangxu/Desktop/qq-koishi-bot/monitor/latest_qr.png
   ```
3. 用 Python 将 PNG 转 base64 内嵌进自包含 HTML（`napcat_qr.html`，标题「NapCat 需重新扫码」，居中展示，附「请用手机 QQ 扫描下方二维码登录 rssBOT，二维码约 2 分钟过期，若过期重新索取」说明），保存到 `monitor/napcat_qr.html`。
4. 调用 present_files 交付该 HTML（实时预览），汇报"⚠️ bot 需重新扫码登录（票据过期），已生成二维码预览页供远程扫码"。可同时附 `latest_qr.png` 原图方便直接查看。
5. 若二维码文件不存在/导出失败，告知用户在本机 NapCat WebUI（http://127.0.0.1:6099/webui）查看实时二维码。

## 注意事项

- 脚本内部有 30 分钟离线告警冷却：`state.json` 的 last_alert 与当前时间差 ≤1800s 时会跳过重复通知与二维码导出。若用户索要二维码但冷却未过，需手动执行 `docker cp` 从容器实时导出（不要改脚本）。
- QQ 提醒、macOS 桌面通知、微信推送（本自动化已开启）由脚本/自动化按设定负责，无需重复操作。
- 禁止改动任何配置文件；仅做监控、汇报与按需扫码交付。
