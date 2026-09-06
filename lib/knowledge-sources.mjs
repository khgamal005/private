// Official source pages checked on 2026-09-06. Runtime dry-run is required before
// activation; searchable pages alone do not prove that an automated fetch works.
const keywords=['تدريب','تعليم','مهارات','تأهيل','قدرات','تقنية','ذكاء اصطناعي','اعتماد','ريادة','منشآت'];
const source=(key,name,base,feed,pattern,extra={})=>({source_key:key,name,base_url:base,feed_url:feed,source_type:'html',trust_level:'official',is_active:false,requires_review:true,auto_publish:false,sync_frequency:'daily',include_keywords:keywords,exclude_keywords:[],default_content_type:'news',default_tags:['مصدر رسمي'],parser_config:{linkPattern:pattern,maxItems:12,...extra}});
export const KNOWLEDGE_SOURCES=[
 source('nelc-official-news','المركز الوطني للتعليم الإلكتروني','https://nelc.gov.sa','https://nelc.gov.sa/ar/media-center/news','^/(?:ar/)?media-center/news/[^/?#]+$',{paginationParam:'page',pageStart:0,maxPages:25}),
 source('hrsd-official-rss','وزارة الموارد البشرية والتنمية الاجتماعية','https://www.hrsd.gov.sa','https://www.hrsd.gov.sa/media-center/news','^/media-center/news/[^/?#]+$',{paginationParam:'page',pageStart:0,maxPages:25}),
 source('monshaat-official-news','الهيئة العامة للمنشآت الصغيرة والمتوسطة — منشآت','https://www.monshaat.gov.sa','https://www.monshaat.gov.sa/ar/news-posts-list','^/ar/node/[0-9]+$',{paginationParam:'page',pageStart:0,maxPages:25}),
 source('niepd-official-news','المعهد الوطني للتطوير المهني التعليمي','https://niepd.gov.sa','https://niepd.gov.sa/news','^/news/[^/?#]+$'),
 source('dga-official-news','هيئة الحكومة الرقمية','https://dga.gov.sa','https://dga.gov.sa/ar/news','^/ar/news/[^/?#]+$',{paginationParam:'page',pageStart:0,maxPages:20}),
];
