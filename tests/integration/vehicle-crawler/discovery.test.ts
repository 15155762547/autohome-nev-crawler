import { expect, test, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discover,load } from '../../../scripts/vehicle-crawler/collect';
test('a changed page total is recorded while the live API cohort remains bounded and validated', async () => {
  const run=await mkdtemp(join(tmpdir(),'vehicle-discovery-'));
  const row={seriesid:6939,seriesname:'MEGA',seriesstate:20,specids:[78129]};
  const mocked=spyOn(globalThis,'fetch').mockImplementation(Object.assign(async(request:RequestInfo|URL)=>{
    const url=String(request),page=url.endsWith('/price/ev');
    const body=page?`<script id="__NEXT_DATA__">${JSON.stringify({props:{pageProps:{type:'ev',searchtype:6,seriesList:{seriescount:2,seriesgrouplist:[row]}}}})}</script>`:JSON.stringify({returncode:0,result:{seriescount:1,seriesgrouplist:[row]}});
    const r=new Response(body,{headers:{'content-type':page?'text/html':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;
  },{preconnect:fetch.preconnect}));
  try {await discover(run);const d=await load(join(run,'discovery.json'));expect(d.total).toBe(1);expect(d.complete).toBeTrue();expect(d.page_api_comparison).toEqual({page_total:2,api_total:1,page_only_ids:[],totals_match:false});}
  finally{mocked.mockRestore();await rm(run,{recursive:true,force:true});}
},30000);
