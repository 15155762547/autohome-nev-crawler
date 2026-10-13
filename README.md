# 汽车之家在售新能源采集工程

个人独立工程，使用 Bun。首轮验收限定 **100 个车系**，排除公司表默认视图前115行涉及的车型，覆盖 BEV/PHEV/EREV。程序自动发现实时清单，随后必须选择明确数量，再采集、映射、同步和回读。863 是截图基准，不是运行上限或默认采集数量。

## 复用与边界

核心规则移植自已有 `vehicle-crawler-es8/mapping.py`、`batch50.py`、`enrich50.py` 与 `collect_sources.py`：动态 titleid、空 itemname 的 sublist、标配/选装区分、统一配置值、人民币指导价与 USD=CNY/6.74、series/spec 别名匹配、缺值补写、附件内容哈希、真实 record_id 关联和回读验收。原50批次/22官网/单ES8断言没有移入新工具。

`lib/vehicle-catalog-source.ts` 是来源类型和领域规则的唯一入口。`scripts/vehicle-crawler/collect.ts` 负责网站取数与图片校验，`feishu.ts` 负责唯一授权试验表，`cli.ts` 是命令入口。

公开名称保留来源中文，不猜英文名称。新行可用于内部试验；业务状态、推荐、人工报价、路由、营销文案和翻译关联不由采集器填写。原有非空值保留，差异进计划的 `conflicts`；复选框默认 false 在明确来源支持时可补为 true。未披露、条件不同或不适配枚举的值保持空白，配置原文保存在摘要和原始响应。

## 运行

### 现场演示：只爬理想 MEGA

本机在仓库目录执行 `bash scripts/run-one-mega.sh`。脚本每次生成新目录、重新联网读取目录和 MEGA 参数，只选择车系6939，随后规划、同步现有试验表并回读。终端显示7个步骤和抓到的价格、续航、电池、电机数据。目录发现会读取全部在售目录，实际参数采集只涉及MEGA。需要下文的Bun依赖和飞书登录。

已有MEGA记录会复用，非空值和附件保留，因此“新增0/上传0”可能是正常结果；这不代表没有重新抓取网站。配置来源ID为78129；可在试验表搜索MEGA。旧记录使用MDL-155；删除后重新采集会生成AUT-6939-2026-BEV，并使用来源中文名理想MEGA，旧翻译和公司文案不会自动恢复。高压平台（V）按来源同值映射至voltage_platform_v。没有来源的字段、业务字段仍不强填。每次运行结束打印独立证据目录。

底层也支持 `select RUN_DIR --count 1 --series 6939 --exclude EXCLUSIONS_FILE`，只能选择实时发现且不在排除清单中的一个车系。

准备 Bun 及项目依赖、安装并登录 lark-cli 的 `shengxu` profile。认证由 CLI 管理；本工程不保存 token。唯一可写目标在 `feishu.ts` 的 `LAB`，当前为 [车型试验Base](https://ecn4k98ibq2i.feishu.cn/base/EB60b9omTaMyZzsJ273cKdL8nkb)。生产表和其他表会被代码拒绝。表结构不由本工具修改；部署前应先建好对应 models/trims 字段。

在仓库根目录执行（只需要本项目依赖与已登录的 lark-cli）：

```sh
bun install --frozen-lockfile
bun scripts/vehicle-crawler/cli.ts discover .vehicle-crawler-runs/run-20261013
bun scripts/vehicle-crawler/cli.ts exclusions .vehicle-crawler-runs/run-20261013
bun scripts/vehicle-crawler/cli.ts select .vehicle-crawler-runs/run-20261013 --count 100 --exclude .vehicle-crawler-runs/run-20261013/exclusions.json
bun scripts/vehicle-crawler/cli.ts collect .vehicle-crawler-runs/run-20261013
bun scripts/vehicle-crawler/cli.ts plan .vehicle-crawler-runs/run-20261013
bun scripts/vehicle-crawler/cli.ts apply .vehicle-crawler-runs/run-20261013
bun scripts/vehicle-crawler/cli.ts verify .vehicle-crawler-runs/run-20261013
```

新采集用新目录。`exclusions` 只读公司前115行、关联配置和公开来源，从明确 URL/来源备注提取车系ID。源配置只有 spec ID 时解析它的网页元数据；来源名称不一致时不猜译名；无法精确识别的海外车型在本批次保守避开其已核实品牌，并在排除证据里说明。它不写公司表。`select` 必须指定数量与已核实排除文件；缺少选择清单、改变清单或改变排除范围会阻止采集/写入。

有来源失败时默认禁止规划，重跑 `collect` 可恢复已成功的车系。首轮100车系验收额外避开已观察到缺来源的车系；所有排除原因留在本地证据。选择同步成功部分时，显式给 `plan` 加 `--allow-partial`，结果仍标注失败，不能称为100全部通过。`--skip-images` 仅用于参数诊断。以后增加数量用新的运行目录与新的显式选择清单，不改采集规则。

`discover/exclusions/select/collect/plan` 不写飞书；`apply` 写选定车系的试验数据；`verify` 只读回。每次 `plan` 读取当前字段、数据版本和全部分页，不依赖旧50行快照。写前再次检查 schema/revision，批次串行写；附件检查具体目标格是否仍为空，上传后有界等待回读，不把自身异步版本变化当成他人编辑。CLI 无原子 compare-and-swap：检查与写入之间仍有小窗口，同批次试验期间请避免多人编辑目标记录。

部分成功或上传回执不完整时，先读取现场，再运行 `plan`，不要盲目重复旧 `apply`。新计划按实际存在的 records/attachments 去重；旧计划、同步与验收记录进入 `history/`。发现原配置消失或现有父子关联不一致不删除旧行。

## 数据口径与验收

- 发现接口来自 `/price/ev` 页面发布代码：`searchtype=6,state=2,orderid=0,pagesize=20`；逐页直到网站总数，核对唯一 series ID。列表状态码20和30都可能在该筛选中出现，不自行推断状态码意义。
- 在售配置来自 `getSpecList` 的同一筛选，逐车系核对列表 specids。参数页额外配置不入库；参数接口未返回列表配置时记录失败。混合车系中的非 BEV/PHEV/EREV 配置单列排除。
- 新模型按 series/year/energy 分组。原 AUT/MDL 配置按 series/spec 匹配，保留已有父模型；父模型跨年款时只采用各组共同标量，不把不同值合成一个数。车型行数不等于车系数。
- 每个目标字段有映射/公式/业务保护/缺来源或条件不同的处置说明。所有参数标题与原始选项保留，空值不推算；配置指导价与人工展示报价分开。
- 图库必须返回同一 series，并匹配已采集 spec。照片在原年款/配置范围内挑选最多两张外观和一张内饰，验证 MIME、解码、尺寸和 SHA256，再通过附件专用操作上传；已有附件保留。当前图库响应未返回准确配置照片则报告缺口，不据此声称整个网站没有照片。
- 回读检查写入字段、自定义文本主字段、原非空值、双向关联、附件和可计算的数值公式。缺输入/缺返回的公式单列，不算已计算。重复 `plan → apply → verify` 应为0新增、0更新、0上传。

本地 `.vehicle-crawler-runs/` 包含发现原文、来源 URL/时间/哈希、每个车系快照、失败清单、计划、CLI回执及验收。整个目录被 Git 忽略，不提交飞书记录导出或上传 token。`plan.json.pending` 是逐字段处置记录，不是员工操作界面。

自动测试：

```sh
bun test
bun run check
```

网页接口无稳定性保证。失败、候选冲突、排除配置及缺照片是可审计结果，不能包装成所有字段已齐或可直接发布网站。
