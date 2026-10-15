import { expect, test } from 'bun:test';
import { call, guardWrite, LAB, validateFields } from '../../../scripts/vehicle-crawler/feishu';
import { photosFromHtml } from '../../../scripts/vehicle-crawler/collect';
test('production, other tables and schema changes cannot be written', () => {
  const args = ['+record-batch-create', '--base-token', LAB.base_token, '--table-id', LAB.tables.models];
  expect(() => guardWrite(args)).not.toThrow();
  expect(() => guardWrite(args.map(x => x === LAB.base_token ? 'Is6Xb3btbazhFhsDXgFcqFG1nRc' : x))).toThrow();
  expect(() => guardWrite(args.map(x => x === '+record-batch-create' ? '+field-update' : x))).toThrow();
  expect(() => guardWrite(args.map(x => x === LAB.tables.models ? 'tblOther' : x))).toThrow();
});
test('omitting the write flag cannot bypass the production guard', async () => {
  await expect(call(['+record-batch-create', '--base-token', 'Is6Xb3btbazhFhsDXgFcqFG1nRc', '--table-id', LAB.tables.models], false, { create_records: [] })).rejects.toThrow();
});
test('schema validation rejects business, formulas and unknown enum values', () => {
  expect(() => validateFields({ length_mm: 100 }, [{ id: 'fld1', name: 'length_mm', type: 'number' }])).not.toThrow();
  expect(() => validateFields({ length_mm: '100' }, [{ id: 'fld1', name: 'length_mm', type: 'number' }])).toThrow();
  expect(() => validateFields({ Recommendation: ['1'] }, [{ id: 'fld1', name: 'Recommendation', type: 'select' }])).toThrow();
  expect(() => validateFields({ total: 100 }, [{ id: 'fld1', name: 'total', type: 'formula' }])).toThrow();
});
test('photos must belong to the exact selected spec and series', () => {
  const data = { props: { pageProps: { breadInfo: { seriesid: 4427 }, SeriesPicList: { picinfo: { callist: [{ claid: 1, list: [
    { specid: 1, picid: 1, mediatype: 0, picpath: 'http://car.autoimg.cn/1.jpg' }, { specid: 2, picid: 2, mediatype: 0, picpath: 'http://car.autoimg.cn/2.jpg' },
  ] }] } } } } };
  const html = `<script id="__NEXT_DATA__">${JSON.stringify(data)}</script>`;
  expect(photosFromHtml(html, 4427, [1]).map(x => x.spec_id)).toEqual([1]);
  expect(() => photosFromHtml(html, 5, [1])).toThrow();
});
test('configuration gallery parses speclist and rejects wrong bread spec, videos and other categories', () => {
  const props = { breadInfo: { seriesid: 8183, specid: 73544 }, SpecPicList: { speclist: [{ specid: 73544, piclist: [
    { specid: 73544, picid: 1, mediatype: 0, claid: 1, picpath: '//car.autoimg.cn/1.jpg' },
    { specid: 73544, picid: 2, mediatype: 0, claid: 10, picpath: 'https://car.autoimg.cn/2.jpg' },
    { specid: 73544, picid: 3, mediatype: 1, claid: 1, picpath: 'https://car.autoimg.cn/3.jpg' },
    { specid: 73544, picid: 4, mediatype: 0, claid: 3, picpath: 'https://car.autoimg.cn/4.jpg' },
    { specid: 9, picid: 5, mediatype: 0, claid: 1, picpath: 'https://car.autoimg.cn/5.jpg' },
  ] }] } };
  const html = `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: props } })}</script>`;
  expect(photosFromHtml(html, 8183, [73544]).map(p => [p.category_id, p.src])).toEqual([[1, 'https://car.autoimg.cn/1.jpg'], [10, 'https://car.autoimg.cn/2.jpg']]);
  expect(() => photosFromHtml(html, 8183, [9])).toThrow('spec identity');
});
