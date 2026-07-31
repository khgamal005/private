-- Keep the first production source set reliable and review-first.
begin;

-- The NELC home page exposes the latest official news cards with stable
-- /media-center/news/ links. It is lighter and more current than the archive
-- path on some language variants.
update public.knowledge_sources
set
  feed_url = 'https://nelc.gov.sa/',
  source_type = 'html',
  parser_config = '{
    "maxItems": 12,
    "linkPattern": "^/(?:ar/)?media-center/news/[^/?#]+$"
  }'::jsonb,
  is_active = true,
  requires_review = true,
  auto_publish = false,
  sync_frequency = 'daily',
  next_sync_at = now(),
  last_status = 'never',
  last_error = null,
  failure_count = 0,
  updated_at = now()
where source_key = 'nelc-official-news';

-- TVTC's public pages currently fail strict TLS validation from the Edge
-- runtime. Preserve the source for editors, but do not allow a scheduled job
-- to fail repeatedly or bypass certificate verification.
update public.knowledge_sources
set
  is_active = false,
  auto_publish = false,
  sync_frequency = 'manual',
  next_sync_at = null,
  last_status = 'paused',
  last_error = 'متوقف مؤقتًا حتى تتوفر قناة وصول رسمية بشهادة TLS موثوقة.',
  updated_at = now()
where source_key = 'tvtc-official-news';

-- Monsha’at remains configured for manual link-to-draft ingestion because the
-- public listing is too slow for a predictable scheduled Edge execution.
update public.knowledge_sources
set
  is_active = false,
  auto_publish = false,
  sync_frequency = 'manual',
  next_sync_at = null,
  last_status = 'paused',
  last_error = 'متوقف مؤقتًا لحين توفير RSS أو API رسمي مستقر للأخبار.',
  updated_at = now()
where source_key = 'monshaat-official-news';

-- All initial automated sources must remain human-reviewed. This explicit
-- guard makes accidental configuration drift fail closed.
update public.knowledge_sources
set
  requires_review = true,
  auto_publish = false,
  updated_at = now()
where source_key in (
  'hrsd-official-rss',
  'nelc-official-news',
  'tvtc-official-news',
  'monshaat-official-news',
  'etimad-competitions'
);

commit;
