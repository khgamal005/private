const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseKnowledgeQuery(params){
 const get=key=>params.get(key)||null;
 const slug=get('tenant');if(!slug||!/^[-a-z0-9_]{1,100}$/i.test(slug))return null;
 const limit=Number(get('limit')||24),offset=Number(get('offset')||0);
 if(!Number.isInteger(limit)||limit<1||limit>60||!Number.isSafeInteger(offset)||offset<0)return null;
 for(const name of ['category','source'])if(get(name)&&!UUID.test(get(name)))return null;
 for(const name of ['from','to']){const v=get(name);if(v&&(!/^\d{4}-\d{2}-\d{2}$/.test(v)||Number.isNaN(new Date(v).getTime())||new Date(v).toISOString().slice(0,10)!==v))return null;}
 if(get('from')&&get('to')&&get('from')>get('to'))return null;
 if((get('search')||'').length>200)return null;
 const view=get('view')||'all',sort=get('sort')||'latest';
 if(!['all','active','expired','archive','important','saved'].includes(view)||!['latest','oldest','relevance'].includes(sort))return null;
 const type=get('type');if(type&&!['news','tender','event','regulation','article','market_pulse','success_story'].includes(type))return null;
 if(get('asOf')&&Number.isNaN(new Date(get('asOf')).getTime()))return null;
 return {p_slug:slug,p_search:get('search'),p_category:get('category'),p_content_type:type,p_view:view,p_source:get('source'),p_from:get('from'),p_to:get('to'),p_sort:sort,p_limit:limit,p_offset:offset,p_as_of:get('asOf')};
}
