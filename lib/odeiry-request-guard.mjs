import {
  ODEIRY_JSON_LIMIT,
  ODEIRY_RATE_LIMIT,
  ODEIRY_RATE_WINDOW_MS,
  OdeiryContractError
} from './odeiry-contract.mjs';

export async function readOdeiryJson(request){
  const contentType=String(request?.headers?.get?.('content-type')||'')
    .split(';',1)[0]
    .trim()
    .toLowerCase();
  if(contentType!=='application/json'){
    throw new OdeiryContractError('odeiry_unsupported_media_type',415);
  }

  const declared=Number(request.headers.get('content-length')||0);
  if(!Number.isFinite(declared)||declared<0||declared>ODEIRY_JSON_LIMIT){
    throw new OdeiryContractError('odeiry_request_too_large',413);
  }

  const raw=await request.text();
  if(new TextEncoder().encode(raw).byteLength>ODEIRY_JSON_LIMIT){
    throw new OdeiryContractError('odeiry_request_too_large',413);
  }
  try{
    const parsed=JSON.parse(raw||'{}');
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)){
      throw new OdeiryContractError('odeiry_payload_invalid');
    }
    return parsed;
  }catch(error){
    if(error instanceof OdeiryContractError)throw error;
    throw new OdeiryContractError('odeiry_json_invalid');
  }
}

export class OdeiryRateLimiter{
  constructor({
    limit=ODEIRY_RATE_LIMIT,
    windowMs=ODEIRY_RATE_WINDOW_MS,
    maxKeys=10000
  }={}){
    this.limit=limit;
    this.windowMs=windowMs;
    this.maxKeys=maxKeys;
    this.entries=new Map();
    this.calls=0;
  }

  consume(key,now=Date.now()){
    if(typeof key!=='string'||!key){
      throw new OdeiryContractError('odeiry_rate_key_invalid',500);
    }
    this.calls+=1;
    if(this.calls%100===0)this.prune(now);

    const cutoff=now-this.windowMs;
    const recent=(this.entries.get(key)||[]).filter(stamp=>stamp>cutoff);
    if(recent.length>=this.limit){
      const retryMs=Math.max(1,recent[0]+this.windowMs-now);
      this.entries.set(key,recent);
      return {allowed:false,retryAfterSeconds:Math.ceil(retryMs/1000)};
    }
    recent.push(now);
    this.entries.set(key,recent);
    if(this.entries.size>this.maxKeys)this.prune(now,true);
    return {allowed:true,retryAfterSeconds:0};
  }

  prune(now=Date.now(),force=false){
    const cutoff=now-this.windowMs;
    for(const [key,stamps] of this.entries){
      const recent=stamps.filter(stamp=>stamp>cutoff);
      if(!recent.length)this.entries.delete(key);
      else this.entries.set(key,recent);
    }
    if(force&&this.entries.size>this.maxKeys){
      const overflow=this.entries.size-this.maxKeys;
      for(const key of [...this.entries.keys()].slice(0,overflow)){
        this.entries.delete(key);
      }
    }
  }
}
