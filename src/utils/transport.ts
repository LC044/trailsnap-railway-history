import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute=promisify(execFile);
export function describeNetworkError(error:unknown,depth=0):string {
  if(depth>3)return '';
  const value=error as {message?:string,code?:string,cause?:unknown,errors?:unknown[]};
  return [value?.code,value?.message??String(error),
    value?.cause?describeNetworkError(value.cause,depth+1):'',
    ...(Array.isArray(value?.errors)?value.errors.map(e=>describeNetworkError(e,depth+1)):[])]
    .filter(Boolean).join('; ').replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/g,'$1[redacted]@');
}

/** curl uses the runner's HTTPS stack and CA store; certificate validation stays enabled. */
export async function fetchWithFallback(url:string,options:RequestInit,proxyUrl:string|null=null,
  fetcher:typeof fetch=fetch,runner:(args:string[])=>Promise<string>=async args=>{
    const result=await execute('curl',args,{timeout:20000,maxBuffer:16*1024*1024,windowsHide:true});
    return result.stdout;
  }):Promise<Response> {
  try {return await fetcher(url,options);}
  catch(error) {
    if((options.method??'GET')!=='GET' || options.body)throw error;
    console.warn(`[transport] ${new URL(url).hostname}: ${describeNetworkError(error)}; retrying GET with curl`);
    const args=['--silent','--show-error','--compressed','--location','--max-redirs','3',
      '--proto','=https','--proto-redir','=https','--connect-timeout','5','--max-time','15',
      '--write-out','\n%{http_code}'];
    if(proxyUrl)args.push('--proxy',proxyUrl);
    new Headers(options.headers).forEach((value,key)=>args.push('--header',`${key}: ${value}`));
    args.push('--url',url);
    try {
      const output=await runner(args),separator=output.lastIndexOf('\n');
      const status=Number(output.slice(separator+1));
      if(separator<0 || !Number.isInteger(status) || status<200 || status>599)throw new Error('Invalid curl HTTP response');
      return new Response([204,205,304].includes(status)?null:output.slice(0,separator),{status});
    } catch(fallbackError) {
      throw new Error(`HTTPS transports failed: fetch=${describeNetworkError(error)}; curl=${describeNetworkError(fallbackError)}`);
    }
  }
}
