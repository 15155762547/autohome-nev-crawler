import { describe, expect, test } from 'bun:test';
import { assertDiscovery, selected, numeric, price, usd, matchesFormulaNumber, sourceIdentity, reconcile, interpret, mergeParentGroups, type Candidate } from '../../../lib/vehicle-catalog-source';

describe('Autohome catalog contracts ported from the ES8 collector', () => {
  test('formula errors and blank outputs cannot pass numeric verification', () => {
    expect(matchesFormulaNumber('500.50001', 500.5)).toBeTrue();
    expect(matchesFormulaNumber('NaN', 500.5)).toBeFalse();
    expect(matchesFormulaNumber('', 0)).toBeFalse();
    expect(matchesFormulaNumber('formula error', 500.5)).toBeFalse();
  });
  test('all pages must reconcile with the advertised total without duplicates', () => {
    expect(() => assertDiscovery([{ seriesid: 1 }], 2)).toThrow();
    expect(() => assertDiscovery([{ seriesid: 1 }, { seriesid: 1 }], 2)).toThrow();
    expect(() => assertDiscovery([{ seriesid: 1 }, { seriesid: 2 }], 2)).not.toThrow();
  });
  test('empty itemname still reads standard sublist; optional is not standard', () => {
    const spec = { paramconflist: [{ titleid: 17, itemname: '', sublist: [{ name: '5', value: '●' }, { name: '7', value: '○' }] }] };
    expect(selected(spec, { seats: 17 }, 'seats')).toBe('5');
    expect(numeric('30-80')).toBeNull();
    expect(price('38.28万')).toBe(382800);
    expect(usd(382800)).toBe(56795.25);
  });
  test('AUT and MDL aliases resolve to the same source identity', () => {
    expect(sourceIdentity({ trim_config_id: 'AUT-4427-78436' })).toBe('4427/78436');
    expect(sourceIdentity({ trim_config_id: 'MDL-141-4427-78436' })).toBe('4427/78436');
  });
  test('preserve business and nonempty fields; no deletes or repeat writes', () => {
    const old = { MODEL: 'NIO ES8', length_mm: 5280, Recommendation: ['1'] };
    const desired = { MODEL: '蔚来ES8', length_mm: 5280, width_mm: 2010, Recommendation: ['2'] };
    const a = reconcile(old, desired);
    expect(a.patch).toEqual({ width_mm: 2010 });
    expect(a.conflicts.map(x => x.field)).toEqual(['MODEL']);
    expect(reconcile({ ...old, ...a.patch }, desired).patch).toEqual({});
  });
  test('legacy parent across years retains only common scalar facts', () => {
    const group = (year: number, length: number): Candidate => ({ key: `AUT-1-${year}-BEV`, series_id: 1, year, energy: 'BEV', model: {
      model_year: year, length_mm: length, seats_min: 5, common_features_json_pruned: JSON.stringify([{ items: ['shared', String(year)] }]),
    }, trims: [], evidence: {} });
    const merged = mergeParentGroups([group(2025, 5000), group(2026, 5100)]);
    expect(merged.model.model_year).toBeUndefined();
    expect(merged.model.length_mm).toBeUndefined();
    expect(JSON.parse(String(merged.model.common_features_json_pruned))[0].items).toEqual(['shared']);
  });
  test('only listed specs are interpreted; model scalars require every trim to agree', () => {
    const titles = ['能源类型', '长度(mm)', '电池能量(kWh)', '厂商指导价(元)', 'CLTC纯电续航里程(km)', '高压平台（V）'];
    const spec = (id: number, length: string) => ({ specid: id, specname: '2026款 示例版', specstatus: 20,
      paramconflist: ['纯电动', length, '102', '38.28万', '710', '800'].map((v, i) => ({ titleid: i + 10, itemname: v })) });
    const result = { bread: { seriesid: 4427, seriesname: '蔚来ES8', brandname: '蔚来' },
      titlelist: [{ items: titles.map((itemname, i) => ({ itemname, titleid: i + 10 })) }], datalist: [spec(1, '5280'), spec(2, '5300'), spec(3, '5280')] };
    const groups = interpret(result, [1, 2], '2026-10-13T12:00:00+08:00');
    expect(groups).toHaveLength(1);
    expect(groups[0].model.length_mm).toBeUndefined();
    expect(groups[0].model.voltage_platform_v).toBe(800);
    const differentVoltage = structuredClone(result); differentVoltage.datalist[1].paramconflist[5].itemname = '900';
    expect(interpret(differentVoltage, [1, 2], 'now')[0].model.voltage_platform_v).toBeUndefined();
    expect(groups[0].trims.map(t => t.spec_id)).toEqual([1, 2]);
    expect(groups[0].trims[0].fields.trim_price_rmb).toBe(382800);
    expect(() => interpret(result, [4], 'now')).toThrow();
    const unknown = structuredClone(result); unknown.datalist[0].paramconflist[0].itemname = '';
    expect(() => interpret(unknown, [1], 'now')).toThrow('undisclosed energy');
    const erev = structuredClone(result); erev.titlelist[0].items.push({ itemname: '驱动方式', titleid: 99 });
    erev.datalist[0].paramconflist[0].itemname = '增程式';
    erev.datalist[0].paramconflist.push({ titleid: 99, itemname: '双电机四驱' });
    expect(interpret(erev, [1], 'now')[0].trims[0].fields.drivetrain_display).toEqual(['Dual-motor AWD']);
  });
});
