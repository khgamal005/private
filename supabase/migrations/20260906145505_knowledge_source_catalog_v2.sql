-- Apply after knowledge-archive-v2.sql. Candidates remain paused until the new
-- worker dry-run verifies connectivity and useful parsed articles. Never replace
-- an existing source's editorial settings or reactivate a paused integration.
insert into public.knowledge_sources
 (source_key,name,base_url,feed_url,source_type,trust_level,is_active,
  requires_review,auto_publish,sync_frequency,default_content_type,
  default_tags,include_keywords,exclude_keywords,parser_config)
values
 ('niepd-official-news','المعهد الوطني للتطوير المهني التعليمي',
  'https://niepd.gov.sa','https://niepd.gov.sa/news','html','official',false,
  true,false,'daily','news',array['مصدر رسمي'],
  array['تدريب','تعليم','مهارات','تأهيل','قدرات','تقنية','ذكاء اصطناعي','اعتماد','ريادة','منشآت'],
  '{}'::text[],'{"linkPattern":"^/news/[^/?#]+$","maxItems":12}'::jsonb),
 ('dga-official-news','هيئة الحكومة الرقمية',
  'https://dga.gov.sa','https://dga.gov.sa/ar/news','html','official',false,
  true,false,'daily','news',array['مصدر رسمي'],
  array['تدريب','تعليم','مهارات','تأهيل','قدرات','تقنية','ذكاء اصطناعي','اعتماد','ريادة','منشآت'],
  '{}'::text[],'{"linkPattern":"^/ar/news/[^/?#]+$","maxItems":12,"paginationParam":"page","pageStart":0,"maxPages":20}'::jsonb)
on conflict (source_key) do nothing;
