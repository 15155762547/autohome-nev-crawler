import type { Spec } from './vehicle-catalog-source';

export type AirbagCalculation = { count: number | null; parts: Record<string, number>; reason: string; raw: Record<string, string> };
/** Physical standard bags, not coverage positions; unknown quantities never become zero. */
export function calculateAirbags(spec: Spec, index: Record<string, number>): AirbagCalculation {
  const raw: Record<string, string> = {};
  for (const [name, id] of Object.entries(index).filter(([name]) => /气囊|气帘/.test(name))) {
    const c = spec.paramconflist.find(c => c.titleid === id);
    raw[name] = c?.itemname?.trim() || (c?.sublist ?? []).map(c => `${c.name}${c.value}`).join('/') || '';
  }
  const parts: Record<string, number> = {};
  const fail = (reason: string): AirbagCalculation => ({ count: null, parts, raw, reason });
  const pair = (value: string | undefined, first: string, second: string, weight: number): number | null => {
    if (value === '-') return 0;
    const m = new RegExp(`^${first}([●○-])/${second}([●○-])$`).exec(value ?? '');
    return m ? m.slice(1).filter(v => v === '●').length * weight : null;
  };
  const driver = pair(raw['主/副驾驶座安全气囊'], '主', '副', 1);
  if (driver === null || !driver) return fail('主副驾未明确标配；不能把整款未披露的破折号当作0个');
  parts['主副驾'] = driver;
  const side = pair(raw['前/后排侧气囊'], '前', '后', 2);
  const head = pair(raw['前/后排头部气囊(气帘)'], '前', '后', 1);
  if (side === null || head === null) return fail('侧气囊或气帘字段缺失/标记无法识别');
  parts['前后排侧气囊'] = side;
  // A left/right pair of continuous curtains protects both rows, not four independent bags.
  parts['左右贯穿气帘'] = head ? 2 : 0;
  const handled = new Set(['主/副驾驶座安全气囊', '前/后排侧气囊', '前/后排头部气囊(气帘)']);
  if ('前排中间气囊' in raw) {
    const value = raw['前排中间气囊'];
    if (!['●', '○', '-'].includes(value)) return fail('前排中间气囊标记未知');
    parts['前排中间气囊'] = value === '●' ? 1 : 0; handled.add('前排中间气囊');
  }
  for (const [name, value] of Object.entries(raw)) {
    if (handled.has(name) || value === '-' || value === '○') continue;
    return fail(`额外项目${name}数量或含义未核实，不强行计数`);
  }
  return { count: Object.values(parts).reduce((a, b) => a + b, 0), parts, raw,
    reason: '按已披露标配标记估算；选装不计入标配，贯穿气帘按左右2个；并非厂家直接公布总数' };
}
