# NapCat 掉线监控（monitor）

宿主机脚本，负责**持续守护 NapCat 机器人在线状态**，掉线自动自愈，自愈失败则通过 WorkBuddy 自动化把「需重新扫码」的告警（含二维码）推送到用户微信，**远程也能知道并处理**。

> ⚠️ **状态：已停用（2026-09-02）**。NapCat 个人号通道已整体下线，改用官方 QQ 机器人网关 `official-bot-gateway`（官方 Bot 在线稳定、不掉线，故本监控不再适用）。本文档与 `check_napcat.sh` 仅作备用通道的恢复参考保留，见仓库根 README「NapCat 备用通道（已停用）」。

## 为什么需要它

- rssBOT（2804223545）掉线时，**QQ 通道必然失效**——它自己发不出消息，所以「发 QQ 提醒」救不了掉线场景。
- macOS 桌面通知只出现在本机屏幕，**远程用户看不到**。
- 因此告警必须走一条与机器、与 bot 无关的通道：**WorkBuddy 自动化 + 微信推送**。

## 文件

| 文件 | 说明 |
|------|------|
| `check_napcat.sh` | 监控主脚本（入库） |
| `state.json` | 运行态：上次状态 / 上次告警时间（gitignore，勿提交） |
| `monitor.log` | 运行日志（gitignore，勿提交） |
| `latest_qr.png` | 需扫码时导出的最新二维码（gitignore，勿提交） |
| `napcat_qr.html` | 需扫码时由 WorkBuddy 自动化生成的**远程扫码预览页**（gitignore，勿提交） |

## check_napcat.sh 探测与自愈逻辑

```
probe：POST /get_login_info + /get_status，要求 online=true 且 good=true 且账号=2804223545
  ├─ 通过 → 若上次 offline，发 QQ「已恢复在线」；否则静默（心跳正常）
  └─ 失败 → notify_desktop + docker compose restart napcat → 等 22s 再 probe
        ├─ 恢复 → 发 QQ「已自动重启恢复」
        └─ 仍失败 → 30 分钟冷却内只提醒一次；docker cp 导出最新二维码到 latest_qr.png
                    + notify_desktop「需重新扫码」
```

- 用 `online && good` 双真判断，能识别「假在线」（good=false 表示底层连接异常）。
- 只在**状态变化**时发 QQ（避免每小时刷屏）；离线告警 30 分钟冷却。
- 手动测试：`bash check_napcat.sh --test`（发一条自检 QQ）；`--force-offline` 模拟掉线走告警分支。

## WorkBuddy 自动化配置（异地恢复的关键）

自动化任务 `automation-1786964342410`（NapCat 掉线监控）需要如下配置，**换机器/换环境时按此重建**：

| 项 | 值 |
|----|-----|
| 名称 | NapCat 掉线监控（每小时） |
| 周期 rrule | `FREQ=HOURLY`（**不要写 `RRULE:` 前缀**，否则界面会错误显示为「每天0点」） |
| 工作目录 cwds | `/Users/zhangxu/Desktop/qq-koishi-bot` |
| 微信推送 push_to_wechat | `1`（开启；执行结果实时推送到用户微信，实现远程知悉） |
| prompt | 见下方要点 |

> 注意：`push_to_wechat` 字段不在自动化管理接口中暴露，需直接写入自动化存储库（SQLite `automations` 表）或在支持该开关的界面开启。

### prompt 要点

1. 执行 `bash monitor/check_napcat.sh`，读 `monitor.log` 末尾 8 行 + `state.json` 判断状态变化。
2. **汇报原则：出事才详细汇报，正常只回一句「NapCat 在线正常」，不打扰。**
3. 状态分支：
   - 正常（在线心跳正常）→ 极简一句；
   - 掉线但自动重启成功 → 汇报「曾掉线但已自动重启恢复」；
   - **需重新扫码** → 完整远程扫码交付流程（见下）。
4. 禁止改动任何配置文件。

### 需重新扫码时的远程交付流程

```
1. 检查 monitor/latest_qr.png 是否存在
2. 存在 → Python 把 PNG 转 base64 内嵌成自包含 HTML（napcat_qr.html）
          → 保存到 monitor/napcat_qr.html
          → present_files 交付该 HTML（实时预览）→ 用户远程直接用手机 QQ 扫码
3. 不存在 → 提示用户到本机 NapCat WebUI（http://127.0.0.1:6099/webui）看实时二维码
```

> 已验证（2026-08-17 14:06）：用户远程通过该预览页扫码成功恢复登录。二维码约 2 分钟过期，过期后重新执行监控脚本再导出。

## 与 ths-news / a-share-report 的关系

- `ths-news`（每 5 分钟转发）：每轮推送前自带 `get_login_info` 快检，掉线则**跳过本轮、下轮重试**（防一次抖动打挂循环）；
- 本监控（每小时）：深度探测 + **自动重启自愈 + 远程扫码交付**，兜底 ths-news 与 a-share-report 共用机器人。
- 两条检查线各司其职：快检保转发不卡死，兜底保掉线有人管。

## 排障

| 现象 | 处理 |
|------|------|
| 日志「自动重启后仍无法连接」 | 票据过期，需重新扫码（自动化的远程扫码交付会生成预览页） |
| QQ 提醒发不出 | 说明 bot 本身已掉线，属预期；告警已改走微信推送通道 |
| 界面显示「每天0点」 | rrule 带了 `RRULE:` 前缀导致展示解析异常，规范化为 `FREQ=HOURLY` |
