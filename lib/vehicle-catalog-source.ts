/** Rules reused from vehicle-crawler-es8/mapping.py and batch50.py, without cohort assertions. */
import { z } from 'zod';

export type Cells = Record<string, unknown>;
const parameterCell = z.object({ titleid: z.number(), itemname: z.string().nullable().optional(),
  sublist: z.array(z.object({ name: z.string(), value: z.string() })).nullable().optional() });
export const parametersSchema = z.object({
  bread: z.object({ seriesid: z.number(), seriesname: z.string(), brandname: z.string() }),
  titlelist: z.array(z.object({ items: z.array(z.object({ itemname: z.string(), titleid: z.number() })) })),
  datalist: z.array(z.object({ specid: z.number(), specname: z.string(), specstatus: z.number(), paramconflist: z.array(parameterCell) })),
});
export const listingSchema = z.object({ seriescount: z.number().int().nonnegative(),
  seriesgrouplist: z.array(z.object({ seriesid: z.number().int(), seriesname: z.string(), seriesstate: z.number(), specids: z.array(z.number()) }).passthrough()) });
export type Listing = z.infer<typeof listingSchema>;
export type Spec = Pick<z.infer<typeof parametersSchema>['datalist'][number], 'paramconflist'>;
export type Candidate = { key: string; series_id: number; year: number; energy: string; model: Cells;
  trims: { spec_id: number; fields: Cells }[]; evidence: Record<string, unknown> };
export const energyNames: Record<string, string> = { '纯电动': 'BEV', '插电式混合动力': 'PHEV', '增程式': 'EREV' };
export const protectedFields = new Set(['Recommendation', 'recommended', 'segment', 'commercial_highlight_type', 'commercial_highlight_value',
  'why_section_description', 'display_price_low', 'display_price_high', 'product_path', 'version', 'status', 'page_title', 'page_subtitle', 'hero_description',
  'i18n_translations', 'added_features_json', 'upgraded_features_json']);
export const modelNumbers: Record<string, string> = { length_mm: '长度(mm)', width_mm: '宽度(mm)', height_mm: '高度(mm)', wheelbase_mm: '轴距(mm)',
  '0_100_km_h_sec': '官方0-100km/h加速(s)', boot_volume_l: '后备厢容积(L)', ground_clearance_mm: '最小离地间隙(mm)', v2l_output_power_kw: '对外交流放电功率(kW)', voltage_platform_v: '高压平台（V）' };
export const trimNumbers: Record<string, string> = { battery_capacity_kwh: '电池能量(kWh)', range_display: 'CLTC纯电续航里程(km)',
  motor_power_kw: '电动机总功率(kW)', motor_torque_n_m: '电动机总扭矩(N·m)', dc_fast_charge_time_hours: '电池快充时间(小时)' };
export function meaningful(v: unknown): boolean { return ![null, undefined, '', '-', '暂无数据', '暂无报价'].includes(v as string); }
export function selected(spec: Spec, index: Record<string, number>, name: string): string {
  const c = spec.paramconflist.find(x => x.titleid === index[name]);
  return meaningful(c?.itemname) ? c!.itemname! : (c?.sublist ?? []).filter(x => x.value === '●').map(x => x.name).join('; ');
}
export function numeric(v: unknown): number | null { return /^\d+(?:\.\d+)?$/.test(String(v)) ? Number(v) : null; }
export function price(v: string): number | null { const m = /^(\d+(?:\.\d+)?)(万)?$/.exec(v); return m ? Math.round(Number(m[1]) * (m[2] ? 10000 : 1)) : null; }
export function usd(v: number): number { return Math.round((v / 6.74 + Number.EPSILON) * 100) / 100; }
export function matchesFormulaNumber(actual: unknown, expected: number): boolean {
  const n = typeof actual === 'number' || typeof actual === 'string' && actual.trim() ? Number(actual) : NaN;
  return Number.isFinite(n) && Math.abs(n - expected) <= 0.02;
}
export function empty(v: unknown): boolean { return v == null || v === '' || Array.isArray(v) && !v.length; }
export function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(b) && b.every(x => x && typeof x === 'object' && 'id' in x)) {
    return JSON.stringify((Array.isArray(a) ? a : []).map(x => x.id).sort()) === JSON.stringify(b.map(x => x.id).sort());
  }
  if (typeof a === 'string' && typeof b === 'string' && b.startsWith('[')) { try { return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)); } catch { return a === b; } }
  if (typeof a === 'string' && typeof b === 'string' && /^\d{4}-.*T/.test(b)) return Date.parse(a) === Date.parse(b);
  return JSON.stringify(a) === JSON.stringify(b);
}
export function sourceIdentity(row: Cells): string | null {
  const m = /series\s+(\d+).*?spec\s+(\d+)/.exec(String(row.notes ?? '')) ?? /(\d+)-(\d+)$/.exec(String(row.trim_config_id ?? ''));
  return m ? `${Number(m[1])}/${Number(m[2])}` : null;
}
export function assertDiscovery(rows: { seriesid: number }[], total: number): void {
  if (!total || rows.length !== total || new Set(rows.map(x => x.seriesid)).size !== total) throw new Error('Discovery count/duplicate mismatch');
}
export function reconcile(old: Cells | undefined, desired: Cells): { patch: Cells; conflicts: { field: string; existing: unknown; candidate: unknown }[] } {
  const patch: Cells = {}, conflicts = [];
  for (const [field, value] of Object.entries(desired)) {
    if (protectedFields.has(field) || empty(value) || same(old?.[field], value)) continue;
    if (!old || empty(old[field]) || old[field] === false && value === true) patch[field] = value;
    else conflicts.push({ field, existing: old[field], candidate: value });
  }
  return { patch, conflicts };
}
/** Keep legacy parent assignment even when one parent spans source model years. */
export function mergeParentGroups(groups: Candidate[]): Candidate {
  const first = groups[0];
  if (!first || groups.some(g => g.series_id !== first.series_id || g.energy !== first.energy)) throw new Error('Cannot merge unrelated source groups');
  const model: Cells = {};
  for (const key of Object.keys(first.model)) {
    const values = groups.map(g => g.model[key]);
    if (values.every(v => !empty(v) && same(v, values[0]))) model[key] = values[0];
    else if (/^(seats|top_speed)_(min|max)/.test(key) && values.every(v => typeof v === 'number')) model[key] = key.includes('_min') ? Math.min(...values as number[]) : Math.max(...values as number[]);
  }
  const common = groups.map(g => JSON.parse(String(g.model.common_features_json_pruned))[0].items as string[]);
  model.common_features_json_pruned = JSON.stringify([{ category: 'Autohome source values (Chinese)', items: common[0].filter(x => common.every(items => items.includes(x))) }]);
  const charge = [...new Set(groups.map(g => g.model.charging).filter(Boolean))];
  if (charge.length) model.charging = charge.join('; ');
  return { ...first, model, trims: groups.flatMap(g => g.trims), evidence: { groups: groups.map(g => g.evidence) } };
}
export function interpret(input: unknown, allowed: number[], fetched: string): Candidate[] {
  const r = parametersSchema.parse(input), sid = r.bread.seriesid;
  const index = Object.fromEntries(r.titlelist.flatMap(g => g.items).map(i => [i.itemname, i.titleid]));
  if (new Set(allowed).size !== allowed.length || new Set(r.datalist.map(s => s.specid)).size !== r.datalist.length) throw new Error('Duplicate spec IDs');
  const byId = new Map(r.datalist.map(s => [s.specid, s]));
  const groups = new Map<string, typeof r.datalist>();
  for (const id of allowed) {
    const s = byId.get(id);
    if (!s) throw new Error(`Listed spec ${id} absent from parameter response`);
    const rawEnergy = selected(s, index, '能源类型'), energy = energyNames[rawEnergy];
    // Non-NEV configurations in a mixed series stay in the exclusion report.
    if (!energy) {
      if (!['汽油', '柴油', '油电混合', '氢燃料'].includes(rawEnergy)) throw new Error(`Unsupported or undisclosed energy: ${id}/${rawEnergy}`);
      continue;
    }
    const year = /^(\d{4})款/.exec(s.specname)?.[1];
    if (!year) throw new Error(`Unrecognized model year: ${s.specname}`);
    const key = `AUT-${sid}-${year}-${energy}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups].map(([key, specs]) => {
    const year = Number(key.split('-')[2]), energy = key.split('-')[3];
    const values = (name: string) => specs.map(s => selected(s, index, name));
    const commonNumber = (name: string) => { const ns = values(name).map(numeric); return ns.every(x => x !== null) && new Set(ns).size === 1 ? ns[0] : null; };
    const model: Cells = { MODEL: r.bread.seriesname, brand: r.bread.brandname, model: r.bread.seriesname, model_year: year, powertrain_type: [energy] };
    for (const [f, n] of Object.entries(modelNumbers)) { const v = commonNumber(n); if (v !== null) model[f] = v; }
    for (const [stem, n] of [['seats', '座位数(个)'], ['top_speed', '最高车速(km/h)']]) {
      const ns = values(n).map(numeric);
      if (ns.every(x => x !== null)) { model[`${stem}_min${stem === 'seats' ? '' : '_kmh'}`] = Math.min(...ns as number[]); model[`${stem}_max${stem === 'seats' ? '' : '_kmh'}`] = Math.max(...ns as number[]); }
    }
    if (values('级别').every(x => x && x === values('级别')[0])) model.vehicle_class = values('级别')[0];
    for (const [field, name] of [['sunroof_availability', '天窗类型'], ['v2l_availability', '对外放电']]) {
      const states = specs.map(s => { const c = s.paramconflist.find(x => x.titleid === index[name]); const marks = [c?.itemname, ...(c?.sublist ?? []).map(x => x.value)]; return marks.includes('●') ? 'Standard' : marks.includes('○') ? 'Optional' : null; });
      if (states.every(Boolean)) model[field] = [new Set(states).size === 1 ? states[0] : 'By Trim'];
    }
    const ac = specs.every(s => meaningful(selected(s, index, '慢充接口位置')) || numeric(selected(s, index, '电池慢充时间(小时)')) !== null);
    if (ac) model.ac_slow_charge_supported = true;
    if (values('电池慢充电量范围(%)').every(x => x === '0-100') && commonNumber('电池慢充时间(小时)') !== null) model.ac_slow_charge_full_time_hours = commonNumber('电池慢充时间(小时)');
    const warranties = values('电池组质保').map((x, i) => x || values('三电系统质保')[i]);
    const ws = warranties.map(x => /^(\d+|[一二三四五六七八九十])年或(\d+(?:\.\d+)?)万公里$/.exec(x));
    if (ws.every(Boolean) && new Set(warranties).size === 1) {
      model.battery_warranty_years = /^\d+$/.test(ws[0]![1]) ? Number(ws[0]![1]) : '一二三四五六七八九十'.indexOf(ws[0]![1]) + 1;
      model.battery_warranty_distance_km = Number(ws[0]![2]) * 10000;
    }
    const charge = [...new Set(specs.flatMap(s => ['快', '慢'].map(type => {
      const time = selected(s, index, `电池${type}充时间(小时)`), window = selected(s, index, `电池${type}充电量范围(%)`);
      return numeric(time) === null ? '' : `${type === '快' ? 'DC' : 'AC'} ${time} h; SOC ${window || 'NOT_RETURNED'}%`;
    })))].filter(Boolean);
    if (charge.length) model.charging = charge.join('; ');
    const common = r.titlelist.flatMap(g => g.items).filter(i => !['厂商指导价(元)', '车型名称', '经销商报价'].includes(i.itemname)).filter(i => values(i.itemname).every(x => meaningful(x) && x === values(i.itemname)[0]));
    model.common_features_json_pruned = JSON.stringify([{ category: 'Autohome source values (Chinese)', items: common.map(i => `${i.itemname}: ${values(i.itemname)[0]}`) }]);
    const trims = specs.sort((a, b) => a.specid - b.specid).map((s, i) => {
      const fields: Cells = { trim_config_id: `AUT-${sid}-${s.specid}`, trim: s.specname, trim_order: i + 1,
        source_url: `https://www.autohome.com.cn/web-main/car/param/getParamConf?mode=1&site=1&seriesid=${sid}`, source_status: ['Verified'], last_verified_at: fetched,
        notes: `Autohome series ${sid}; spec ${s.specid}; source name: ${s.specname}. USD=CNY/6.74. Source Chinese name retained; English name requires evidence. Warranty: ${selected(s, index, '电池组质保') || selected(s, index, '三电系统质保')}; first owner: ${selected(s, index, '三电首任车主质保政策')}.` };
      for (const [f, n] of Object.entries(trimNumbers)) { const v = numeric(selected(s, index, n)); if (v !== null) fields[f] = v; }
      const p = price(selected(s, index, '厂商指导价(元)')); if (p !== null) { fields.trim_price_rmb = p; fields.trim_price_display = usd(p); }
      const chemistry: Record<string, string> = { '磷酸铁锂电池': 'LFP', '三元锂电池': 'NCM', '三元锂+磷酸铁锂电池': 'NCM+LFP', '半固态电池': 'Semi-solid-state' };
      const drive: Record<string, string> = { '双电机四驱': 'Dual-motor AWD', '前置前驱': 'Front motor FWD', '后置后驱': 'Rear motor RWD', '三电机四驱': 'Tri-motor AWD', '四电机四驱': 'Quad-motor AWD' };
      const c = chemistry[selected(s, index, '电池类型')]; if (c) fields.battery_chemistry = [c];
      const rawDrive = selected(s, index, '驱动方式');
      const d = energy === 'PHEV' && rawDrive === '前置四驱' ? 'Front-engine AWD' :
        energy === 'BEV' || rawDrive.includes('电机') ? drive[rawDrive] : undefined; if (d) fields.drivetrain_display = [d];
      if (selected(s, index, '快充功能') === '支持') fields.dc_fast_charge_supported = true;
      const w = /^(\d+)-(\d+)$/.exec(selected(s, index, '电池快充电量范围(%)'));
      if (w && Number(w[1]) < Number(w[2]) && Number(w[2]) <= 100) { fields.dc_fast_charge_min_percent = Number(w[1]); fields.dc_fast_charge_max_percent = Number(w[2]); }
      fields.base_spec_summary_json = JSON.stringify(r.titlelist.flatMap(g => g.items).flatMap(i => {
        const cell = s.paramconflist.find(c => c.titleid === i.titleid);
        const raw = selected(s, index, i.itemname), options = (cell?.sublist ?? []).filter(x => x.value === '○').map(x => x.name);
        return raw || options.length ? [`${i.itemname}: ${raw || 'NOT_RETURNED'}${options.length ? `; Optional: ${options.join(', ')}` : ''}`] : [];
      }));
      return { spec_id: s.specid, fields };
    });
    return { key, series_id: sid, year, energy, model, trims, evidence: { title_index: index, specs: specs.map(s => ({ spec_id: s.specid, raw: s.paramconflist })) } };
  });
}
