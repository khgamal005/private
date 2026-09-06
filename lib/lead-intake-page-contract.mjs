export const LEAD_INTAKE_PAGE_SIZE=100;
export const LEAD_INTAKE_PAGE_VERSION='lead-intake-page-v1';
export const LEAD_INTAKE_SECTIONS=['queue','assignments','batches'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTANT=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const instant=value=>typeof value==='string'&&INSTANT.test(value)
  &&Number.isFinite(Date.parse(value));
const nullableText=(value,max)=>value===null||value===undefined||value===''
  ?null:typeof value==='string'&&value.trim().length<=max
    ?value.trim()||null:false;
const date=value=>!value?null:typeof value==='string'
  &&/^\d{4}-\d{2}-\d{2}$/.test(value)
  &&Number.isFinite(Date.parse(value))
  &&new Date(value).toISOString().slice(0,10)===value?value:false;

export function parseLeadIntakePageRequest(body){
  if(!body||typeof body!=='object'||Array.isArray(body))return null;
  const slug=body.slug;
  const section=body.section;
  const from=date(body.from),to=date(body.to);
  const query=nullableText(body.query,100);
  const quality=nullableText(body.quality,64);
  const source=nullableText(body.source,200);
  const campaign=nullableText(body.campaign,500);
  const batchId=body.batchId||null;
  const validation=body.validation||null;
  const cursor=body.cursor||null;
  const anchor=body.anchor||null;
  if(typeof slug!=='string'||slug.length>64
    ||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
    ||!LEAD_INTAKE_SECTIONS.includes(section)
    ||[from,to,query,quality,source,campaign].includes(false)
    ||(from&&to&&from>to)
    ||(batchId&&!UUID.test(batchId))
    ||(validation&&!['awaiting','valid','duplicate','invalid'].includes(validation))
    ||(anchor&&!instant(anchor))
    ||(cursor&&(!UUID.test(cursor.id)||!instant(cursor.at)||!anchor))
    ||(section!=='queue'&&(batchId||validation)))return null;
  return {
    p_slug:slug,p_section:section,p_from:from,p_to:to,p_query:query,
    p_quality:quality,p_source:source,p_campaign:campaign,
    p_batch_id:batchId,p_validation:validation,
    p_limit:LEAD_INTAKE_PAGE_SIZE,p_anchor:anchor,
    p_after_at:cursor?.at||null,p_after_id:cursor?.id||null,
    p_include_total:!cursor
  };
}

export function validLeadIntakePage(data,section,limit=LEAD_INTAKE_PAGE_SIZE){
  return Boolean(data&&data.schemaVersion===LEAD_INTAKE_PAGE_VERSION
    &&data.section===section&&data.limit===limit&&instant(data.anchor)
    &&(data.total===null||(Number.isSafeInteger(data.total)&&data.total>=0))
    &&Array.isArray(data.records)&&data.records.length<=limit
    &&data.records.every(row=>row&&UUID.test(row.id))
    &&new Set(data.records.map(row=>row.id)).size===data.records.length
    &&typeof data.hasMore==='boolean'
    &&(data.hasMore
      ?data.records.length===limit&&data.nextCursor
        &&UUID.test(data.nextCursor.id)&&instant(data.nextCursor.at)
      :data.nextCursor===null));
}
