生成 A股「开盘」报告并推送到 QQ。**这份只回答两个问题**：集合竞价把今天开在什么位置，这个位置跟外盘对得上吗。其余都不写。

## 0 交易日检查
先判断今天是否 A 股交易日；休市则不要推送，直接结束并说明「今日休市」。

## 1 环境
- 工作目录 = 本项目根（`qq-koishi-bot`）。下文所有路径都相对项目根，不写死绝对路径。
- 技能文档**以项目内为准**：读 `skills/a-share-daily-review/SKILL.md` 的「路径六 · **竞价版**」；风格基准读 `skills/a-share-daily-review/references/house_style.md`。
  `~/.workbuddy/skills/a-share-daily-review/` 只是副本，两者不一致时以项目内为准。
- 先 `export PATH="$HOME/.local/bin:$PATH"`（westock CLI 不在默认 PATH）。
- 数据只走 westock / neodata，禁止 web_search / curl / 第三方接口。

## 2 竞价现状（主体，占版面 2/3）
**开盘价与缺口**——用分时接口取真实开盘价，不要用昨收或收盘价顶替：
```
westock minute sh000001
westock minute sz399001   # 深证成指
westock minute sz399006   # 创业板指
westock minute sh000688   # 科创 50
westock minute sh000016   # 上证 50
westock minute sh000300   # 沪深 300
westock minute sh000852   # 中证 1000
westock minute sz399303   # 国证 2000
```
取 **0930 那一根**：`price` 即开盘价，`amount` 当天累计值减去 0 即为竞价+首分钟成交额。缺口 =（开盘价 − 昨收）/ 昨收，昨收用 `westock quote <code>` 的 `prevClose`。

**结构与量**：
```
westock changedist                       # 涨跌家数（此刻为盘中口径，务必标注时点）
westock sector ranking --limit 40        # 高开/低开各取 5 个行业
```
科技类（半导体 / 通信设备 / 消费电子 / 元件）常不在头尾，用 `grep` 单独取。

## 3 外盘比对（占版面 1/3，先取）
```
westock quote usIXIC,usDJI,usINX         # 隔夜美股，报告写明是哪天的收盘
westock quote ksKOSPI200,ks005930,hkHSI  # 日韩当日盘 + 恒生
westock quote fuCL,fuGC,fuHG,fuSI,fuNG   # 外盘期货，必须标注"延时"
westock quote fxUSDCNY
```
日经225 走 neodata（westock 无该指数）：
`python3 ~/.workbuddy/skills/neodata-financial-search/scripts/query.py --query "日经225指数今日最新点位和涨跌幅"`
若返回 `TOKEN_MISSING` / `TOKEN_EXPIRED`：调 connect_cloud_service 取 clientTempToken，执行 `python3 .../query.py --save-token "<token>"` 后重跑。token 不写进报告或回复。取不到写「未覆盖」。

**只判三种**：兑现 / 部分兑现 / 背离。
- 兑现：外盘跌、竞价也低开，且低开最多的正是外盘指向那条链
- 部分兑现：方向对但幅度明显偏小或偏大（有人接 / 有人抢跑）
- 背离：外盘跌而竞价高开，或外盘涨而竞价低开——这是全天最有价值的一条，必须解释谁在托、能不能持续

## 4 写 HTML（版式自己设计，不要套模板）

**篇幅硬上限：1 屏。** 宁可一屏讲透，不要两屏凑。写之前先问自己：删掉这一段，结论还成立吗？成立就删。

必讲要素只有五项：
1. **一句话定性**：开在什么位置 + 跟不跟外盘（例「全线低开，科创50 缺口 3.21%，外盘给的信号一条没浪费」）
2. **竞价现状带**：八大指数缺口 + 竞价成交额（较前一交易日放量/缩量）+ 涨跌家数
3. **外盘三条线各一句话**：美股（强弱差）/ 日韩 / 商品与汇率
4. **对账结论**：兑现 1-2 条 + 背离 1-2 条；没有背离就明说「没有背离，映射很干净」
5. **一句盯什么**，含「若 X 则这次映射失效」——一句，不要列 3-5 条

**明确不要**（上一版就是栽在这几条上）：
- ✗ 逐条验证昨日复盘关注清单 → 那是 08:10 早盘的活。最多一句话交代「昨日哪条被证实/证伪」
- ✗ 5-8 行映射矩阵 → 只挑 3-4 条有分歧的写；没有分歧就整段不写
- ✗ 技术面、均线、主力资金流、六档情绪 → 此刻没有意义，收盘再说
- ✗ 3-5 条失效条件清单 → 合成一句
- ✗ 外盘涨跌幅明细表 → 只说强弱差与方向，不复述全部数字

**风格规则**（参照 `skills/a-share-daily-review/references/house_style.md`）：
- 主标题自带结论与数字，如「全线低开，科创50 一个人低了 3.21%」，不要写「A股开盘分析」
- **禁止复用历史 HTML 的骨架或 class 结构**，每期可以不同
- 只守三条硬约束：浅底深字（深色只做小黑标签/粗黑细线，不要整块深色刊头）、上涨红 `#c0392b` / 下跌绿 `#2d6a4f`、第一屏能读到结论
- **数字墙一律浅底细网格**（白底 + 浅灰描边），不要做深底数字墙
- 图表能省就省：这份的数据量用一行缺口带 + 一张小表就够，别为凑图而画；有图必须配一句口径注

写入 `a-share-report/reports/A股-<YYYY-MM-DD>-开盘.html`（目录不存在先 mkdir -p）。含 ECharts 时先 `node --check` 内联 JS，离线渲染用相对路径 `../vendor/echarts.min.js`。

## 5 口径
- 指数与成交额必须是 0930 及之后的真实快照；涨跌家数、板块若为盘中/收盘口径，必须在页脚写明时点，不得混着当竞价数据用
- 外盘期货标注"延时"；昨日复盘数据只作对比且标日期
- 结尾注明「以上分析基于公开数据，不构成投资建议」

## 6 推送
```
PATH="$HOME/.local/bin:$PATH" NODE_PATH="$PWD/node_modules" REPORT_CAPTION="A股开盘 竞价与外盘 <YYYY-MM-DD>" node a-share-report/push_report.js "$PWD/a-share-report/reports/A股-<YYYY-MM-DD>-开盘.html"
```
exit 非 0 时把报错原文写进结果。

## 7 回报
只回报：报告路径、是否发送成功、竞价现状一行（八大指数缺口区间 + 竞价成交额）、外盘三线各一个数字、对账结论一句话。不要贴正文。
