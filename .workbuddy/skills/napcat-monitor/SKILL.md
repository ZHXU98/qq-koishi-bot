---
name: napcat-monitor
description: NapCat QQ 机器人（OneBot 11）掉线监控与扫码恢复工作流。用于检查 NapCat 是否真正在线（online && good 双真、账号校验，识别"假在线"）、掉线自愈（docker compose restart）、按需交付登录二维码，以及掉线间隔/频率记录（record_disconnect.sh 自动累计事件、计算平均间隔与去重）。触发场景：用户问"检查 bot 状态 / NapCat 在线吗 / bot 掉线了 / 要二维码 / 帮我扫码登录 / 运行监控 / 掉线频率"等，以及每小时 NapCat 掉线监控自动化。关键用户偏好：自动推送只报原因不附二维码；二维码仅在用户对话中主动索取时实时导出交付。
agent_created: true
---

# NapCat 掉线监控与按需扫码

## 概述

监控 NapCat 容器（OneBot 11，HTTP 端口 3000）的真实在线状态，掉线时自动重启自愈，无法自愈则通知用户重新扫码登录。核心约束：**只做监控与汇报，禁止改动任何配置文件**（check_napcat.sh / docker-compose.yml / push_targets.json 等一律不修改）。

关键路径：
- 监控脚本：`/Users/zhangxu/Desktop/qq-koishi-bot/monitor/check_napcat.sh`
- 日志：`/Users/zhangxu/Desktop/qq-koishi-bot/monitor/monitor.log`
- 状态：`/Users/zhangxu/Desktop/qq-koishi-bot/monitor/state.json`
- 二维码（脚本导出目标）：`/Users/zhangxu/Desktop/qq-koishi-bot/monitor/latest_qr.png`
- 二维码（对话交付用，见下）：`/Users/zhangxu/Desktop/qq-koishi-bot/monitor/latest_qr_<时分秒>.png`（**唯一文件名，禁止覆盖 latest_qr.png**，否则 present_files 按路径缓存会展示旧图）
- 预览页：`/Users/zhangxu/Desktop/qq-koishi-bot/monitor/napcat_qr.html`（仅作为可选兜底，自动推送禁用）

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

> ⚠️ **两大已踩坑 bug（2026-08-18 实测，务必遵守，否则用户拿到过期/旧码）**：
> 1. **只 `docker cp` 不重启 = 拷贝静态旧码**：NapCat 只有重新进入"待扫码"登录流程才会写出带当前时间戳的新 `qrcode.png`。单纯拷贝容器里已有文件不会刷新，旧码早已过期。
> 2. **复用同名 `latest_qr.png` = 被预览缓存成旧图**：`present_files` 按文件路径缓存，重复覆盖同一文件名时前端常显示第一枚旧图（实测用户一直看到 13:00 的旧码）。**必须用唯一时间戳文件名。**

1. 先探测状态（用上方命令）；若已在线则告知"在线正常"无需扫码。
2. 若 offline，**先重启容器强制重新生成二维码**：
   ```bash
   docker compose -f /Users/zhangxu/Desktop/qq-koishi-bot/docker-compose.yml restart napcat
   ```
3. **轮询等待容器内 `qrcode.png` 真正刷新**（mtime 距现在 < 60s，确认是刚生成的；或 `docker logs napcat --tail 3` 出现「二维码已保存」）。**绝不在 restart 后立刻 `docker cp`**，否则拷到的是过期旧码：
   ```bash
   for _ in $(seq 1 30); do
     m=$(docker exec napcat stat -c %Y /app/napcat/cache/qrcode.png 2>/dev/null) || { sleep 2; continue; }
     [ $(( $(date +%s) - m )) -lt 60 ] && break
     sleep 2
   done
   ```
4. **导出到唯一文件名（关键，绕过 present_files 预览缓存）**：
   ```bash
   TS=$(date +%H%M%S)
   OUT=/Users/zhangxu/Desktop/qq-koishi-bot/monitor/latest_qr_${TS}.png
   docker cp napcat:/app/napcat/cache/qrcode.png "$OUT"
   ls -l "$OUT"   # 核对 mtime 确为当前时刻、size 正常（约 590~600B），避免交付旧码
   ```
5. `present_files` **交付该唯一路径 `$OUT`**（不要交付 `latest_qr.png`）。汇报"⚠️ bot 需重新扫码登录（票据过期），已交付最新二维码，请尽快用手机 QQ 扫描（约 2 分钟有效）"。
6. 日志里会打印二维码解码 URL（形如 `https://txz.qq.com/p?k=...&f=...`），若图片渲染异常可一并提供作兜底。
7. 若容器迟迟未生成 `qrcode.png`，告知用户在本机 NapCat WebUI（http://127.0.0.1:6099/webui）查看实时二维码。

## 密码快速登录回退与新设备验证（主动通知）

为消除「需重新扫码」分支，napcat 服务已配置 `NAPCAT_QUICK_PASSWORD`（值存于 gitignore 的 `.env`，`docker-compose.yml` 仅引用变量名 `${QQ_QUICK_PASSWORD}`）。票据过期时优先用账号+密码自动回退登录，无需人工扫码。

但密码回退在以下情况仍会被腾讯拦截，需一次人工交互：
- **新设备验证**：若登录态被清空 / 设备未受信任，日志出现「密码回退需要新设备验证，请在 WebUi 中继续完成验证」。此时 bot 卡在验证环节离线，必须用户在 WebUi 完成验证才能上线。
- 账号开了设备锁 / 异地保护时，密码快速登录也可能被要求短信验证码。

### 监控侧：主动通知（关键，必须固化）
密码回退触发新设备验证时，日志特征是「新设备验证」**而非**「需重新扫码」，bot 也不在等二维码——若只靠「需扫码」分支会漏报。故在自动化 / 对话监控里**额外 grep 日志**：
```bash
docker logs napcat --since 30m 2>/dev/null | grep -q '新设备验证\|请在 WebUi 中继续完成验证'
```
命中则**主动推送告警**（微信 / QQ / 桌面通知均可），内容：
> ⚠️ NapCat 密码回退触发「新设备验证」，bot 当前离线。请在浏览器打开 NapCat WebUI 完成验证：http://127.0.0.1:6099/webui （或手机短信验证）。完成后该设备被信任，之后可全自动免扫码。

提示用户：验证完成后 bot 会自动恢复（或让监控下一轮 `docker compose restart napcat` 一次）。

### 重要注意
- **首次密码登录才会弹新设备验证**：日常仅票据过期（`./napcat/QQ` 设备信任仍在）时走密码回退通常**不**弹此步；验证后设备被信任，后续全自动。
- `.env` 含密码明文，已被 gitignore，**严禁写入 docker-compose.yml 或任何会被提交的文件**（compose 已 push 到 GitHub，明文会泄露）。
- 密码回退能自动化「掉线→恢复」，但清不掉 `serverErrorCode 168` 风控标记（根因仍需官方手机 QQ 登录 2804223545 走安全验证）。

## 掉线事件记录（间隔 / 频率统计）

为了长期掌握 NapCat 掉线节奏（识别服务端风控持续踢人，而非偶发票据过期），每小时监控检测到掉线时，应把事件追加到一张事件表，并自动计算「距上次间隔」与「平均间隔」。本能力属于**观测/记录**，只写 `monitor/` 下的日志与状态文件，不改动 check_napcat.sh / docker-compose.yml / push_targets.json，与"禁止改配置"约束不冲突。

关键文件：
- 记录表：`/Users/zhangxu/Desktop/qq-koishi-bot/monitor/disconnect_log.md`
- 记录脚本：`/Users/zhangxu/Desktop/qq-koishi-bot/monitor/record_disconnect.sh`
- 状态文件（累计计数/间隔秒数汇总）：`/Users/zhangxu/Desktop/qq-koishi-bot/monitor/.disconnect_state`

### record_disconnect.sh 用法
由每小时监控自动化在判定掉线时调用（自愈成功分支传「自动重启恢复」；需扫码分支传「需重新扫码（票据过期）」）：
```bash
bash /Users/zhangxu/Desktop/qq-koishi-bot/monitor/record_disconnect.sh "<现象/处置简述>"
```
- 自动算序号、距上次间隔（`XhXXm`，首次为 `—`）、刷新汇总块（累计次数、平均间隔）。
- 自带 **2h 去重**：距上次记录 < 7200s 视为同一 episode，直接退出不重复追加，避免一次长离线被每小时重复计。
- 间隔 = 距上一次记录的时长，非服务端精确踢人时刻（监控有滞后，正常）。
- note 参数会去除 `|` 与换行，避免破坏 Markdown 表格。

### disconnect_log.md 结构
```
# NapCat 掉线事件记录（disconnect_log）
## 汇总
- 统计起始：YYYY-MM-DD HH:MM
- 累计掉线次数：**N**
- 平均间隔：约 **XhXXm**
- 最短 / 最长间隔：**Xm** / **XhXXm**
- 趋势：（可选，结合日志 serverErrorCode 168 / KickedOffLine 给出判定）
## 事件明细
| # | 日期时间 | 距上次 | 现象 / 处置 |
|---|----------|--------|------------|
```

### 初始化状态（首次部署 / 预填历史）
`.disconnect_state` 内容为 `last_epoch<TAB>count<TAB>sum_intervals_seconds`，需先初始化，再用历史数据预填明细行，否则间隔计算会失真。示例（2026-08-18 基线：7 次，末次 18:05，6 个间隔合计 35640s）：
```bash
LAST=$(date -j -f '%Y-%m-%d %H:%M' '2026-08-18 18:05' +%s)
printf '%s\t7\t35640\n' "$LAST" > /Users/zhangxu/Desktop/qq-koishi-bot/monitor/.disconnect_state
# 35640 = 52m+2h39m+24m+52m+2h27m+2h40m = 3120+9540+1440+3120+8820+9600
```
明细行与汇总块直接在 `disconnect_log.md` 手写预填；脚本只负责后续追加。

### gitignore / 入库
`disconnect_log.md` 与 `.disconnect_state` 是运行态产物，已加入 `.gitignore` 不入库；`record_disconnect.sh` 作为代码保留（与 check_napcat.sh 同类）。

### 自动化接线
每小时监控自动化（automation-1786964342410）的 prompt 第 4 步已内置此调用；若重建自动化或换会话，按上文把"掉线时调用 record_disconnect.sh"一并写回 prompt。

## 注意事项

- 脚本内部有 30 分钟离线告警冷却：`state.json` 的 last_alert 与当前时间差 ≤1800s 时会跳过重复通知与二维码导出。若用户索要二维码但冷却未过，需手动执行 `docker cp` 从容器实时导出（不要改脚本）。
- QQ 提醒、macOS 桌面通知、微信推送（本自动化已开启）由脚本/自动化按设定负责，无需重复操作。
- 禁止改动任何配置文件；仅做监控、汇报与按需扫码交付。
