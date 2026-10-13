import { expect, test } from 'bun:test';
import { explicitSeries } from '../../../scripts/vehicle-crawler/exclusions';
test('source exclusions use IDs from URLs/notes rather than model name guesses', () => {
  expect(explicitSeries('https://www.autohome.com.cn/config/series/6298.html; Autohome series 6298')).toEqual([6298]);
  expect(explicitSeries('BYD SHARK official UK specifications 2026-08-13')).toEqual([]);
});
