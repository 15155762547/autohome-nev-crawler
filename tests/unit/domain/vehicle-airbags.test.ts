import { expect, test } from 'bun:test';
import { calculateAirbags } from '../../../lib/vehicle-airbags';
import { interpret, mergeParentGroups } from '../../../lib/vehicle-catalog-source';
import { auditField } from '../../../lib/vehicle-catalog-audit';
const names = ['能源类型', '主/副驾驶座安全气囊', '前/后排侧气囊', '前/后排头部气囊(气帘)', '前排中间气囊'];
const index = Object.fromEntries(names.map((n, i) => [n, i]));
const spec = (id: number, year: number, cells: string[]) => ({ specid: id, specname: `${year}款 测试`, specstatus: 20,
  paramconflist: ['纯电动', ...cells].map((itemname, titleid) => ({ titleid, itemname })) });
const low = spec(1, 2025, ['主●/副●', '-', '前●/后●', '-']);
const high = spec(2, 2026, ['主●/副●', '前●/后-', '前●/后●', '-']);
const future = spec(3, 2027, ['-', '-', '-', '-']);
const input = (rows = [low, high, future]) => ({ bread: { seriesid: 6762, seriesname: '海鸥', brandname: '比亚迪' },
  titlelist: [{ items: names.map((itemname, titleid) => ({ itemname, titleid })) }], datalist: rows });
test('physical counts do not double count curtains and include center and rear side airbags', () => {
  expect(calculateAirbags(low, index).count).toBe(4);
  expect(calculateAirbags(high, index).count).toBe(6);
  expect(calculateAirbags(spec(4, 2026, ['主●/副●', '前●/后-', '前●/后●', '●']), index).count).toBe(7);
  expect(calculateAirbags(spec(5, 2026, ['主●/副●', '前●/后●', '前●/后●', '●']), index).count).toBe(9);
  expect(calculateAirbags(spec(6, 2026, ['主●/副-', '-', '-', '-']), index).count).toBe(1);
});
test('prelaunch blanks, missing fields, unsupported positions and optional equipment cannot become invented standard counts', () => {
  expect(calculateAirbags(future, index).count).toBeNull();
  expect(calculateAirbags({ paramconflist: [] }, index).count).toBeNull();
  expect(calculateAirbags(spec(7, 2026, ['主●/副●', '前○/后-', '前●/后●', '○']), index).count).toBe(4);
  const extra = { ...high, paramconflist: [...high.paramconflist, { titleid: 99, itemname: '●' }] };
  expect(calculateAirbags(extra, { ...index, 后排座椅防下滑气囊: 99 }).count).toBeNull();
});
test('selected configurations aggregate maximum across years and preserve unknown evidence', () => {
  const groups = interpret(input(), [1, 2, 3], '2026-10-15');
  const merged = mergeParentGroups(groups);
  expect(merged.model.airbags).toBe(6);
  const e = auditField('models', 'MDL-002', { name: 'airbags', type: 'number' }, 6, merged.model.airbags, merged, 'https://www.autohome.com.cn/config/series/6762.html');
  expect(e.category).toBe('程序转换'); expect(e.reason).toContain('最大'); expect(e.reason).toContain('1款');
  expect(interpret(input(), [1], 'now')[0].model.airbags).toBe(4);
  expect(interpret(input(), [3], 'now')[0].model.airbags).toBeUndefined();
});

test('company parent subsets cannot inherit sibling product airbag maxima', async () => {
  const { companyCandidates, COMPANY } = await import('../../../lib/vehicle-company-reference');
  const rows = [low, { ...high, specname: '2025款 测试' }];
  const source = interpret(input(rows), [1, 2], 'now');
  const ref = { version: 1 as const, source: { base_token: COMPANY.base_token, models_rev: 1, trims_rev: 1, fetched_at: 'now' }, series_ids: [6762], models: [1, 2].map(id => ({
    record_id: `rec${id}`, model_id: `MDL-00${id}`, series_id: 6762,
    fields: { MODEL: `Product ${id}`, brand: 'BYD', model: `Product ${id}`, model_year: 2025, powertrain_type: ['BEV'] },
    specs: [{ spec_id: id, trim_config_id: `MDL-00${id}-6762-${id}`, trim: '2025 MY Test' }],
  })) };
  expect(companyCandidates(source, ref).map(g => g.model.airbags)).toEqual([4, 6]);
});
test('the approved calculated airbag value refreshes while unrelated nonempty facts remain protected', async () => {
  const { reconcileMaintained } = await import('../../../lib/vehicle-catalog-audit');
  expect(reconcileMaintained({ airbags: 6, length_mm: 5000 }, { airbags: 7, length_mm: 5100 }).patch).toEqual({ airbags: 7 });
  expect(reconcileMaintained({ airbags: 7 }, {}).patch).toEqual({});
  expect(reconcileMaintained({ airbags: 7 }, { airbags: 7 }).patch).toEqual({});
});
