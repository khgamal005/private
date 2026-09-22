import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import {createZoomHandler} from './handler.mjs';
Deno.serve(createZoomHandler({env:(key:string)=>Deno.env.get(key)}));
