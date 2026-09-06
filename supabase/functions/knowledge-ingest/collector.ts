import {type Source,type Item,text} from "./review.ts";
import {fetchText} from "./network.ts";
import {parseRss,parseJson,pageItem,listingLinks,nextListing} from "./parsers.ts";

export async function sourceItems(source:Source,{dryRun=false,stopAt=Date.now()+60_000,fetcher=fetchText}={}){
 const config=source.parser_config||{};
 const backfill=!dryRun&&source.backfill_cursor?.enabled===true;
 const cursor=backfill?source.backfill_cursor:{};
 const target=text(source.feed_url||source.base_url);
 if(source.source_type==='manual')throw new Error('knowledge_manual_source');
 if(!target)throw new Error('knowledge_source_url_missing');
 let listing=target;const page=Math.max(0,Number(cursor.page||0));
 if(cursor.nextUrl){const next=new URL(cursor.nextUrl);if(next.origin!==new URL(target).origin)throw new Error('knowledge_pagination_origin');listing=next.toString();}
 else if(page>0&&config.paginationParam){const u=new URL(target);u.searchParams.set(text(config.paginationParam),String(page+Number(config.pageStart||0)));listing=u.toString();}
 const remote=await fetcher(listing);
 if(source.source_type==='rss'||source.source_type==='atom'||/xml|rss|atom/.test(remote.type)){
  const items=parseRss(remote.body,100,remote.url);
  return {items:items.slice(0,dryRun?3:40),cursor:{...cursor,enabled:false,completedAt:new Date().toISOString()},discovered:items.length};
 }
 if(source.source_type==='json'||source.source_type==='api'||/json/.test(remote.type)){
  const items=parseJson(source,remote.body);
  return {items:items.slice(0,dryRun?3:40),cursor:{...cursor,enabled:false,completedAt:new Date().toISOString()},discovered:items.length};
 }
 const links=listingLinks(source,remote.body,remote.url);
 if(!links.length){if(backfill&&page>0)return {items:[],discovered:0,complete:true,cursor:{...cursor,enabled:false,completedAt:new Date().toISOString()}};throw new Error('knowledge_no_items_check_parser');}
 const signature=`${links.length}|${links[0]}|${links.at(-1)}`;
 if(backfill&&page>0&&!cursor.offset&&cursor.previousSignature===signature)return {items:[],discovered:links.length,complete:true,cursor:{...cursor,enabled:false,completedAt:new Date().toISOString(),reason:'pagination_not_advancing'}};
 const start=Math.max(0,Number(cursor.offset||0));
 const batch=dryRun?3:Math.max(1,Math.min(Number(config.maxItems||12),20));
 const items:Item[]=[];let offset=start;
 for(const url of links.slice(start,start+batch)){
  if(Date.now()>stopAt)break;
  const pageResponse=await fetcher(url,10_000);
  const item=pageItem(pageResponse.body,pageResponse.url);
  if(!item.title)throw new Error('knowledge_article_title_missing');
  items.push(item);offset++;
 }
 const next=nextListing(remote.body,remote.url);
 const exhausted=offset>=links.length;
 const canPage=Boolean(config.paginationParam||next);
 const maxPages=Math.max(1,Math.min(Number(config.maxPages||25),100));
 return {items,discovered:links.length,cursor:{...cursor,
  page:exhausted?page+1:page,offset:exhausted?0:offset,previousSignature:exhausted?signature:cursor.previousSignature,
  nextUrl:exhausted?(next||null):cursor.nextUrl||null,
  enabled:backfill&&(!exhausted||(canPage&&page+1<maxPages)),
  ...(exhausted&&(!canPage||page+1>=maxPages)?{completedAt:new Date().toISOString()}:{}),
 }};
}

