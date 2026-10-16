import { z } from 'zod';
import { mergeParentGroups, same, empty, sourceIdentity, type Candidate, type Cells } from './vehicle-catalog-source';
export const catalogueSchema = z.object({version:z.literal(1),source:z.object({base_token:z.literal('Is6Xb3btbazhFhsDXgFcqFG1nRc'),models_rev:z.number(),trims_rev:z.number(),fetched_at:z.string()}),
  products:z.array(z.object({model_id:z.string(),record_id:z.string(),series_ids:z.array(z.number()),fields:z.object({MODEL:z.string(),brand:z.string(),model:z.string(),model_year:z.number().nullable(),powertrain_type:z.array(z.string()).length(1)}),
    specs:z.array(z.object({spec_id:z.number(),trim_config_id:z.string(),trim:z.string()}))}))});
export type Catalogue=z.infer<typeof catalogueSchema>;
export const catalogueRefreshFields=new Set(['length_mm','width_mm','height_mm','wheelbase_mm','0_100_km_h_sec','boot_volume_l','ground_clearance_mm','v2l_output_power_kw','voltage_platform_v','seats_min','seats_max','top_speed_min_kmh','top_speed_max_kmh','battery_technology','sunroof_availability','v2l_availability','ac_slow_charge_full_time_hours','ac_slow_charge_supported','battery_warranty_years','battery_warranty_distance_km','charging','vehicle_class','common_features_json_pruned']);
/** Company product grain: cross-year configurations, split energy. Ambiguous catalogue/old parents require review. */
export function catalogueCandidates(groups:Candidate[],catalogue:Catalogue,models:Cells[],trims:Cells[]):Candidate[]{
 const grouped=new Map<string,Candidate[]>();for(const g of groups){const key=`${g.series_id}/${g.energy}`;grouped.set(key,[...(grouped.get(key)??[]),g]);}
 return [...grouped.values()].map(parts=>{
  const g=parts.length===1?{...parts[0],model:{...parts[0].model}}:mergeParentGroups(parts),sid=g.series_id;
  const matches=catalogue.products.filter(p=>p.series_ids.includes(sid)&&p.fields.powertrain_type[0]===g.energy);
  if(matches.length>1)throw Error(`Company products ambiguous for ${sid}/${g.energy}: ${matches.map(p=>p.model_id).join(',')}`);
  const existing=[...new Set(trims.filter(t=>sourceIdentity(t)?.startsWith(`${sid}/`)).map(t=>String(t.model_id)).filter(id=>models.some(m=>m.model_id===id&&(m.powertrain_type as string[]??[]).includes(g.energy))))];
  if(existing.length>1)throw Error(`Existing same-energy products need review: ${sid}/${g.energy}`);
  const exactParents=[...new Set(g.trims.map(t=>trims.find(r=>sourceIdentity(r)===`${sid}/${t.spec_id}`)?.model_id).filter(Boolean))] as string[];
  if(exactParents.some(id=>!models.some(m=>m.model_id===id)))throw Error(`Deleted/missing parent requires review: ${sid}`);
  if(exactParents.length>1)throw Error(`Existing configurations span multiple parents: ${sid}`);
  const company=matches[0],parent=exactParents[0]??existing[0]??company?.model_id??`AUT-${sid}-${g.energy}`;
  if(company&&parent!==company.model_id)throw Error(`Existing/company identity conflict: ${sid}`);
  g.key=parent;
  if(company)Object.assign(g.model,company.fields);
  else if(parts.length>1)g.model.model_year=null;
  for(const field of catalogueRefreshFields)if(!(field in g.model)&&field!=='common_features_json_pruned')g.model[field]=null;
  g.trims=[...g.trims].sort((a,b)=>(typeof a.fields.trim_price_rmb==='number'?a.fields.trim_price_rmb:Infinity)-(typeof b.fields.trim_price_rmb==='number'?b.fields.trim_price_rmb:Infinity)||a.spec_id-b.spec_id).map((t,i)=>{
   const old=trims.find(r=>sourceIdentity(r)===`${sid}/${t.spec_id}`),r=company?.specs.find(s=>s.spec_id===t.spec_id);
   return {...t,fields:{...t.fields,trim:r?.trim ? r.trim.replace(/^\d{4}(?= MY\b)/, /^\d{4}/.exec(String(t.fields.trim))?.[0] ?? /^\d{4}/.exec(r.trim)?.[0] ?? '') : t.fields.trim,trim_config_id:old?.trim_config_id??r?.trim_config_id??`${parent}-${sid}-${t.spec_id}`,trim_order:i+1,...(typeof t.fields.trim_price_rmb==='number'?{trim_price_display:Math.round(t.fields.trim_price_rmb/6.74)}:{})}};
  });
  return g;
 });
}
export function cataloguePatch(old:Cells|undefined,desired:Cells,preserveUnknown=false):Cells{
 return Object.fromEntries([...catalogueRefreshFields].filter(f=>f in desired&&!(preserveUnknown&&empty(desired[f]))&&!(empty(old?.[f])&&empty(desired[f]))&&!same(old?.[f],desired[f])).map(f=>[f,desired[f]]));
}
