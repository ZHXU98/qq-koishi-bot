# 可信数据源参考

## 数据获取渠道（按采集优先级排列）

以下为 A 股每日复盘报告的数据来源，所有数据均通过 4 个可信 skill 获取。

### 第一梯队（核心行情与统计）

| 编号 | Skill | 命令/调用 | 数据内容 |
| :--- | :--- | :--- | :--- |
| 1 | westock-data | `market-overview --type trade,updown --raw` | 三大指数收盘统计 + 两市成交额多周期均值 + 涨跌家数 |
| 2 | westock-data | `changedist --raw` | 沪深A股涨跌分布（涨停/跌停计数、上涨占比、11 档区间分布） |
| 3 | westock-data | `quote sh000001,sz399001,sz399006,sh000688,sh000016,sh000300,sh000852,bj899050 --raw` | 8 个核心指数实时行情 |
| 4 | westock-data | `sector ranking --raw` | 行业涨幅 TOP10 + 概念涨幅 TOP10 + 行业资金流入 TOP5 + 北向热门板块 |
| 5 | westock-data | `lhb --type institution,hotmoney --date YYYY-MM-DD --raw` | 龙虎榜机构榜 + 游资榜 |
| 6 | westock-tool | `ranking limitup_days --limit 50` | 连续涨停天数排名（连板天梯） |
| 7 | westock-data | `quote <龙头代码列表> --raw` | 龙头个股实时行情（价格/涨幅/成交额/换手率等） |

### 第二梯队（题材归因与驱动分析）

> `scripts/query.py` 位于 `neodata-financial-search` skill 目录下，调用前确认该 skill 已安装且凭证有效。

| 编号 | Skill | 调用方式 | 数据内容 |
| :--- | :--- | :--- | :--- |
| 8 | neodata-financial-search | `python3 scripts/query.py --query "A股 {日期} 今日涨停股票和热门个股有哪些，为什么上涨，有什么题材概念"` | 热点个股及题材归因 |
| 9 | neodata-financial-search | `python3 scripts/query.py --query "{日期} A股涨停股票的政策催化因素/行业事件驱动/主力资金流入/基本面业绩"` | 驱动因素四维采集 |
| 10 | neodata-financial-search | `python3 scripts/query.py --query "{日期} A股半年报/年报业绩预增净利润公告，近1-3天发布的"` | 晚间业绩公告 |
| 11 | neodata-financial-search | `python3 scripts/query.py --query "{日期} {涨价链关键词} 涨价消息，近3天"` | 涨价函新闻汇总 |
| 12 | neodata-financial-search | `python3 scripts/query.py --query "{日期} {专题关键词} 产业链 受益方 核心公司"` | 每日临时专题 |

### 第三梯队（方法论与框架）

| 编号 | Skill | 引用 | 用途 |
| :--- | :--- | :--- | :--- |
| 13 | wb-finance-skill | `references/leader-game.md` | 涨停龙头博弈方法论框架 |

## 使用注意事项

1. **数据一致性**：所有数据通过可信 skill 统一获取，避免跨源口径偏差。
2. **时效性**：优先使用 `--date YYYY-MM-DD` 指定目标日期。
3. **交叉验证**：关键数据（涨停总数、封板率、指数点位）可通过 `changedist` 与 `market-overview --type updown` 相互核验。
4. **来源标注**：每个核心数据点后标注来源编号 `【编号†Lx】`，文末统一列出来源。
