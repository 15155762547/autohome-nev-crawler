# 汽车之家在售新能源采集工程

个人独立工程，使用Bun，覆盖BEV/PHEV/EREV。当前按明确指定的车系小批次采集，随后映射、同步试验表并回读。本轮5车系跳过公司前115行排除，暂不采集图片；不默认启动全量。863是历史截图基准，实时目录总数可能变化。

## 同事复刻：当前5车系慢速批次

本项目在本地执行GitHub仓库中的代码，不是GitHub服务器代跑。源码、依赖锁文件、启动脚本和测试都在仓库；来源快照和飞书导出不公开提交。请使用同一提交复现算法；实时网站内容变化时不保证记录数或参数完全相同。

```sh
git clone --branch codex/first100 https://github.com/15155762547/autohome-nev-crawler.git
cd autohome-nev-crawler
bun install --frozen-lockfile
bun run check
bun test
bash scripts/run-batch.sh 6939,8183,8045,6979,6910 --no-company-exclusions --skip-images
```

前提：安装Bun、lark-cli，按CLI登录说明配置`shengxu`用户身份，且本人有公司目录读取及现有试验Base写入权限。仓库不包含登录凭据。同步目标明确绑定现有试验Base，不能直接当成任意飞书表通用工具；切换目标需要相同schema、明确授权及代码中的目标校验适配。只有公开数据采集阶段不依赖飞书登录。

以上命令明确跳过公司前115行排除，采集5个指定车系的当前在售配置；图片阶段跳过。它不会纳入海鸥，也不会清空已有车型。没有明确配置ID映射的公司记录会报错，不按名称猜配。新批次的`git-commit.txt`记录使用的代码提交。

所有汽车之家及图片请求统一串行，每次响应完成后至少间隔5秒；可用`CRAWLER_REQUEST_INTERVAL_MS=10000`放慢到10秒，允许范围5000～60000。HTTP401/403/429、已识别的验证码/访问限制页面会终止后续请求，不自动重试；502/503/504及网络超时最多尝试3次，仍遵守间隔。停止后先看错误证据，不用代理或验证码绕过继续跑。单次进程内暂停状态不会自动解除；新进程不等于已经获得恢复许可，不应反复启动撞限制。

当前`discover`仍读取完整目录分页（只读），以第一页实时目录API总数为基准，核对其后每页总数稳定及全部ID唯一；页面与API总数不同时保留差异证据，不把页面总数当作实时数量。`collect`只抓指定5个车系参数。`--skip-images`同时跳过图库请求与附件上传。这个节奏用于控制负载，不能保证不触发站方风控；全量用时需要根据实测请求数、配置数、飞书同步时间和暂停情况估计。

## 复用与边界

核心规则移植自已有 `vehicle-crawler-es8/mapping.py`、`batch50.py`、`enrich50.py` 与 `collect_sources.py`：动态 titleid、空 itemname 的 sublist、标配/选装区分、统一配置值、人民币指导价与 USD=CNY/6.74、series/spec 别名匹配、缺值补写、附件内容哈希、真实 record_id 关联和回读验收。原50批次/22官网/单ES8断言没有移入新工具。

`lib/vehicle-catalog-source.ts` 是来源类型和领域规则的唯一入口。`scripts/vehicle-crawler/collect.ts` 负责网站取数与图片校验，`feishu.ts` 负责唯一授权试验表，`cli.ts` 是命令入口。

按series/spec匹配公司目录成功时复用其英文名称和产品身份，来源中文原名保留在快照和备注，不猜译名。新行可用于内部试验；业务状态、推荐、人工报价、路由、营销文案和翻译关联不由采集器填写。原有非空业务及参数值保留，差异进计划的 `conflicts`；复选框默认 false 在明确来源支持时可补为 true。未披露、条件不同或不适配枚举的值保持空白，配置原文保存在摘要和原始响应。

## 运行

### 5车系质量验收与通用批次

```sh
bash scripts/run-batch.sh 6939,8183,8045,6979,6910
```

依次采集MEGA、理想i6、乐道L90、魏牌蓝山、理想L8。脚本要求显式ID，不提供默认全量范围；每次使用独立目录重新联网采集。指定车系必须在实时目录且不在排除范围内，失败不自动换车。底层选择命令：

```sh
bun run crawler select RUN_DIR --series-ids 6939,8183,8045,6979,6910 --exclude RUN_DIR/exclusions.json
```

`--series-ids` 与 `--count/--series` 互斥；原来的单车/按数量选择继续可用。成功回读后生成 `field-audit.csv`、`field-audit.json` 和 `字段质量报告.md`，覆盖实时schema全部字段、每个模型与具体配置，记录中文含义、实际值、候选值、分类、来源URL、来源原始单元格和处理规则。附件审计不输出file_token。未知新增字段标记“代码未覆盖”；false家庭充电不当作不支持。

程序维护的配置来源核验时间与状态、模型来源摘要/核验时间/核验状态、审计备注允许按当前来源更新；原备注在有起止标记的审计段之外保留。`last_synced_at`只在目标模型或其配置/附件成功发生变更后更新，保留原始来源采集时间。相同来源快照复跑不因为当前时间或备注重复追加制造更新。新来源采集时间可以引起元数据更新，这与同快照复跑的0变更不同。

图片支持车系`picinfo`与配置`speclist[].piclist`两种结构。每组图库候选不足时补查匹配在售spec的外观/内饰页面，满足2外观+1内饰即停止；已有附件保留，不替换不追加。图库请求/解析错误写入`series-*.json.image_errors`，图片下载错误写入`plan.json.pending.image_error`。参数采集成功与图片充足分别报告；当前CLI不会把缺图片当作参数请求失败，也不能据`ok=true`断言图片和所有字段齐全。


### 现场演示：只爬理想 MEGA

本机在仓库目录执行 `bash scripts/run-one-mega.sh`。脚本每次生成新目录、重新联网读取目录和 MEGA 参数，只选择车系6939，随后规划、同步现有试验表并回读。终端显示7个步骤、配置与图片数量，并输出逐字段来源原值和实际值的审计CSV。目录发现会读取全部在售目录，实际参数采集只涉及MEGA。需要下文的Bun依赖和飞书登录。

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

有来源失败时默认禁止规划，重跑 `collect` 可恢复已成功的车系。首轮100车系验收额外避开已观察到缺来源的车系；所有排除原因留在本地证据。选择同步成功部分时，显式给 `plan` 加 `--allow-partial`，结果仍标注失败，不能称为100全部通过。`--skip-images`可用于本轮参数验收，明确跳过图片阶段。以后增加数量用新的运行目录与新的显式选择清单，不改采集规则。

`discover/exclusions/select/collect/plan` 不写飞书；`apply` 写选定车系的试验数据；`verify` 只读回。每次 `plan` 读取当前字段、数据版本和全部分页，不依赖旧50行快照。写前再次检查 schema/revision，批次串行写；附件检查具体目标格是否仍为空，上传后有界等待回读，不把自身异步版本变化当成他人编辑。CLI 无原子 compare-and-swap：检查与写入之间仍有小窗口，同批次试验期间请避免多人编辑目标记录。

部分成功或上传回执不完整时，先读取现场，再运行 `plan`，不要盲目重复旧 `apply`。新计划按实际存在的 records/attachments 去重；旧计划、同步与验收记录进入 `history/`。发现原配置消失或现有父子关联不一致不删除旧行。

## 数据口径与验收

- 发现接口来自 `/price/ev` 页面发布代码：`searchtype=6,state=2,orderid=0,pagesize=20`；逐页直到网站总数，核对唯一 series ID。列表状态码20和30都可能在该筛选中出现，不自行推断状态码意义。
- 在售配置来自 `getSpecList` 的同一筛选，逐车系核对列表 specids。参数页额外配置不入库；参数接口未返回列表配置时记录失败。混合车系中的非 BEV/PHEV/EREV 配置单列排除。
- 有公司目录参照时，按 series/spec 对齐公司产品身份及分组，可跨年；具体年款保留在配置中。无参照的旧流程按 series/year/energy 分组，不能宣称对齐公司产品目录。父模型跨年款时只采用共同标量，不把不同值合成一个数。车型行数不等于车系数。
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

## 公司目录对齐（钛7）

公司目录参照只读取产品名称、业务编号、展示年款及配置关联，不复制推荐、报价、网站路由等业务内容。按汽车之家 `series/spec` 匹配英文名称和产品分组；钛7插混跨年合并，纯电单独成组。公司缺少对应配置或存在身份歧义时停止，不猜译名或自动换产品。

已有采集目录可重放参数，禁止把重放时间称为重新采集时间：

```sh
bun scripts/vehicle-crawler/cli.ts reference RUN
bun scripts/vehicle-crawler/cli.ts plan RUN --company-reference RUN/company-reference.json --align-existing --skip-images
# 检查 plan.json 后，仅写试验表
bun scripts/vehicle-crawler/cli.ts apply RUN
bun scripts/vehicle-crawler/cli.ts verify RUN
```

`--align-existing` 当前只允许选定钛7（8171），使用独立备份及精确字段清单修正历史值；普通同步继续保护已有非空参数。合并迁移先备份记录、schema、关联及全部附件，重挂配置并回读双向关联，最后仅移除计划中的冗余2026款插混父行。普通写入入口仍不允许删除。中断后直接重试同一 `apply`，会核对原计划、备份哈希与已完成字段，只补剩余步骤；检测到其他编辑则停止。完成后重新 `plan → apply → verify` 验收幂等性。

对于新建或后续正常同步，`reference RUN` 后 `plan RUN --skip-images` 自动读取目录中的参照文件，不需要再次使用迁移开关。通用批次脚本会读取公司参照；若明确要采集公司已有车型，可以使用 `bash scripts/run-batch.sh 8171 --no-company-exclusions`（该命令会联网采集，缓存验收不要执行）。未识别到的公司产品配置会报告缺少映射，不自动用中文名新建重复产品。

参照模式的美元指导价按人民币÷6.74四舍五入到整数，配置按人民币价格升序、同价按spec ID排序。插混四驱必须同时取得双电机和前后布局证据才映射为 `Dual-motor AWD`。公司展示年款不代表全部关联配置的年款，具体年款仍保留在配置名称及原始快照中。未经证实的800V、气囊、质保等不会从公司旧表直接补入。

海鸥单产品纳入预售78508、座位4～5及共享尺寸留空规则，见[海鸥预售配置验收报告](海鸥预售配置验收报告-2026-10-15.md)。使用显式`--upcoming-spec-ids 78508`选择范围，`--refresh-seagull-scope`仅更新本次批准的海鸥共享字段，图片继续跳过。

安全气囊现按所选配置的已披露标配数量逐款计算，并在车型内取最大值；未知配置单列，选装不计入标配。规则、海鸥写入验证及复跑命令见[安全气囊规则验收报告](安全气囊规则验收报告-2026-10-15.md)。此字段按已确认规则更新，其他非空参数和业务值继续保护。
