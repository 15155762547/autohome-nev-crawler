import{join}from'node:path';import{readdir,rename,unlink,stat}from'node:fs/promises';import{createReadStream,createWriteStream}from'node:fs';import{pipeline}from'node:stream/promises';import{Transform}from'node:stream';import{createGzip}from'node:zlib';import{createHash}from'node:crypto';import{load,save}from'./collect';
/** Retain lossless, hashed backups while avoiding quadratic full-table snapshot storage across batches. */
export async function archiveBatch(dir:string){
 const manifestFile=join(dir,'compressed-backups.json'),manifest:any[]=await Bun.file(manifestFile).exists()?await load(manifestFile):[];
 for(const file of await readdir(dir)){
  if(!(/^(models|trims)-(before|prewrite|after).*\.(json|ndjson)$/.test(file)||['plan.json','field-audit.json','field-audit.csv'].includes(file)))continue;
  const path=join(dir,file),compressed=`${file}.${Date.now()}-${manifest.length}.gz`,dest=join(dir,compressed),hash=createHash('sha256'),size=(await stat(path)).size;
  const digest=new Transform({transform(chunk,encoding,callback){hash.update(chunk);callback(null,chunk);}});
  await pipeline(createReadStream(path),digest,createGzip(),createWriteStream(dest+'.tmp'));await rename(dest+'.tmp',dest);
  manifest.push({file,compressed,sha256:hash.digest('hex'),size,compressed_size:(await stat(dest)).size});await save(manifestFile,manifest);await unlink(path);
 }
}
