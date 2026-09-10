# 提示词（可直接复制粘贴）

以下提示词用于让 AI（或本仓库的 WorkBuddy Skill `ths-news-forwarder`）在新机器上部署、配置、排障本服务。
把对应段落发给 AI 即可，无需自己记命令。

---

## 1. 部署（新机器 / 从 GitHub 克隆后）

```
帮我在当前目录部署 ths-news 同花顺重要资讯转发服务。
这是 Docker Compose 项目（根目录 docker-compose.yml 已编排 official-bot-gateway + qq-reply + ths-news）。
请按顺序执行：
1. 确认已 cp .env.example .env 且填了 QQBOT_APP_ID / QQBOT_APP_SECRET
2. 确认机器人已上线、已 bind-owner 并学习到目标映射（curl -s http://127.0.0.1:3100/bindings），且已 cp ths-news/ths_news_targets.json.example ths-news/ths_news_targets.json 并回填了目标（QQ号 / 群号 或 openid）
3. 运行 bash ths-news/setup_fonts.sh 准备中文字体（没有就按提示手动放一款 .ttc 到 ths-news/fonts/cjk.ttc）
4. docker compose up -d 启动
5. 用 docker exec ths-news node /app/fetch_ths_news.js --dry-run 验证能拉到数据且不报错
6. 把验证结果告诉我
```

---

## 2. 推到 QQ 的图片「没字了」（最常见故障）

```
ths-news 推到 QQ 的图片卡片文字是空白的，只剩红条和分隔线。
这通常是容器内 /app/fonts/cjk.ttc 字体缺失，resvg 加载不到中文字体导致。
请排查并修复：
1. docker exec ths-news ls -la /app/fonts/ 看 cjk.ttc 是否存在
2. 宿主侧在 ths-news/fonts/ 放一份 cjk.ttc（用 bash ths-news/setup_fonts.sh 从系统字体复制即可）
3. bind mount 会实时生效，无需重启容器；再 docker exec 渲染验证中文出现
4. 用 --force 或验证脚本推一张图到 QQ 确认中文可见
```

---

## 3. 改推送目标 / 加 QQ 群

```
帮我改 ths-news 的推送目标：把私聊接收者改成 X，并增加群 Y。
配置文件是 ths-news/ths_news_targets.json（private / groups 数组填 QQ 号 / 群号即可，前提是网关已学习到映射；否则填 openid。用 curl -s http://127.0.0.1:3100/bindings 查）。
改完 docker compose 无需重启（配置是 bind mount 读取），下一轮循环生效。
改完用 --dry-run 确认 private/groups 解析正确。
```

---

## 4. 调整抓取频率 / 过滤规则

```
ths-news 目前每 5 分钟抓一次、只推同花顺官方「重要」(import>0) 的快讯。
我想：
- 改成每 15 分钟抓一次（调 NEWS_INTERVAL 环境变量，单位秒）
- 或者也把「命中金融关键词」的普通快讯纳入（把 IMPORT_ONLY 设 false）
请改 docker-compose.yml 的环境变量并 docker compose up -d 生效，然后 --dry-run 对比候选数量变化。
```

---

## 5. 发一张固定内容的测试卡片

```
ths-news 现在没有交易时段的「重要」快讯可推。请写一段临时脚本：
require 真实 fetch_ths_news.js 的 renderCard/buildCardSvg，构造 2-3 条中文 mock 快讯，
渲染成图片卡片并推到我的 QQ 私聊（官方机器人网关 base64 图片消息），用于检查格式。
推完把 message_id 告诉我。
```

---

## 6. 改卡片样式

```
ths-news 的图片卡片（buildCardSvg）现在：条目间有浅灰分隔线、标题摘要有间距、超长摘要末行加省略号、行尾标点不孤立。
我想把分隔线颜色调深一点 / 字号调大 / 内边距调小。
请改 fetch_ths_news.js 的 buildCardSvg，改完 node --check，再渲染一张图推到 QQ 让我看效果。
注意改的是容器仓库里的 ths-news/fetch_ths_news.js（bind mount 源），改完下一轮循环自动生效。
```
