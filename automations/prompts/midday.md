生成 A股「午盘」报告并推送到 QQ。

1. 先判断今天是否为 A 股交易日；休市则**不要推送**，直接结束并说明「今日休市」。
2. 工作目录 = 本项目根（`qq-koishi-bot`）。技能文档**以项目内为准**：读 `skills/a-share-daily-review/SKILL.md`（「情绪速览」小节最相关）；风格基准读 `skills/a-share-daily-review/references/house_style.md`。`~/.workbuddy/skills/` 下的是副本，冲突时以项目内为准。取数前先 `export PATH="$HOME/.local/bin:$PATH"`（westock CLI 不在默认 PATH）。所有路径用相对项目根的路径。
3. 视角是**上午收盘（半天）**：指数半日涨跌幅与成交额、板块强弱排序与领涨领跌、主力资金流向、上午的主要题材与异动。给一句下午的关注点，但不做买卖建议。
   半日点位与半日成交额用分时接口取真实快照：`westock minute <code>`，取 1130 那一行的 price 与累计 amount。
4. **情绪速览**（三行，不展开分析）：
   ```
   westock changedist
   westock market-overview --type trade
   ```
   - 情绪：冰点 / 低迷 / 中性 / 修复 / 活跃 / 亢奋（六档选一）+ 涨 x / 跌 y，涨停 a / 跌停 b，半日成交额 d 亿（标注较前一日放量或缩量）
   - 赚钱效应：一句话
   - 下午看点：一句话
   连板高度若能从涨停梯队数据里顺手拿到就写进括号，拿不到就不写（westock 无连板天梯命令，不要调用 westock-tool）。
5. 写 HTML（**版式自己设计，不要套模板**）：
   - 必讲要素：半日指数与成交额、情绪三行、行业强弱（领涨/领跌）、午后观察点
   - 主标题自带结论与数字（如「半日跌 1.57%，跌停 68 家说明不只是科技的事」），不要写「A股午盘报告」
   - 情绪做成一个小块，占版面不超过 1/5，位置随你安排
   - **禁止复用历史 HTML 的骨架或 class 结构**，每期可以不同
   - 只守三条硬约束：浅底深字（不要整页暗色背景）、上涨红 `#c0392b` / 下跌绿 `#2d6a4f`、第一屏能读到结论
   - 图表按这一节要讲的东西选型，别为凑图而画；有图就配一句口径注
   写入 `a-share-report/reports/A股-<YYYY-MM-DD>-午盘.html`（目录不存在先 mkdir -p）。含 ECharts 时先 `node --check` 内联 JS，离线渲染用相对路径 `../vendor/echarts.min.js`。
   注意：半日点位/成交额是 11:30 快照，行业与资金流为收盘口径时要在图上或页脚注明口径。
6. 推送（目标：私聊 1547450303）：
   ```
   PATH="$HOME/.local/bin:$PATH" NODE_PATH="$PWD/node_modules" REPORT_CAPTION="A股午盘 <YYYY-MM-DD>" node a-share-report/push_report.js "$PWD/a-share-report/reports/A股-<YYYY-MM-DD>-午盘.html"
   ```
   脚本 exit 非 0 时把报错原文写进结果。
7. 结果只回报：报告路径、是否发送成功、情绪定性一句、半日关键数字 3-5 行。
