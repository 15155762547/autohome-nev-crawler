import { expect, test } from 'bun:test';
import { selectSeries } from '../../../lib/vehicle-catalog-selection';
test('bounded selection excludes IDs before counting and preserves discovery order', () => {
  expect(selectSeries([1, 2, 3, 4], [1, 3], 2)).toEqual([2, 4]);
  expect(() => selectSeries([1, 2], [1], 2)).toThrow();
  expect(() => selectSeries([1, 1], [], 1)).toThrow();
});
