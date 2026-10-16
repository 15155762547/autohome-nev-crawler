import { empty, interpret, modelNumbers, parametersSchema, same, type Candidate } from './vehicle-catalog-source';

export const representativeFields = new Set([...Object.keys(modelNumbers), 'battery_technology', 'sunroof_availability', 'v2l_availability', 'ac_slow_charge_full_time_hours', 'battery_warranty_years', 'battery_warranty_distance_km', 'charging', 'vehicle_class']);
export type SalesStates = Record<string, { state: number; label: string }>;
export type Representative = { policy: 'highest-priced-on-sale-v1'; spec_id: number; name: string; state: string; price_rmb: number | null; fetched_at: string; url: string; selection: string; fields: Record<string, number[]>; missing: string[] };
/** Choose only within this product. Ranges, identities and common equipment remain group-level. */
export function representativeModel(group: Candidate, input: unknown, states: SalesStates, fetched: string, provenance?: Record<string, { fetched_at: string }>): Candidate {
  const raw = parametersSchema.parse(input);
  const specs = group.trims.map(t => {
    const row = raw.datalist.find(s => s.specid === t.spec_id);
    if (!row) throw Error(`Representative spec absent: ${t.spec_id}`);
    const single = interpret({ ...raw, datalist: [row] }, [t.spec_id], fetched)[0];
    if (!single || single.energy !== group.energy) throw Error('Representative energy mismatch');
    return { id: t.spec_id, name: row.specname, model: single.model, year: single.year, price: single.trims[0].fields.trim_price_rmb as number | undefined };
  });
  const onSale = specs.filter(s => states[s.id]?.state === 2);
  const pool = onSale.length ? onSale : specs;
  const priced = pool.filter(s => typeof s.price === 'number');
  const sorted = [...(priced.length ? priced : pool)].sort((a,b) => (b.price ?? 0) - (a.price ?? 0) || b.year - a.year || b.id - a.id);
  const chosen = sorted[0];
  if (!chosen) throw Error('Empty representative product');
  const info: Representative = { policy: 'highest-priced-on-sale-v1', spec_id: chosen.id, name: chosen.name, state: states[chosen.id]?.label ?? 'UNKNOWN', price_rmb: chosen.price ?? null, fetched_at: provenance?.[chosen.id]?.fetched_at ?? fetched, url: `https://www.autohome.com.cn/config/spec/${chosen.id}.html`,
    selection: `${onSale.length ? '在售范围' : '无在售配置，回退本产品已采集配置'}；${priced.length ? '已披露指导价最高' : '指导价全部未披露，仅按年款和ID确定代表，不宣称最高配'}；${pool.length-priced.length}款价格未知；同价按年款、配置ID降序`, fields: {}, missing: [] };
  const model = { ...group.model };
  for (const field of representativeFields) {
    if (!empty(chosen.model[field])) { model[field] = chosen.model[field]; info.fields[field] = [chosen.id]; continue; }
    const others = specs.filter(s => s.id !== chosen.id);
    // Dimension fallback must also agree with every known dimension of the representative.
    const dimensions = ['length_mm', 'width_mm', 'height_mm', 'wheelbase_mm'];
    const compatible = !dimensions.includes(field) || others.every(s => dimensions.every(d => empty(chosen.model[d]) || same(chosen.model[d], s.model[d])));
    if (others.length && compatible && others.every(s => !empty(s.model[field]) && same(s.model[field], others[0].model[field]))) {
      model[field] = others[0].model[field]; info.fields[field] = others.map(s => s.id);
    } else { model[field] = null; info.missing.push(field); }
  }
  return { ...group, model, evidence: { ...group.evidence, representative: info } };
}
export function representativeNote(group: Candidate): string {
  const r = group.evidence.representative as Representative | undefined;
  return r ? `代表配置：${r.name}（spec ${r.spec_id}，${r.state}，人民币指导价${r.price_rmb ?? '未披露'}）；${r.selection}。来源采集时间：${r.fetched_at}；${r.url}\n单值技术参数采用该配置；座位/速度等范围仍按全组汇总，气囊仍取已披露最大值。其他配置一致值补缺：${Object.entries(r.fields).filter(([, ids])=>ids.length!==1||ids[0]!==r.spec_id).map(([f,ids])=>`${f}←${ids.join(',')}`).join('；') || '无'}。未能核实：${r.missing.join(',') || '无'}；已有非空值在未能核实时保留为历史值，不宣称重新核实。\n` : '';
}
