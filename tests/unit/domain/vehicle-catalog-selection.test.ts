import { expect, test } from 'bun:test';
import { selectSeries } from '../../../lib/vehicle-catalog-selection';
test('bounded selection excludes IDs before counting and preserves discovery order', () => {
  expect(selectSeries([1, 2, 3, 4], [1, 3], 2)).toEqual([2, 4]);
  expect(() => selectSeries([1, 2], [1], 2)).toThrow();
  expect(() => selectSeries([1, 1], [], 1)).toThrow();
});
test('single series selection keeps exclusions and in-sale discovery binding', () => {
  expect(selectSeries([1, 2, 3], [1], 1, 3)).toEqual([3]);
  expect(() => selectSeries([1, 2], [1], 1, 1)).toThrow();
  expect(() => selectSeries([1, 2], [], 1, 3)).toThrow();
  expect(() => selectSeries([1, 2], [], 2, 2)).toThrow();
  expect(() => selectSeries([1, 2], [], 1, NaN)).toThrow();
});
test('explicit batch keeps requested order and rejects duplicates, absent or excluded IDs', () => {
  expect(selectSeries([1, 2, 3], [], 2, [3, 1])).toEqual([3, 1]);
  for (const ids of [[1, 1], [1, 4], [1, NaN]]) expect(() => selectSeries([1, 2, 3], [], 2, ids)).toThrow();
  expect(() => selectSeries([1, 2, 3], [2], 2, [1, 2])).toThrow();
  expect(() => selectSeries([1, 2], [], 1, [1, 2])).toThrow();
});
