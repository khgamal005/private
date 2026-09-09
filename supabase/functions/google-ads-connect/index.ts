import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createGoogleAdsClient} from '../_shared/google-ads-client.mjs';
import {createGoogleAdsHandler} from './handler.mjs';

Deno.serve(createGoogleAdsHandler({
  env:(key:string)=>Deno.env.get(key),
  createClient:createGoogleAdsClient
}));
