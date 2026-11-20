#!/usr/bin/env python3
"""用 automations/prompts/*.md 重新生成 automations/*.json 里的 prompt 字段。

改 prompt 的流程：先编辑 md，再跑这个脚本，json 保持同步（id / rrule / 输出路径等元信息不动）。

    python3 scripts/sync-automations.py            # 生成
    python3 scripts/sync-automations.py --check    # 只检查是否已同步（CI/提交前用）
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
AUTO = ROOT / "automations"

# json 文件名 -> prompt 源文件
MAPPING = {
    "a-share-premarket.json": "premarket.md",
    "a-share-open.json": "open.md",
    "a-share-midday.json": "midday.md",
    "a-share-close.json": "close.md",
}


def main() -> int:
    check_only = "--check" in sys.argv
    dirty = []

    for json_name, prompt_name in MAPPING.items():
        json_path = AUTO / json_name
        prompt_path = AUTO / "prompts" / prompt_name
        if not json_path.exists():
            print(f"✗ 缺少 {json_path.relative_to(ROOT)}")
            return 1
        if not prompt_path.exists():
            print(f"✗ 缺少 {prompt_path.relative_to(ROOT)}")
            return 1

        data = json.loads(json_path.read_text(encoding="utf-8"))
        prompt = prompt_path.read_text(encoding="utf-8").strip() + "\n"

        if data.get("prompt") == prompt:
            print(f"· {json_name} 已同步")
            continue

        dirty.append(json_name)
        if check_only:
            print(f"! {json_name} 与 {prompt_name} 不一致")
            continue

        data["prompt"] = prompt
        data["prompt_file"] = f"automations/prompts/{prompt_name}"
        json_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"✓ {json_name} 已按 {prompt_name} 更新")

    if check_only:
        if dirty:
            print("\n有未同步的 prompt：先跑 python3 scripts/sync-automations.py")
            return 1
        print("\n全部已同步")
    elif dirty:
        print("\n提示：json 只是备份。运行中的任务还需用 automation 工具更新 prompt，否则触发的仍是旧版。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
