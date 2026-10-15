import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remainingPatch, verifyBackup } from '../../../scripts/vehicle-crawler/company-migration';
import { save, sha } from '../../../scripts/vehicle-crawler/collect';
import { guardWrite, LAB } from '../../../scripts/vehicle-crawler/feishu';

test('partial migration resumes only remaining values, including primary text, null year and links', () => {
  const old = { model_year: 2026, _primary_text: 'AUT-8171-1', vehicle_model_pruned: [{ id: 'recOld' }] };
  const desired = { model_year: null, fldPrimary: 'MDL-009-8171-1', vehicle_model_pruned: [{ id: 'recNew' }] };
  const partial = { ...old, model_year: null, _primary_text: 'MDL-009-8171-1' };
  expect(remainingPatch(partial, old, desired, 'fldPrimary')).toEqual({ vehicle_model_pruned: [{ id: 'recNew' }] });
  expect(remainingPatch({ ...partial, vehicle_model_pruned: [{ id: 'recNew' }] }, old, desired, 'fldPrimary')).toEqual({});
  expect(() => remainingPatch({ ...partial, vehicle_model_pruned: [{ id: 'recThirdParty' }] }, old, desired, 'fldPrimary')).toThrow('Concurrent');
});
test('backup verifies actual bytes, missing files and incomplete manifests prevent retirement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ti7-backup-'));
  try {
    expect(await verifyBackup(dir, 'plan')).toBeFalse();
    await Bun.write(join(dir, 'photo.jpg'), 'original attachment bytes');
    const manifest = { complete: true, plan_sha: 'plan', files: [{ path: 'photo.jpg', sha256: sha('original attachment bytes') }] };
    await save(join(dir, 'manifest.json'), manifest);
    expect(await verifyBackup(dir, 'plan')).toBeTrue(); expect(await verifyBackup(dir, 'changed-plan')).toBeFalse();
    await Bun.write(join(dir, 'photo.jpg'), 'corrupt'); expect(await verifyBackup(dir, 'plan')).toBeFalse();
    await rm(join(dir, 'photo.jpg')); expect(await verifyBackup(dir, 'plan')).toBeFalse();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('generic synchronization still cannot delete even in the trial table', () => {
  expect(() => guardWrite(['+record-delete', '--base-token', LAB.base_token, '--table-id', LAB.tables.models, '--record-id', 'recAny'])).toThrow();
});
