import type { ParameterMapping } from './vehicle-parameter-rules';
import { empty, interpret, modelNumbers, parametersSchema, same, selected, numeric, type Candidate } from './vehicle-catalog-source';

export const representativeFields = new Set([...Object.keys(modelNumbers), 'battery_technology', 'sunroof_availability', 'v2l_availability', 'ac_slow_charge_full_time_hours', 'ac_slow_charge_supported', 'battery_warranty_years', 'battery_warranty_distance_km', 'charging', 'vehicle_class']);
export type SalesStates = Record<string, { state: number; label: string }>;
export type Representative = { policy: 'highest-priced-on-sale-v1'; spec_id: number; name: string; state: string; price_rmb: number | null; fetched_at: string; url: string; selection: string; fields: Record<string, number[]>; missing: string[]; conditions: Record<string, (ParameterMapping & { spec_id: number })[]>; range_summary: Record<string, { min: number; max: number; known: number; total: number }> };
/** Choose only within this product. Ranges, identities and common equipment remain group-level. */
export function representativeModel(group: Candidate, input: unknown, states: SalesStates, fetched: string, provenance?: Record<string, { fetched_at: string }>): Candidate {
  const raw = parametersSchema.parse(input);
  const index = Object.fromEntries(raw.titlelist.flatMap(g => g.items).map(i => [i.itemname, i.titleid]));
  const specs = group.trims.map(t => {
    const row = raw.datalist.find(s => s.specid === t.spec_id);
    if (!row) throw Error(`Representative spec absent: ${t.spec_id}`);
    const single = interpret({ ...raw, datalist: [row] }, [t.spec_id], fetched)[0];
    if (!single || single.energy !== group.energy) throw Error('Representative energy mismatch');
    return { id: t.spec_id, name: row.specname, model: single.model, year: single.year, row, conditions: (single.evidence.mapping_conditions as any[])[0] as Record<string, ParameterMapping | null>, price: single.trims[0].fields.trim_price_rmb as number | undefined };
  });
  const onSale = specs.filter(s => states[s.id]?.state === 2);
  const pool = onSale.length ? onSale : specs;
  const priced = pool.filter(s => typeof s.price === 'number');
  const sorted = [...(priced.length ? priced : pool)].sort((a,b) => (b.price ?? 0) - (a.price ?? 0) || b.year - a.year || b.id - a.id);
  const chosen = sorted[0];
  if (!chosen) throw Error('Empty representative product');
  const info: Representative = { policy: 'highest-priced-on-sale-v1', spec_id: chosen.id, name: chosen.name, state: states[chosen.id]?.label ?? 'UNKNOWN', price_rmb: chosen.price ?? null, fetched_at: provenance?.[chosen.id]?.fetched_at ?? fetched, url: `https://www.autohome.com.cn/config/spec/${chosen.id}.html`,
    selection: `${onSale.length ? '在售范围' : '无在售配置，回退本产品已采集配置'}；${priced.length ? '已披露指导价最高' : '指导价全部未披露，仅按年款和ID确定代表，不宣称最高配'}；${pool.length-priced.length}款价格未知；同价按年款、配置ID降序`, fields: {}, missing: [], conditions: {}, range_summary: {} };
  for (const standard of ['CLTC', 'WLTC', 'NEDC']) {
    const known = specs.map(s => numeric(selected(s.row, index, `${standard}纯电续航里程(km)`))).filter((n): n is number => n !== null && n > 0);
    if (known.length) info.range_summary[standard] = { min: Math.min(...known), max: Math.max(...known), known: known.length, total: specs.length };
  }
  const model = { ...group.model };
  for (const field of representativeFields) {
    if (!empty(chosen.model[field])) { model[field] = chosen.model[field]; info.fields[field] = [chosen.id]; if (chosen.conditions[field]) info.conditions[field] = [{ ...chosen.conditions[field]!, spec_id: chosen.id }]; continue; }
    const others = specs.filter(s => s.id !== chosen.id);
    // Dimension fallback must also agree with every known dimension of the representative.
    const dimensions = ['length_mm', 'width_mm', 'height_mm', 'wheelbase_mm'];
    const compatible = !dimensions.includes(field) || others.every(s => dimensions.every(d => empty(chosen.model[d]) || same(chosen.model[d], s.model[d])));
    const slowWindow = selected(chosen.row, index, '电池慢充电量范围(%)').replace(/[%％\s]/g, '').replace(/[–—~～]/g, '-');
    const partialSlow = field === 'ac_slow_charge_full_time_hours' && !['', '-', '暂无数据', '0-100'].includes(slowWindow);
    const sameCondition = others.every(s => s.conditions[field]?.condition === others[0]?.conditions[field]?.condition);
    if (others.length && compatible && !partialSlow && sameCondition && others.every(s => !empty(s.model[field]) && same(s.model[field], others[0].model[field]))) {
      model[field] = others[0].model[field]; info.fields[field] = others.map(s => s.id);
      const conditions = others.flatMap(s => s.conditions[field] ? [{ ...s.conditions[field]!, spec_id: s.id }] : []); if (conditions.length) info.conditions[field] = conditions;
    } else { model[field] = null; info.missing.push(field); }
  }
  return { ...group, model, evidence: { ...group.evidence, representative: info } };
}
export function representativeNote(group: Candidate): string {
  const r = group.evidence.representative as Representative | undefined;
  return r ? `代表配置：${r.name}（spec ${r.spec_id}，${r.state}，人民币指导价${r.price_rmb ?? '未披露'}）；${r.selection}。来源采集时间：${r.fetched_at}；${r.url}\n单值技术参数采用该配置；座位/速度等范围仍按全组汇总，气囊仍取已披露最大值。其他配置一致值补缺：${Object.entries(r.fields).filter(([, ids])=>ids.length!==1||ids[0]!==r.spec_id).map(([f,ids])=>`${f}←${ids.join(',')}`).join('；') || '无'}。取值条件：${Object.entries(r.conditions).map(([f, cs]) => `${f}：${[...new Set(cs.map(c => `${c.source_field}=${c.raw}；${c.condition}`))].join(' / ')}`).join('；') || '无新增条件'}。\n续航按测试标准分别汇总：${Object.entries(r.range_summary).map(([standard, v]) => `${standard} ${v.min === v.max ? v.min : `${v.min}～${v.max}`} km（${v.known}/${v.total}款披露）`).join('；') || '来源未披露CLTC/WLTC/NEDC有效纯电续航'}；不同标准不混算。\n未能核实：${r.missing.join(',') || '无'}；已有非空值在未能核实时保留为历史值，不宣称重新核实。\n` : '';
}
