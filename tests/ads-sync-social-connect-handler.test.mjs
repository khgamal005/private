import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import test from 'node:test';

function moduleUrl(source){
  return 'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
}

test('Social Connect sync authorizes the V2 owner and injects only its Vault token',async()=>{
  const originalDeno=globalThis.Deno,originalFetch=globalThis.fetch;
  let handler,adapterConnection,calls=[];
  const providerToken='provider-token-'.repeat(4);
  const sharedUrl=moduleUrl(`
    export class AdsSyncError extends Error {
      constructor(code,status=500,detail=''){super(code);this.code=code;this.status=status;this.detail=detail;}
    }
    export const asRecord=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:null;
    export const text=value=>value==null?'':String(value).trim();
    export const valueAt=(record,...paths)=>{for(const path of paths){if(record[path]!=null)return record[path];}return null;};
  `);
  const adapterUrl=moduleUrl(`
    export const metaAdapter={
      async test(connection){globalThis.__adsSyncCapture(connection);return {externalAccountId:'248340636978846',name:'Nesma Ahmed',currency:'EGP',status:'inactive',metadata:{}};},
      async *dimensions(){},async *metrics(){}
    };
    export const googleAdapter=metaAdapter;
    export const tiktokAdapter=metaAdapter;
    export const snapchatAdapter=metaAdapter;
  `);
  globalThis.__adsSyncCapture=value=>{adapterConnection=value;};
  globalThis.Deno={env:{get:key=>({
    SUPABASE_URL:'https://database.example',
    SUPABASE_ANON_KEY:'a'.repeat(32),
    SUPABASE_SERVICE_ROLE_KEY:'s'.repeat(32)
  })[key]},serve:fn=>{handler=fn;}};
  try{
    let source=await readFile(new URL('../supabase/functions/ads-sync/index.ts',import.meta.url),'utf8');
    source=source
      .replace(/import type \{[\s\S]*?\} from '\.\/types\.ts';/,'')
      .replace("'./shared.ts'",JSON.stringify(sharedUrl))
      .replace("'./adapters/meta.ts'",JSON.stringify(adapterUrl))
      .replace("'./adapters/google.ts'",JSON.stringify(adapterUrl))
      .replace("'./adapters/tiktok.ts'",JSON.stringify(adapterUrl))
      .replace("'./adapters/snapchat.ts'",JSON.stringify(adapterUrl));
    source=stripTypeScriptTypes(source,{mode:'transform'});
    await import(moduleUrl(source));
    globalThis.fetch=async(input,init={})=>{
      const url=new URL(input);calls.push({url,init});
      const reply=(data,status=200)=>new Response(JSON.stringify(data),{status});
      if(url.pathname.endsWith('authorize_ads_action'))return reply({
        tenantId:'tenant-1',connectionId:'meta-connection',
        marketingConnectionId:'marketing-connection',actorSubjectId:'actor-1'
      });
      if(url.pathname.endsWith('connection_configuration'))return reply({
        tenantId:'tenant-1',connectionId:'marketing-connection',providerKey:'meta',
        status:'draft',frequency:'daily',syncLookbackDays:30,apiVersion:'v26.0',
        configuration:{accountId:'248340636978846',authSource:'meta_connect_v2'},
        secrets:{accessToken:''},remoteMetadata:{}
      });
      if(url.pathname.endsWith('token_context'))return reply({
        tenantId:'tenant-1',connectionId:'meta-connection',accessToken:providerToken
      });
      if(url.pathname.endsWith('finish_test'))return reply({});
      if(url.pathname.endsWith('start_sync'))return reply({runId:'run-1',duplicate:false});
      if(url.pathname.endsWith('refresh_attribution'))return reply({});
      if(url.pathname.endsWith('finish_sync'))return reply({});
      throw new Error('Unexpected request: '+url.pathname);
    };

    const response=await handler(new Request('https://database.example/functions/v1/ads-sync',{
      method:'POST',headers:{authorization:'Bearer tenant-session','content-type':'application/json'},
      body:JSON.stringify({tenantSlug:'demo',provider:'meta',action:'sync_now',source:'social_connect'})
    }));
    const body=await response.json();
    assert.equal(response.status,200);
    assert.equal(body.success,true);
    assert.equal(adapterConnection.connectionId,'marketing-connection');
    assert.equal(adapterConnection.secrets.accessToken,providerToken);
    assert.equal(calls.some(call=>call.url.pathname.endsWith('authorize_sync')),false);
    assert.equal(calls.some(call=>call.url.pathname.endsWith('authorize_ads_action')),true);
    assert.equal(calls.some(call=>call.url.pathname.endsWith('token_context')),true);
    assert.doesNotMatch(JSON.stringify(body),/provider-token/);
  }finally{
    delete globalThis.__adsSyncCapture;
    globalThis.Deno=originalDeno;globalThis.fetch=originalFetch;
  }
});
