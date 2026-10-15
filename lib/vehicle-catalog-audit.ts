import { empty, meaningful, modelNumbers, trimNumbers, protectedFields, same, selected, reconcile, type Candidate, type Cells } from './vehicle-catalog-source';
import { calculateAirbags } from './vehicle-airbags';
import { fieldLabels } from './vehicle-field-labels';

export type AuditField = { name: string; type: string; options?: { name: string }[] };
export type AuditEntry = { table: 'models' | 'trims'; key: string; field: string; label: string; actual: unknown; candidate: unknown;
  category: string; reason: string; source_url: string; source_fields: string[]; raw: unknown };
export const maintainedFields = new Set(['last_verified_at', 'source_status', 'trim_last_verified_at', 'trim_section_status_pruned',
  'trim_source_summary_pruned', 'review_notes']);
export const calculatedFields = new Set(['airbags']);
export const auditMarker = '\n【爬虫字段审计】\n';
const auditEnd = '\n【爬虫字段审计结束】';
export function auditNotes(existing: unknown, summary: string): string {
  const text = String(existing ?? ''), start = text.indexOf(auditMarker), end = text.indexOf(auditEnd, start);
  return start >= 0 && end >= 0 ? text.slice(0, start) + auditMarker + summary + auditEnd + text.slice(end + auditEnd.length) : text + auditMarker + summary + auditEnd;
}
export function reconcileMaintained(old: Cells | undefined, desired: Cells) {
  const result = reconcile(old, desired);
  result.conflicts = result.conflicts.filter(c => !maintainedFields.has(c.field));
  for (const field of maintainedFields) if (!empty(desired[field]) && !same(old?.[field], desired[field])) result.patch[field] = desired[field];
  for (const field of calculatedFields) if (typeof desired[field] === 'number') {
    result.conflicts = result.conflicts.filter(c => c.field !== field);
    if (!same(old?.[field], desired[field])) result.patch[field] = desired[field];
  }
  return result;
}
const fields: Record<string, string[]> = {
  ...Object.fromEntries(Object.entries({ ...modelNumbers, ...trimNumbers }).map(([k, v]) => [k, [v]])),
  MODEL: ['车系名称'], model: ['车系名称'], brand: ['品牌'], model_year: ['车型名称'], powertrain_type: ['能源类型'], vehicle_class: ['级别'],
  trim: ['车型名称'], trim_price_rmb: ['厂商指导价(元)'], trim_price_display: ['厂商指导价(元)'],
  seats_min: ['座位数(个)'], seats_max: ['座位数(个)'], top_speed_min_kmh: ['最高车速(km/h)'], top_speed_max_kmh: ['最高车速(km/h)'],
  sunroof_availability: ['天窗类型'], v2l_availability: ['对外放电'], ac_slow_charge_supported: ['慢充接口位置', '电池慢充时间(小时)'],
  ac_slow_charge_full_time_hours: ['电池慢充时间(小时)', '电池慢充电量范围(%)'],
  battery_warranty_years: ['电池组质保', '三电系统质保'], battery_warranty_distance_km: ['电池组质保', '三电系统质保'],
  battery_chemistry: ['电池类型'], drivetrain_display: ['驱动方式'], dc_fast_charge_supported: ['快充功能'],
  dc_fast_charge_min_percent: ['电池快充电量范围(%)'], dc_fast_charge_max_percent: ['电池快充电量范围(%)'],
  charging: ['电池快充时间(小时)', '电池快充电量范围(%)', '电池慢充时间(小时)', '电池慢充电量范围(%)'],
  airbags: ['主/副驾驶座安全气囊', '前/后排侧气囊', '前/后排头部气囊(气帘)', '前排中间气囊', '后排座椅防下滑气囊'],
  battery_technology: ['电池类型', '电池特有技术'], household_charging: ['慢充接口位置'],
};
const formulaInputs: Record<string, string> = { guide_price: 'trim_price_display', battery_capacity: 'battery_capacity_kwh', cltc_range: 'range_display',
  motor_torque: 'motor_torque_n_m', motor_power: 'motor_power_kw', battery_chemistry_auto: 'battery_chemistry', drivetrain_display_auto: 'drivetrain_display' };
const programFields = new Set(['model_id', 'record_id', 'trim_config_id', 'trim_order', 'vehicle_model_pruned', 'trim_configurations_pruned',
  'source_url', 'last_synced_at', 'notes', ...maintainedFields]);
const imageFields = new Set(['brochure_cover', 'image_url', 'gallery_images_json']);
const transformed = new Set(['model_year', 'powertrain_type', 'trim_price_rmb', 'trim_price_display', 'sunroof_availability', 'v2l_availability', 'charging',
  'battery_chemistry', 'drivetrain_display', 'battery_warranty_years', 'battery_warranty_distance_km', 'seats_min', 'seats_max', 'top_speed_min_kmh', 'top_speed_max_kmh']);

export function auditField(table: 'models' | 'trims', key: string, field: AuditField, actual: unknown, candidate: unknown,
  group: Candidate, sourceUrl: string, specId?: number, imageReason?: string): AuditEntry {
  const input = field.type === 'formula' ? formulaInputs[field.name] ?? formulaInputs[field.name.replace(/_(min|max)_.+_auto$/, '')] : undefined;
  const evidence = (group.evidence.groups ?? [group.evidence]) as Record<string, unknown>[];
  const index = evidence[0]?.title_index as Record<string, number> | undefined;
  const names = field.name === 'airbags' ? Object.keys(index ?? {}).filter(n => /气囊|气帘/.test(n)) : ['common_features_json_pruned', 'base_spec_summary_json'].includes(field.name) ? Object.keys(index ?? {}) : fields[input ?? field.name] ?? [];
  const specs = evidence.flatMap(e => e.specs as { spec_id: number; raw: any[] }[] ?? []).filter(s => group.trims.some(t => t.spec_id === s.spec_id) && (specId === undefined || s.spec_id === specId));
  const raw: unknown = names.length ? specs.map(s => ({ spec_id: s.spec_id, values: Object.fromEntries(names.map(n => [n,
    n === '车型名称' ? index ? selected({ paramconflist: s.raw }, index, n) : group.trims.find(t => t.spec_id === s.spec_id)?.fields.trim : n === '车系名称' ? group.model.MODEL : n === '品牌' ? group.model.brand :
      { value: index ? selected({ paramconflist: s.raw }, index, n) : '', cell: s.raw.find(c => c.titleid === index?.[n]) ?? null }])) })) : null;
  const present = !empty(actual) && !(field.type === 'checkbox' && actual === false), mapped = !empty(candidate);
  let category: string, reason: string;
  if (field.type === 'formula') {
    category = '公式'; reason = present ? '飞书从关联配置计算；不是来源网站直接给出的汇总值。数值/关联由 verify 核验。' :
      `关联配置输入${input ?? ''}或公式结果缺失，不当作已计算。${input === 'range_display' ? '不以WLTC或油电综合续航替代CLTC。' : ''}`;
  } else if (field.name === 'i18n_translations') {
    category = '程序转换'; reason = '需要已确认的翻译记录，再由程序关联；不编造记录ID。';
  } else if (protectedFields.has(field.name)) {
    category = '公司业务'; reason = '公司决定推荐、报价、版本、文案、分组或网站规则；已有值保留。目录status不是来源在售状态。';
  } else if (imageFields.has(field.name)) {
    category = '公开事实'; reason = imageReason ?? (present ? '保留已有图片；本次不替换或重复上传。来源身份需由图片记录核对。' : '当前查询没有足量匹配照片；不借用其他配置。');
  } else if (programFields.has(field.name)) {
    category = '程序转换'; reason = mapped || present ? '由程序生成身份、关联、来源时间或核验摘要；缓存重放保留来源采集时间。' : '程序字段尚未产生值，不属于公司手填参数。';
  } else if (['common_features_json_pruned', 'base_spec_summary_json'].includes(field.name)) {
    category = '程序转换'; reason = '来源参数/装备的结构化摘要；不等于来源网站原文段落。';
  } else if (field.name === 'household_charging') {
    category = '条件不明确'; reason = '慢充接口不能证明家庭墙盒/出口充电器条件。未勾选false不是已核实不支持。';
  } else if (field.name === 'steering_setup') {
    category = '条件不明确'; reason = present ? '保留旧左/右舵核验；文字参数接口不提供方向盘位置，本次未新增视觉核验。' : '需核对对应配置的驾驶舱照片或手册；不根据国别猜。';
  } else if (field.name === 'battery_technology') {
    const known = specs.filter(s => index && selected({ paramconflist: s.raw }, index, '电池特有技术') === '刀片电池').length;
    category = mapped ? '程序转换' : known ? '条件不明确' : '来源未披露';
    reason = mapped ? '来源明确刀片电池，映射为已有枚举Blade。' : `本组${specs.length}款中${known}款明确刀片电池；并非全部配置都已披露同一技术，共享字段留空。化学类型LFP不能代替结构技术证据。`;
  } else if (field.name === 'airbags') {
    const calculations = specs.map(s => ({ spec_id: s.spec_id, ...calculateAirbags({ paramconflist: s.raw }, index ?? {}) }));
    const known = calculations.filter(c => c.count !== null), unknown = calculations.filter(c => c.count === null);
    category = mapped ? '程序转换' : '条件不明确';
    reason = `按用户确定的规则，取所选配置已披露标配气囊计算数的最大值；不代表全系每款都有这个数量，也不代表厂家直接公布总数。` +
      `共${known.length}款可计算，${unknown.length}款未知${unknown.length ? `（${unknown.map(c => c.spec_id).join(',')}）` : ''}。` +
      (known.length ? `逐款：${known.map(c => `${c.spec_id}=${c.count}`).join('；')}。` : '本组没有可计算配置，留空，不填0。') +
      '主副驾各1；每排左右侧气囊2；左右贯穿气帘共2；前排中间1；选装不计入标配。未知配置不参与最大值，不借用其他车型或出口版。';
  } else if (mapped) {
    category = transformed.has(field.name) ? '程序转换' : '公开事实';
    reason = field.name === 'trim_price_display' ? '人民币指导价÷6.74，保留两位小数；不是公开美元报价。' :
      field.name === 'trim_price_rmb' ? '来源报价的“万”按×10000换算为人民币元；原始字符串见来源原值。' :
      table === 'models' && names.length ? '依据来源值映射；车型标量要求同组配置一致，范围字段取最小/最大值。' : '依据对应在售配置的来源值和字段定义映射。';
  } else if (names.length) {
    const values = specs.flatMap(s => names.map(n => index ? selected({ paramconflist: s.raw }, index, n) : '')).filter(meaningful);
    const knownSpecs = specs.filter(s => names.some(n => index && meaningful(selected({ paramconflist: s.raw }, index, n)))).length;
    category = values.length ? knownSpecs < specs.length ? '条件不明确' : field.type === 'select' ? '枚举不适配' : '条件不明确' : '来源未披露';
    reason = !values.length ? `本次对应配置没有返回有效的${names.join('、')}；不是全网不存在，也不是业务人员猜填。` :
      knownSpecs < specs.length ? `本组${specs.length}款中${knownSpecs}款返回有效${names.join('、')}，其余未披露；已有参数仅适用于有证据的配置，不能推广到全组。` :
      table === 'models' && new Set(values).size > 1 ? `本组${names.join('、')}存在不同值：${[...new Set(values)].join('/')}；单值字段不能表达差异，各配置原值保留在摘要中。` :
      field.type === 'select' ? `来源${names.join('、')}返回${[...new Set(values)].join('/')}，没有已核实的目标枚举映射，不猜填电机布局/结构类型。` :
      field.name === 'ac_slow_charge_full_time_hours' ? '未同时获得慢充时长与明确0–100%电量窗口，不推算全充时间。' :
        '来源存在值，但同组不同、单位/条件不明确或当前解析不接受该格式；原值保留，待核对。';
    if (field.name === 'range_display' && !values.length) reason += ' 不以WLTC或油电综合续航替代CLTC。';
  } else {
    category = '代码未覆盖'; reason = '当前字段没有已实现且已核实的自动映射；不是来源缺失的证明。';
  }
  if (present && mapped && !same(actual, candidate) && !maintainedFields.has(field.name) && !calculatedFields.has(field.name)) reason += ' 当前非空值与候选不同，保留现值并列出差异，可能是翻译/取整或事实差异。';
  if (present && !mapped && !programFields.has(field.name) && field.type !== 'formula' && !protectedFields.has(field.name)) reason += ' 当前值为历史保留，不宣称本次重新核实。';
  return { table, key, field: field.name, label: fieldLabels[field.name] ?? field.name, actual: actual ?? null, candidate: candidate ?? null, category, reason,
    source_url: category === '公司业务' || category === '代码未覆盖' || field.name === 'i18n_translations' ? '' : sourceUrl, source_fields: names, raw };
}

export function csvAudit(entries: AuditEntry[]): string {
  const quote = (v: unknown) => '"' + (typeof v === 'string' ? v : JSON.stringify(v ?? null)).replace(/"/g, '""') + '"';
  const labels = ['表', '业务键', '字段', '中文含义', '实际值', '映射候选', '分类', '原因/转换规则', '来源URL', '来源字段', '来源原值'];
  return '\uFEFF' + labels.map(quote).join(',') + '\n' + entries.map(e => [e.table, e.key, e.field, e.label, e.actual, e.candidate,
    e.category, e.reason, e.source_url, e.source_fields, e.raw].map(quote).join(',')).join('\n') + '\n';
}
