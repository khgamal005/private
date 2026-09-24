import {trainingRpc} from './training-server';
import {zoomGateway} from './zoom-server';

export async function zoomSnapshot(slug,view='sessions',options={}){
 const data=await trainingRpc('v1_zoom_snapshot',{p_slug:slug,p_view:view,p_options:options});
 const extra=[];
 if((data.permissions?.accounts||data.permissions?.sessions))extra.push(zoomGateway('setup',{tenantSlug:slug})
  .then(setup=>{data.setup=setup;})
  .catch(()=>{data.setup={available:false};}));
 if(data.permissions?.sessions&&view==='sessions')extra.push(trainingRpc('v1_zoom_replacement_snapshot',{p_slug:slug}).then(rows=>{data.replacements=rows;}));
 await Promise.all(extra);
 return data;
}
