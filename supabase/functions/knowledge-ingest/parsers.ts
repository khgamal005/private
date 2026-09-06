import type {Item,Source} from './review.ts';
export function decode(value:string){return String(value||'').replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi,(_,key)=>{if(key[0]==='#'){const hex=key[1]?.toLowerCase()==='x';const n=parseInt(key.slice(hex?2:1),hex?16:10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):' ';}return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '} as Record<string,string>)[key.toLowerCase()]||' ';});}
export function stripHtml(value:string){return decode(String(value||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<(script|style|nav|header|footer)\b[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();}
export function normalizeUrl(value:string,base?:string){
 if(!String(value||'').trim())return '';
 try{const url=new URL(decode(value),base||undefined);if(url.protocol!=='https:'||url.username||url.password)return '';url.hash='';for(const key of [...url.searchParams.keys()])if(/^utm_|^(fbclid|gclid)$/i.test(key))url.searchParams.delete(key);return url.toString();}catch{return '';}
}
function attr(block:string,key:string){return decode(block.match(new RegExp(`\\b${key}\\s*=\\s*["']([^"']+)["']`,'i'))?.[1]||'');}
function rawTag(block:string,key:string){return (block.match(new RegExp(`<${key}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${key}>`,'i'))?.[1]||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1');}
function tag(block:string,key:string){return stripHtml(rawTag(block,key));}
function dateValue(value:string){const date=new Date(value||'');return Number.isNaN(date.getTime())?undefined:date.toISOString();}
export function meta(html:string,key:string){for(const match of html.matchAll(/<meta\b[^>]*>/gi)){if([attr(match[0],'property'),attr(match[0],'name')].includes(key))return attr(match[0],'content');}return '';}
function imageIn(html:string,base:string){
 const image=html.match(/<img\b[^>]*>/i)?.[0]||'';
 return normalizeUrl(attr(image,'data-src')||attr(image,'src'),base);
}
export function pageItem(html:string,url:string):Item{
 const article=html.match(/<article\b[\s\S]*?<\/article>/i)?.[0]||html.match(/<main\b[\s\S]*?<\/main>/i)?.[0]||'';
 const content=stripHtml(article);
 const generic=meta(html,'og:description')||meta(html,'description')||meta(html,'twitter:description');
 const excerpt=generic&&!/مركز مستقل تأسس|موقع حكومي رسمي|جميع الحقوق محفوظة/.test(generic)?generic:stripHtml(article.match(/<p\b[^>]*>[\s\S]*?<\/p>/i)?.[0]||'');
 const image=normalizeUrl(meta(html,'og:image')||meta(html,'twitter:image'),url)||imageIn(article,url);
 const time=attr(html.match(/<time\b[^>]*>/i)?.[0]||'','datetime');
 return {externalId:url,url,title:stripHtml(meta(html,'og:title')||meta(html,'twitter:title')||tag(html,'h1')||tag(html,'title')),excerpt:stripHtml(excerpt).slice(0,800),content:content.slice(0,12000),image,publishedAt:dateValue(meta(html,'article:published_time')||meta(html,'datePublished')||time),payload:{format:'html'}};
}
export function parseRss(xml:string,maxItems=40,base=''):Item[]{
 return [...xml.matchAll(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi)].slice(0,maxItems).map(([block])=>{
  const link=tag(block,'link')||attr(block.match(/<link\b[^>]*>/i)?.[0]||'','href');
  const url=normalizeUrl(link,base);const raw=rawTag(block,'content:encoded')||rawTag(block,'content')||rawTag(block,'description')||rawTag(block,'summary');
  const media=[...block.matchAll(/<(?:media:content|media:thumbnail|enclosure)\b[^>]*>/gi)].map(x=>x[0]).find(x=>!attr(x,'type')||attr(x,'type').startsWith('image/'))||'';
  return {externalId:tag(block,'guid')||tag(block,'id')||url,url,title:tag(block,'title'),excerpt:stripHtml(raw).slice(0,800),content:stripHtml(raw).slice(0,12000),image:normalizeUrl(attr(media,'url'),url)||imageIn(raw,url),publishedAt:dateValue(tag(block,'pubDate')||tag(block,'published')||tag(block,'updated')),payload:{format:'rss'}};
 }).filter(x=>x.url&&x.title);
}
export function listingLinks(source:Source,html:string,listingUrl:string){
 const origin=new URL(source.base_url||listingUrl).hostname.replace(/^www\./,'');
 const pattern=source.parser_config?.linkPattern;
 if(!pattern)throw new Error('knowledge_link_pattern_required');
 if(String(pattern).length>200)throw new Error('knowledge_link_pattern_too_long');
 const matcher=new RegExp(pattern,'i');const links=new Set<string>();
 for(const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)){
  const url=normalizeUrl(m[1],listingUrl);if(!url)continue;const p=new URL(url);
  if(p.hostname.replace(/^www\./,'')!==origin||url===normalizeUrl(listingUrl)||!matcher.test(p.pathname))continue;
  links.add(url);
 }
 return [...links].slice(0,500);
}
export function nextListing(html:string,url:string){
 for(const match of html.matchAll(/<(?:a|link)\b[^>]*>/gi)){if(attr(match[0],'rel').split(/\s+/).includes('next')){const next=normalizeUrl(attr(match[0],'href'),url);if(next&&new URL(next).origin===new URL(url).origin)return next;}}
 return '';
}
function getPath(value:any,path:string){return path.split('.').filter(Boolean).reduce((v,k)=>v?.[k],value);}
export function parseJson(source:Source,body:string):Item[]{
 const c=source.parser_config||{};const parsed=JSON.parse(body);const rows=getPath(parsed,c.itemsPath||'')||parsed;
 if(!Array.isArray(rows))throw new Error('knowledge_json_items_missing');
 return rows.slice(0,100).map((row:any)=>({externalId:String(getPath(row,c.idPath||'id')||''),url:normalizeUrl(String(getPath(row,c.urlPath||'url')||''),source.base_url),title:stripHtml(String(getPath(row,c.titlePath||'title')||'')),excerpt:stripHtml(String(getPath(row,c.excerptPath||'description')||'')).slice(0,800),content:stripHtml(String(getPath(row,c.contentPath||'content')||'')).slice(0,12000),image:normalizeUrl(String(getPath(row,c.imagePath||'image')||''),source.base_url),publishedAt:dateValue(String(getPath(row,c.datePath||'published_at')||'')),payload:{format:'json'}})).filter((x:Item)=>x.title&&x.url);
}
