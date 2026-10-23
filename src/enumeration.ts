import fs from 'node:fs';
import path from 'node:path';
import { PAGE_SIZE } from './constants';
import type { ITrain } from './services/train/model';

const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const validList=(value:unknown):value is ITrain[]=>Array.isArray(value) && value.every(
  row=>row && typeof row.train_no==='string' && typeof row.station_train_code==='string');

/** Cache successful HTTP responses, never treat a failed prefix as an empty result. */
export async function enumerateWithCheckpoint(roots:string[],queryDate:string,
  query:(prefix:string)=>Promise<ITrain[]>,checkpointPath:string,
  options:{rounds?:number,pause?:(ms:number)=>Promise<void>}={}) {
  const rounds=options.rounds??3,pause=options.pause??sleep;
  let responses:Record<string,ITrain[]>={};
  if(fs.existsSync(checkpointPath)) {
    const saved=JSON.parse(fs.readFileSync(checkpointPath,'utf8'));
    if(saved.schema_version===1 && saved.query_date===queryDate && JSON.stringify(saved.roots)===JSON.stringify(roots)
      && saved.responses && typeof saved.responses==='object' && !Array.isArray(saved.responses)
      && Object.values(saved.responses).every(validList)) {
      responses=saved.responses;
      console.log(`[list] resumed ${Object.keys(responses).length} prefixes for ${queryDate}`);
    }
  }
  const save=()=>{
    fs.mkdirSync(path.dirname(checkpointPath),{recursive:true});
    fs.writeFileSync(checkpointPath+'.tmp',JSON.stringify({schema_version:1,query_date:queryDate,roots,responses}));
    fs.renameSync(checkpointPath+'.tmp',checkpointPath);
  };
  const found=new Map<string,ITrain>();
  const completed=new Set<string>();
  let pending=[...roots];
  const failures=new Map<string,string>();
  for(let round=0;round<rounds && pending.length;round++) {
    const deferred:string[]=[];
    for(let i=0;i<pending.length;i++) {
      const prefix=pending[i];
      if(completed.has(prefix))continue;
      let list=responses[prefix];
      try {
        if(!Object.hasOwn(responses,prefix)) {
          list=await query(prefix);
          if(!validList(list))throw new Error('Invalid train list payload');
          responses[prefix]=list;save();
        }
      } catch(error) {
        const reason=error instanceof Error?error.message:String(error);
        failures.set(prefix,reason);deferred.push(prefix);
        console.warn(`[list] deferred ${prefix}, round ${round+1}/${rounds}: ${reason}`);
        continue;
      }
      completed.add(prefix);failures.delete(prefix);
      for(const train of list)found.set(`${train.train_no}|${train.station_train_code}`,train);
      if(list.length>=PAGE_SIZE) {
        if(prefix.length>=8)throw new Error(`Truncated enumeration: ${prefix}`);
        for(let child=0;child<=9;child++)pending.push(prefix+child);
      }
    }
    pending=deferred;
    if(pending.length && round<rounds-1)await pause((round+1)*15000);
  }
  if(pending.length)throw new Error(`Incomplete train enumeration (${queryDate}): ${[...failures].map(([prefix,reason])=>`${prefix}: ${reason}`).join('; ')}. Successful prefixes saved to ${checkpointPath}`);
  return found;
}
