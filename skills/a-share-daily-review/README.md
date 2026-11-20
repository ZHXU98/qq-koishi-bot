# skills/a-share-daily-review

A 股每日复盘 skill 的**仓库内真源**。WorkBuddy 运行时从 `~/.workbuddy/skills/a-share-daily-review/` 加载，
两者内容保持一致，由 `scripts/install-skills.sh` 同步。

## 为什么放在仓库里

重装系统 / 换电脑 / 新克隆仓库后，不用再问 AI「上次那套 skill 呢」——clone 下来跑一条命令就装回去了。

```bash
git clone https://github.com/ZHXU98/qq-koishi-bot.git
cd qq-koishi-bot
bash scripts/install-skills.sh          # 装到 ~/.workbuddy/skills/
```

改了 skill 想推回仓库：

```bash
bash scripts/install-skills.sh --from-runtime   # 反过来，把运行时的改动拉回仓库
git add skills/ && git commit -m "chore(skill): ..." && git push
```

## 目录

```
skills/a-share-daily-review/
├── SKILL.md                     # 主文件：路径一～七（路径六含盘前版/竞价版）、数据采集命令、硬约束
├── references/
│   ├── house_style.md           # ★ 本项目报告风格 DNA（不是模板）
│   ├── html_report_style.md     # HTML 输出规范（版式自由 + 三条硬约束）
│   ├── hotspot_report_template.html  # 路径五热点速览模板（唯一套模板的地方）
│   ├── report-template.md       # 涨停章节内容结构参考
│   ├── hotspot-prompts.md       # 晚间/涨价/专题提示词
│   ├── data-sources.md          # 可信 skill 命令一览
│   └── api_reference.md         # 数据查询参考
└── examples/                    # 2026-11-20 四份真实成品 + 11-19 盘后表格版参照图；只看手法不抄结构
```

## 和仓库其它部分的关系

| 目录 | 职责 |
|---|---|
| `skills/a-share-daily-review/`（本目录） | 生成报告：取数、分析路径、风格规范 |
| `a-share-report/` | 把 HTML 渲染成 PNG 并推到 QQ（`push_report.js`），另含 `SKILL.md`（推送 skill） |
| `automations/` | 四个定时任务的完整配置（rrule + prompt），重装后按它重建 |

闭环：`automations/` 定时触发 → 本 skill 生成 HTML → `a-share-report/push_report.js` 渲染推送 → QQ。

## 运行时依赖

- **westock CLI**：`~/.local/bin/westock`（不在默认 PATH，命令前需 `export PATH="$HOME/.local/bin:$PATH"`）
- **neodata-financial-search**：日经225 等 westock 未覆盖的数据；token 12h 过期，走 `connect_cloud_service` 续
- **Node.js ≥ 18** + 本机 Chrome：`push_report.js` 渲染
- **WorkBuddy**：`wb-finance-skill` 提供方法论与红线

## 四个时段对应的路径

| 时段 | 路径 | 产出特征 |
|---|---|---|
| 08:10 早盘 | 路径六 · 盘前版 | 昨日关注清单逐条检验 + 预判，1-2 屏 |
| 09:30 开盘 | 路径六 · 竞价版 | 竞价缺口 + 外盘对账，1 屏 |
| 11:40 午盘 | 路径七 | 风向五问：钱从哪来/强弱两端/主线切换/热度错位/风格切换，2-3 屏 |
| 16:00 盘后 | 路径一（技术面三维） | 全维复盘 + 次日关注清单，3-5 屏 |

## 改 skill 的原则

1. 先改本目录，再 `install-skills.sh` 推到运行时——**仓库是源，运行时是副本**
2. 风格类改动写进 `references/house_style.md`，不要写进 `SKILL.md` 正文的硬规则里
3. 不要把某一次报告的版式固化成模板；要固化的是「必讲要素」和「气质」
4. 数据源口径（哪些命令、哪些代码）可以写死；分析结论和排版不要写死
