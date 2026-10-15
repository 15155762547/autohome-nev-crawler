import{join}from'node:path';import{mkdir}from'node:fs/promises';import{BASE,source,save,load,sha,type Source}from'./collect';import{listingSchema,assertDiscovery}from'../../lib/vehicle-catalog-source';
export const salesStates=[{value:2,label:'在售'},{value:3,label:'预售'},{value:1,label:'停售'},{value:4,label:'未售'}]as const;
export async function discoverAll(run:string){
 await mkdir(run,{recursive:true});const page=await source(run,'all-page','https://www.autohome.com.cn/price/ev'),html=new TextDecoder().decode(page.raw),m=/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/.exec(html);if(!m)throw Error('Discovery page changed');const props=JSON.parse(m[1]).props.pageProps;if(props.type!=='ev'||props.searchtype!==6)throw Error('Wrong EV scope');
 const script=/src="(\/\/z\.autoimg\.cn\/[^" ]*pages\/carselect-[^" ]+\.js[^" ]*)"/.exec(html);if(!script)throw Error('State labels script not found');const labels=await source(run,'all-state-labels',`https:${script[1]}`),text=new TextDecoder().decode(labels.raw);for(const state of salesStates)if(!text.includes(`label:"${state.label}",value:"${state.value}"`))throw Error(`Unverified state label ${state.value}`);
 const union=new Map<number,any>(),scopes:any[]=[];
 for(const state of salesStates){const path=join(run,`discovery-state-${state.value}.json`);let complete:any;
  if(await Bun.file(path).exists()){complete=await load(path);for(const s of complete.pages as Source[])if(sha(new Uint8Array(await Bun.file(join(run,s.file)).arrayBuffer()))!==s.sha256)throw Error('Discovery source hash changed');}
  else{let total=0;const rows:any[]=[],pages:any[]=[];for(let p=1;p===1||p<=Math.ceil(total/20);p++){
   const s=await source(run,`all-${state.value}-${p}`,`${BASE}search/searchcar?searchtype=6&pageindex=${p}&pagesize=20&orderid=0&state=${state.value}`),v=JSON.parse(new TextDecoder().decode(s.raw));if(v.returncode!==0)throw Error('Discovery API error');const data=listingSchema.parse(v.result);if(p===1)total=data.seriescount;if(data.seriescount!==total)throw Error('State count changed during pagination');pages.push(s.info);rows.push(...data.seriesgrouplist);if(p%10===0)console.log(state.label,'directory pages',p);}
   if(total)assertDiscovery(rows,total);else if(rows.length)throw Error('Nonempty zero scope');complete={complete:true,state:state.value,label:state.label,total,rows,pages};await save(path,complete);
  }
  scopes.push({state:state.value,label:state.label,total:complete.total});for(const row of complete.rows){const old=union.get(row.seriesid);union.set(row.seriesid,{...row,specids:[...new Set([...(old?.specids??[]),...row.specids])],discovery_states:[...(old?.discovery_states??[]),state.value]});}
 }
 await save(join(run,'discovery.json'),{complete:true,filters:{searchtype:6,states:salesStates.map(s=>s.value)},all_sales_states:true,total:union.size,series:[...union.values()],scopes,fetched_at:page.info.fetched_at,state_labels_source:labels.info});console.log('All-state discovery',scopes,'unique series',union.size);
}
