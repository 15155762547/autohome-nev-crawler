import { expect, test } from 'bun:test';
import { auditField, auditMarker, auditNotes, csvAudit, reconcileMaintained } from '../../../lib/vehicle-catalog-audit';
import { interpret } from '../../../lib/vehicle-catalog-source';

const data = { bread: { seriesid: 6939, seriesname: '理想MEGA', brandname: '理想汽车' },
  titlelist: [{ items: ['能源类型', '高压平台（V）', '后备厢容积(L)', '电池类型', '慢充接口位置'].map((itemname, titleid) => ({ itemname, titleid })) }],
  datalist: [{ specid: 78129, specname: '2026款 Home', specstatus: 20,
    paramconflist: ['纯电动', '800', '-', '三元锂电池', '车左后侧'].map((itemname, titleid) => ({ itemname, titleid })) }] };
const group = interpret(data, [78129], '2026-10-15T01:00:00Z')[0];
const audit = (name: string, type: string, actual?: unknown, candidate?: unknown) => auditField('models', group.key, { name, type }, actual, candidate, group, 'https://source');

test('field audit distinguishes source, business, formulas and unsupported structure technology', () => {
  expect(audit('voltage_platform_v', 'number', 800, group.model.voltage_platform_v).category).toBe('公开事实');
  expect(audit('boot_volume_l', 'number').category).toBe('来源未披露');
  expect(audit('airbags', 'number').category).toBe('条件不明确');
  expect(audit('battery_technology', 'select').category).toBe('来源未披露');
  expect(audit('Recommendation', 'select').category).toBe('公司业务');
  expect(audit('battery_capacity_min_kwh_auto', 'formula', '108').category).toBe('公式');
  expect(audit('i18n_translations', 'link').category).toBe('程序转换');
  expect(audit('unknown_field', 'text').category).toBe('代码未覆盖');
  expect(audit('household_charging', 'checkbox', false).reason).toContain('不是已核实不支持');
  expect(audit('household_charging', 'checkbox', false).reason).not.toContain('历史保留');
});
test('audit preserves raw numeric source and explains nonempty candidate differences', () => {
  const entry = audit('voltage_platform_v', 'number', 900, 800);
  expect(JSON.stringify(entry.raw)).toContain('800');
  expect(entry.reason).toContain('保留现值');
  expect(csvAudit([entry])).toContain('高压电气平台');
  expect(csvAudit([entry])).toContain('来源原值');
});
test('maintained source metadata refreshes but parameter and business values are protected', () => {
  const old = { last_verified_at: '2026-10-14T00:00:00Z', length_mm: 5000, Recommendation: ['1'], review_notes: 'old' };
  const desired = { last_verified_at: '2026-10-15T00:00:00Z', length_mm: 5100, Recommendation: ['2'], review_notes: 'new' };
  const result = reconcileMaintained(old, desired);
  expect(result.patch).toEqual({ last_verified_at: desired.last_verified_at, review_notes: 'new' });
  expect(result.conflicts.map(c => c.field)).toEqual(['length_mm']);
  expect(reconcileMaintained({ ...old, ...result.patch }, desired).patch).toEqual({});
});
test('audit section replacement is idempotent and preserves user text before and after', () => {
  const first = auditNotes('人工旧备注', 'first') + '\n人工追加备注';
  const second = auditNotes(first, 'second');
  expect(second.startsWith('人工旧备注')).toBeTrue();
  expect(second.endsWith('\n人工追加备注')).toBeTrue();
  expect(second.split(auditMarker)).toHaveLength(2);
  expect(second).not.toContain('first');
  expect(auditNotes(second, 'second')).toBe(second);
});
