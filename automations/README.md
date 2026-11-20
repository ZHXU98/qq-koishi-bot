# automations —— 四个 A 股定时任务的配置备份

WorkBuddy 的定时任务存在本机应用数据里，**换电脑 / 重装系统就没了**。这里存它们的完整配置（rrule + prompt 全文），
clone 仓库后照着重建即可，不用重新想一遍 prompt。

## 四个任务

| 时间（周一至周五） | 名称 | 输出 | prompt 源文件 | 现役 ID |
|---|---|---|---|---|
| 08:10 | A股早盘（外盘映射 + 昨日复盘对照） | `a-share-report/reports/A股-<日期>-早盘.html` | `prompts/premarket.md` | `8a14e451-d934-489f-b0e5-a2e926fb803d` |
| 09:30 | A股开盘（外盘映射 + 昨日结论验证） | `...-开盘.html` | `prompts/open.md` | `218dce67-3a77-471d-983b-ca9eb944ec13` |
| 11:40 | A股午盘（含情绪速览） | `...-午盘.html` | `prompts/midday.md` | `4262ae61-4331-4cee-bda3-c3631c246cb7` |
| 16:00 | A股盘后复盘（含情绪分析） | `...-复盘.html` | `prompts/close.md` | `012b69df-d586-450f-9ae9-346d8ca0d52a` |

统一规则：仅工作日跑；先判交易日，休市不推送；数据只走 westock / neodata；报告生成后经
`a-share-report/push_report.js` 渲染成图推到 QQ 私聊（目标在 `a-share-report/push_targets.json`，已 gitignore）。

## 文件

```
automations/
├── README.md
├── a-share-premarket.json   # 元信息 + prompt 全文（机器可读，含现役 id）
├── a-share-open.json
├── a-share-midday.json
├── a-share-close.json
└── prompts/
    ├── premarket.md         # prompt 原文（人读/编辑用，json 由它生成）
    ├── open.md
    ├── midday.md
    └── close.md
```

`prompts/*.md` 是**源**，`*.json` 里的 `prompt` 字段是它的快照。改 prompt 先改 md，再跑：

```bash
python3 scripts/sync-automations.py     # 用 prompts/*.md 重新生成 *.json
```

## 重装后怎么恢复

1. clone 仓库，`bash scripts/install-skills.sh`（把 skill 装回 `~/.workbuddy/skills/`）
2. `cp a-share-report/push_targets.json.example a-share-report/push_targets.json`，填入 QQ 号
3. 起服务：`docker compose up -d`，确认 `curl -s http://127.0.0.1:3100/bindings` 有 owner
4. 让 Agent 按 `automations/*.json` 重建四个任务（告诉它这句话就行）：

   > 读 `automations/` 下的 4 个 json，按里面的 name / rrule / prompt 用 automation 工具重建四个定时任务，
   > 工作目录填当前仓库根目录，建完列出新 ID。

5. 重建后把新 ID 回写到 json 的 `id` 字段（旧 ID 只在本机有效，换机后失效）

## 改任务时的约定

- **prompt 里不写绝对路径**：cwd 就是仓库根，报告、skill、脚本一律用相对路径，换机才不用改
- **skill 引用项目内路径**：`skills/a-share-daily-review/SKILL.md`，运行时副本只在没仓库时兜底
- **风格不写死在 prompt 里**：讲要素，不讲版式；风格基准指向 `references/house_style.md`
- 改完 prompt 要同时更新运行中的任务，否则下一次触发的还是旧 prompt
