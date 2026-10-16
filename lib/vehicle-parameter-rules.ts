export type ParameterMapping = { value: number; source_field: string; raw: string; condition: string; rule: string };
const numeric = (v: string) => /^\d+(?:\.\d+)?$/.test(v) && Number(v) > 0 ? Number(v) : null;
export function groundClearance(get: (name: string) => string): ParameterMapping | null {
  for (const [name, condition] of [['最小离地间隙(mm)', '载荷条件未注明'], ['满载最小离地间隙(mm)', '满载'], ['空载最小离地间隙(mm)', '空载']]) {
    const raw = get(name), value = numeric(raw);
    if (value !== null) return { value, source_field: name, raw, condition, rule: '采用来源原值毫米数，保留载荷条件；不换算空载/满载' };
  }
  return null;
}
export function slowChargeTime(get: (name: string) => string): ParameterMapping | null {
  const name = '电池慢充时间(小时)', raw = get(name), value = numeric(raw);
  if (value === null) return null;
  const window = get('电池慢充电量范围(%)').trim().replace(/[%％\s]/g, '').replace(/[–—~～]/g, '-');
  if (!['', '-', '暂无数据', '0-100'].includes(window)) return null;
  return { value, source_field: name, raw, condition: window === '0-100' ? 'SOC 0–100%' : 'SOC窗口未披露；采用来源慢充时间作为近似值，未独立证实0–100%', rule: '直接采用官网慢充小时数，不由电池容量/功率推算；明确部分SOC区间时不映射充满时间' };
}
