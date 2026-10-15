import { expect, test } from 'bun:test';
import { verifyUpcoming } from '../../../scripts/vehicle-crawler/collect';
import { interpret, mergeParentGroups, reconcile } from '../../../lib/vehicle-catalog-source';
import { companyCandidates, COMPANY, seagullScopePatch } from '../../../lib/vehicle-company-reference';
const html = (id = 78508, state = 10, text = '即将上市') => `<div>${text}</div><script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { seriesId: 6762, specId: id, specDetails: { bread: { seriesid: 6762, specid: id, specname: '2027款 高配版' }, specinfo: { id, specstate: state } } } } })}</script>`;
test('upcoming requires exact series/spec, state and visible launch evidence', () => {
  expect(verifyUpcoming(html(), 6762, 78508)).toBe('2027款 高配版');
  for (const s of [html(999), html(78508, 40), html(78508, 10, '停售'), html(78508, 10, '')]) expect(() => verifyUpcoming(s, 6762, 78508)).toThrow();
});
const names = ['能源类型', '长度(mm)', '座位数(个)', '电池特有技术', '厂商指导价(元)'];
const input = { bread: { seriesid: 6762, seriesname: '海鸥', brandname: '比亚迪' }, titlelist: [{ items: names.map((itemname, titleid) => ({ itemname, titleid })) }], datalist: [
  { specid: 1, specname: '2025款 飞翔版', specstatus: 20, paramconflist: ['纯电动', '3780', '4', '刀片电池', '8.58万'].map((itemname, titleid) => ({ itemname, titleid })) },
  { specid: 78508, specname: '2027款 高配版', specstatus: 10, paramconflist: ['纯电动', '4205', '5', '-', '-'].map((itemname, titleid) => ({ itemname, titleid })) },
] };
test('mixed years preserve trim facts, range seats and omit conflicting or undisclosed shared facts', () => {
  const groups = interpret(input, [1, 78508], '2026-10-15');
  expect(groups[0].model.battery_technology).toEqual(['Blade']);
  const g = mergeParentGroups(groups);
  expect(g.model.seats_min).toBe(4); expect(g.model.seats_max).toBe(5);
  expect(g.model.length_mm).toBeUndefined(); expect(g.model.battery_technology).toBeUndefined();
  expect(g.trims[1].fields.trim_price_rmb).toBeUndefined();
  expect(g.trims[1].fields.base_spec_summary_json).toContain('4205');
  const ref = { version: 1 as const, source: { base_token: COMPANY.base_token, models_rev: 1, trims_rev: 1, fetched_at: '2026-10-15' }, series_ids: [6762], models: [{ record_id: 'recCompany', model_id: 'MDL-002', series_id: 6762, fields: { MODEL: 'BYD Seagull', brand: 'BYD', model: 'Seagull', model_year: 2026, powertrain_type: ['BEV'] }, specs: [{ spec_id: 1, trim_config_id: 'MDL-002-6762-1', trim: '2025 MY Flying' }, { spec_id: 78508, trim_config_id: 'MDL-002-6762-78508', trim: '2026 MY Top Spec Edition' }] }] };
  const actual = companyCandidates(groups, ref)[0];
  expect(actual.trims.map(t => t.spec_id)).toEqual([1, 78508]);
  expect(actual.trims[1].fields.trim).toBe('2027 MY Top Spec Edition');
  expect(actual.trims[1].fields.trim_price_display).toBeUndefined();
});
test('scope refresh clears only explicitly requested dimensions and remains idempotent', () => {
  const desired = { model_id: 'MDL-002', length_mm: null, seats_max: 5, Recommendation: ['changed'], boot_volume_l: null };
  const old = { length_mm: 3780, seats_max: 4, boot_volume_l: 930 };
  expect(reconcile(old, desired).patch).not.toHaveProperty('length_mm');
  expect(seagullScopePatch(old, desired)).toEqual({ length_mm: null, seats_max: 5 });
  expect(seagullScopePatch({ ...old, length_mm: null, seats_max: 5 }, desired)).toEqual({});
  expect(() => seagullScopePatch(old, { ...desired, model_id: 'MDL-009' })).toThrow();
});
