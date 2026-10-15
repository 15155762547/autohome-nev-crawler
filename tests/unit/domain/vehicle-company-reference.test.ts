import { expect, test } from 'bun:test';
import { COMPANY, companyCandidates, assertReference, alignmentPatch, assertRetirement, type CompanyReference } from '../../../lib/vehicle-company-reference';
import { reconcile, type Candidate } from '../../../lib/vehicle-catalog-source';

const group = (year: number, energy: string, id: number, price: number): Candidate => ({
  key: `AUT-8171-${year}-${energy}`, series_id: 8171, year, energy,
  model: { MODEL: '钛7', model_year: year, length_mm: 4999, common_features_json_pruned: JSON.stringify([{ items: ['shared', String(year)] }]), charging: `SOC 30-80%; ${year}` },
  trims: [{ spec_id: id, fields: { trim: '中文配置', trim_price_rmb: price } }], evidence: { title_index: {}, specs: [] },
});
const reference = (): CompanyReference => ({ version: 1, source: { base_token: COMPANY.base_token, fetched_at: '2026-10-15', models_rev: 1, trims_rev: 1 }, series_ids: [8171], models: [
  { record_id: 'recCompany', model_id: 'MDL-009', series_id: 8171, fields: { MODEL: 'Fangchengbao Ti 7 PHEV', brand: 'Fangchengbao', model: 'Ti 7 PHEV', model_year: 2026, powertrain_type: ['PHEV'] },
    specs: [{ spec_id: 1, trim_config_id: 'MDL-009-8171-1', trim: '2025 Pro' }, { spec_id: 2, trim_config_id: 'MDL-009-8171-2', trim: '2026 Max' }] },
  { record_id: 'recCompanyEV', model_id: 'MDL-126', series_id: 8171, fields: { MODEL: 'Fangchengbao Ti 7 EV', brand: 'Fangchengbao', model: 'Ti 7 EV', model_year: null, powertrain_type: ['BEV'] },
    specs: [{ spec_id: 3, trim_config_id: 'MDL-126-8171-3', trim: 'EV RWD' }] },
] });
test('company product groups merge years, separate powertrains, preserve evidence and use English names', () => {
  const g = companyCandidates([group(2025, 'PHEV', 1, 219800), group(2026, 'PHEV', 2, 195800), group(2026, 'BEV', 3, 239800)], reference());
  expect(g.map(x => x.key)).toEqual(['MDL-009', 'MDL-126']);
  expect(g[0].model.MODEL).toBe('Fangchengbao Ti 7 PHEV');
  expect(g[0].model.model_year).toBe(2026); expect(g[1].model.model_year).toBeNull();
  expect(g[0].trims.map(t => [t.spec_id, t.fields.trim, t.fields.trim_order, t.fields.trim_price_display])).toEqual([[2, '2026 Max', 1, 29050], [1, '2025 Pro', 2, 32611]]);
  expect(JSON.parse(String(g[0].model.common_features_json_pruned))[0].items).toEqual(['shared']);
  expect(g[0].model.charging).toContain('2025'); expect(g[0].model.charging).toContain('2026');
  expect((g[0].evidence.groups as unknown[]).length).toBe(2);
});
test('missing, duplicate or cross-powertrain company identities stop mapping', () => {
  expect(() => companyCandidates([group(2025, 'PHEV', 99, 100)], reference())).toThrow('absent/ambiguous');
  const duplicate = reference(); duplicate.models[0].specs.push(duplicate.models[0].specs[0]);
  expect(() => assertReference(duplicate)).toThrow('Ambiguous');
  expect(() => companyCandidates([group(2025, 'BEV', 1, 100)], reference())).toThrow();
});
test('ordinary sync protects nonempty values; scoped alignment cannot overwrite business or technical facts', () => {
  const old = { model: '钛7', model_year: 2026, v2l_output_power_kw: 6, Recommendation: ['1'] };
  const desired = { model: 'Ti 7 EV', model_year: null, v2l_output_power_kw: 6.6, Recommendation: ['2'] };
  expect(reconcile(old, desired).patch).toEqual({});
  expect(alignmentPatch('models', old, desired)).toEqual({ model: 'Ti 7 EV', model_year: null });
  expect(alignmentPatch('models', { ...old, model: 'Ti 7 EV', model_year: null }, desired)).toEqual({});
});
test('retirement requires exact approved Ti7 duplicate, valid backup and no remaining children', () => {
  const r = { record_id: 'recDuplicate', model_id: 'AUT-8171-2026-PHEV', into_key: 'MDL-009' };
  expect(() => assertRetirement(r, [r], [], true)).not.toThrow();
  expect(() => assertRetirement(r, [r], [], false)).toThrow();
  expect(() => assertRetirement(r, [r], [{ id: 'recChild' }], true)).toThrow();
  expect(() => assertRetirement({ ...r, record_id: 'recOther' }, [r], [], true)).toThrow();
  expect(() => assertRetirement({ ...r, model_id: 'AUT-8627-2026-PHEV' }, [r], [], true)).toThrow();
});
