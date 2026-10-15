#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$PATH"
series_ids="${1:?用法：bash scripts/run-batch.sh 6939,8183,8045,6979,6910}"
if [[ ! "$series_ids" =~ ^[0-9]+(,[0-9]+)*$ ]]; then echo '车系列表必须是逗号分隔的整数ID'; exit 1; fi
shift
skip_images=false
no_exclusions=false
for option in "$@"; do
  case "$option" in
    --no-company-exclusions) no_exclusions=true ;;
    --skip-images) skip_images=true ;;
    *) echo "未知参数：$option"; exit 1 ;;
  esac
done
command -v bun >/dev/null || { echo '请先安装Bun并加入PATH'; exit 1; }
command -v lark-cli >/dev/null || { echo '请先安装lark-cli并登录shengxu profile'; exit 1; }
run=".vehicle-crawler-runs/batch-$(date +%Y%m%d-%H%M%S)-$$"
cli() { bun scripts/vehicle-crawler/cli.ts "$@"; }
echo "本次明确选择：${series_ids}；只同步现有试验表。"
echo "运行记录：$PWD/$run"
mkdir -p "$run"
git rev-parse HEAD > "$run/git-commit.txt" 2>/dev/null || true
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$run/started-at.txt"
echo "来源请求：串行；请求完成后间隔至少${CRAWLER_REQUEST_INTERVAL_MS:-5000}毫秒；遇访问限制停止。"
echo '[1/7] 联网发现在售目录（只读目录）'
cli discover "$run"
echo '[2/7] 确定本批排除范围'
if [[ "$no_exclusions" == true ]]; then
  echo '按显式参数跳过公司前115行排除'
  bun -e 'await Bun.write(process.argv[1],JSON.stringify({complete:true,series_ids:[],reason:"Explicit --no-company-exclusions"}))' "$run/exclusions.json"
else cli exclusions "$run"; fi
echo '[3/7] 检查并选择明确车系，禁止自动替换'
cli select "$run" --series-ids "$series_ids" --exclude "$run/exclusions.json"
sleep "$(( (${CRAWLER_REQUEST_INTERVAL_MS:-5000} + 999) / 1000 ))"
echo '[4/7] 采集选定车系参数（--skip-images时跳过图库）'
if [[ "$skip_images" == true ]]; then cli collect "$run" --skip-images; else cli collect "$run"; fi
echo '[5/7] 映射字段、对比现值、规划必要图片及来源信息'
cli reference "$run"
sleep "$(( (${CRAWLER_REQUEST_INTERVAL_MS:-5000} + 999) / 1000 ))"
if [[ "$skip_images" == true ]]; then cli plan "$run" --skip-images; else cli plan "$run"; fi
echo '[6/7] 同步选定试验记录，非空业务/参数值保留'
cli apply "$run"
echo '[7/7] 回读参数、关系、公式、附件，输出逐字段中文审计'
cli verify "$run"
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$run/finished-at.txt"
echo "完成。同步是否通过：$PWD/$run/verification.json"
echo "字段完整程度及缺项原因：$PWD/$run/字段质量报告.md"
echo "逐字段来源原值与实际值：$PWD/$run/field-audit.csv"
