生成 A股「早盘」报告并推送到 QQ。核心是**外盘映射 + 昨日复盘对照**：拿本地昨天的盘后复盘当假设，用隔夜外盘和日韩早盘去检验它。

## 0 交易日检查
先判断今天是否 A 股交易日；休市则不要推送，直接结束并说明「今日休市」。

## 1 环境
- 工作目录 = 本项目根（`qq-koishi-bot`）。下文所有路径都相对项目根，不写死绝对路径。
- 技能文档**以项目内为准**：先读 `skills/a-share-daily-review/SKILL.md` 的「路径六：开盘外盘映射分析」（含步骤 0 昨日复盘对照）；风格基准读 `skills/a-share-daily-review/references/house_style.md`（风格 DNA，不是模板）；需要看成品手法可翻 `skills/a-share-daily-review/examples/`。
  `~/.workbuddy/skills/a-share-daily-review/` 只是副本，两者不一致时以项目内为准。
- 先 `export PATH="$HOME/.local/bin:$PATH"`（westock CLI 不在默认 PATH）。
- 数据只走 westock / neodata，禁止 web_search / curl / 第三方接口。

## 2 本地捞昨日复盘（对比基准，先做这步）
```
ls -t a-share-report/reports/A股-*-复盘.html | head -1
```
用 Read 读取这份 HTML，提取：
- 六大指数收盘点位与涨跌幅、成交额
- 涨跌家数、涨停/跌停数
- 市场状态定位（进攻/修复/分歧/退潮）
- **「次日开盘关注清单」的每一条**（这是最关键的部分，逐条抄出来）
- 技术面三档建仓的触发条件与当时状态

日期核对：文件名日期必须是**上一个交易日**（周一对应上周五）。核对不上就说明差异，不要硬套。
目录为空或没有复盘文件 → 降级：用 `westock kline sh000001 --period day --limit 2`、`westock quote` 的 prev_close、`westock changedist` 回补上一交易日数据，并在报告里注明「无历史复盘，用行情回补」。

## 3 外盘三线（这个时点的行情状态要写准）
**隔夜美股**（取最新完整交易日，报告写明日期）：
```
westock quote usIXIC,usDJI,usINX
```
纳指 usIXIC、道指 usDJI、标普 usINX（`us.SPX` 无数据）。看强弱差（成长 vs 价值）、振幅、收盘是否在日内低点。

**日韩（时点很关键）**：
```
westock quote ksKOSPI200,ks005930,hkHSI
```
- 日本 8:00（北京时间）开盘，此刻约 10 分钟数据 → 标注「早盘初段，样本短」
- 韩国 9:00 才开盘 → KOSPI/三星取的是**上一交易日收盘**，必须写「尚未开盘，为昨收」
- 日经225 走 neodata：`python3 ~/.workbuddy/skills/neodata-financial-search/scripts/query.py --query "日经225指数今日最新点位和涨跌幅"`
  若返回 `TOKEN_MISSING`/`TOKEN_EXPIRED`：调 connect_cloud_service 取 clientTempToken，执行 `python3 ~/.workbuddy/skills/neodata-financial-search/scripts/query.py --save-token "<token>"` 后重跑。token 不写进报告或回复。
  取不到写「未覆盖」，不得用近似指数顶替。

**大宗商品（外盘期货，延时报价，必须标注）**：
```
westock quote fuCL,fuGC,fuHG,fuSI,fuNG
```
WTI原油 / COMEX黄金 / COMEX铜 / COMEX白银 / NYMEX天然气 → 油气开采油服 / 黄金股 / 有色铜箔电网 / 白银股 / 燃气化工。

**汇率**：
```
westock quote fxUSDCNY
```

## 4 对比分析（这份报告的核心价值）
- **昨日关注清单逐条检验**：每条原话 → 今早外盘/日韩给出的条件判断 → 结论只能是「可能满足 / 可能破坏 / 待开盘验证」三种，不许下定论（今天还没开盘）。
- **外盘三线 vs 昨日市场状态**：昨日是退潮/修复/分歧中的哪一种？外盘是延续还是反转？方向一致说明假设成立，反向说明昨日结论要修正。
- **映射矩阵**：昨日主线板块（半导体、光模块等）+ 外盘信号 → 今日开盘可能强/弱的板块，标注强度和方向。
- **今日预案**：3-5 条开盘要盯的东西，包含失效条件。

## 5 写 HTML（版式自己设计，不要套模板）
必讲要素（缺一不可，顺序与呈现方式随你）：
- 首屏**结论**：一句话定性今日早盘（含「昨日状态 → 隔夜外盘 → 今日倾向」三段逻辑）
- 外盘三线状态：美股 / 日韩 / 商品 / 汇率，形式随意（灯带、指标带、短句、条形图都行）
- **昨日复盘对照**：昨日收盘关键数字 + 市场状态定位 + 关注清单逐条检验（原话 → 今早判断）
- **映射矩阵**：外盘信号 → A 股板块 → 方向 → 强度，5-8 行
- **今日开盘关注**：3-5 条 + 失效条件
- 顶部注明「对比基准：<上一交易日> 收盘复盘」；走降级路径时改为「无历史复盘，用行情回补」
- 结尾注明「以上分析基于公开数据，不构成投资建议」

风格参考 `skills/a-share-daily-review/references/house_style.md`：
主标题自带结论与数字（如「外盘先跌为敬，A 股今天开盘只有一条路」），首屏说尽，章节编号带数据副标题，图表配一句口径注。
**禁止复用历史 HTML 的骨架与 class 结构**，这一份要和昨天那份不一样。
硬约束只有三条：浅底深字（深色只做刊头/点缀）、上涨红 `#c0392b` / 下跌绿 `#2d6a4f`、第一屏能读到结论。
手机 600px 宽，1-2 屏。

写入 `a-share-report/reports/A股-<YYYY-MM-DD>-早盘.html`（目录不存在先 mkdir -p）。含 ECharts 时先 `node --check` 内联 JS；离线渲染用相对路径 `../vendor/echarts.min.js`。

## 6 推送
```
PATH="$HOME/.local/bin:$PATH" NODE_PATH="$PWD/node_modules" REPORT_CAPTION="A股早盘 外盘映射 <YYYY-MM-DD>" node a-share-report/push_report.js "$PWD/a-share-report/reports/A股-<YYYY-MM-DD>-早盘.html"
```
exit 非 0 时把报错原文写进结果。

## 7 回报
只回报：报告路径、是否发送成功、昨日状态一句话、外盘三线关键数字（美股三大指数 / 日经 / KOSPI / 原油黄金铜）、今日倾向 1-2 句。不要贴正文。
