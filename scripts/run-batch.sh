#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/Users/hjx/.bun/bin:$PATH"
series_ids="${1:?用法：bash scripts/run-batch.sh 6939,8183,8045,6979,6910}"
if [[ ! "$series_ids" =~ ^[0-9]+(,[0-9]+)*$ ]]; then echo '车系列表必须是逗号分隔的整数ID'; exit 1; fi
run=".vehicle-crawler-runs/batch-$(date +%Y%m%d-%H%M%S)-$$"
cli() { bun scripts/vehicle-crawler/cli.ts "$@"; }
echo "本次明确选择：$series_ids；只同步现有试验表。"
echo "运行记录：$PWD/$run"
echo '[1/7] 联网发现在售目录（只读目录）'
cli discover "$run"
echo '[2/7] 只读公司前115行，生成排除证据'
cli exclusions "$run"
echo '[3/7] 检查并选择明确车系，禁止自动替换'
cli select "$run" --series-ids "$series_ids" --exclude "$run/exclusions.json"
echo '[4/7] 抓取参数与匹配配置的外观、内饰图库'
cli collect "$run"
echo '[5/7] 映射字段、对比现值、规划必要图片及来源信息'
cli plan "$run"
echo '[6/7] 同步选定试验记录，非空业务/参数值保留'
cli apply "$run"
echo '[7/7] 回读参数、关系、公式、附件，输出逐字段中文审计'
cli verify "$run"
echo "完成。同步是否通过：$PWD/$run/verification.json"
echo "字段完整程度及缺项原因：$PWD/$run/字段质量报告.md"
echo "逐字段来源原值与实际值：$PWD/$run/field-audit.csv"
