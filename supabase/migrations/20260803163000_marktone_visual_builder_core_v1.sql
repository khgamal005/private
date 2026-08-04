begin;

create table if not exists website.page_documents (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references website.sites(id) on delete cascade,
  page_id uuid not null unique references website.pages(id) on delete cascade,
  schema_version integer not null default 1 check (schema_version = 1),
  draft_document jsonb not null default jsonb_build_object(
    'schemaVersion',1,
    'settings',jsonb_build_object('contentWidth','wide','background','#ffffff'),
    'blocks','[]'::jsonb
  ),
  published_document jsonb,
  draft_updated_at timestamptz not null default now(),
  published_at timestamptz,
  created_by_subject_id uuid references access_control.subjects(id) on delete set null,
  updated_by_subject_id uuid references access_control.subjects(id) on delete set null,
  published_by_subject_id uuid references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id,page_id)
);

create table if not exists website.page_document_versions (
  id uuid primary key default gen_random_uuid(),
  page_document_id uuid not null references website.page_documents(id) on delete cascade,
  version_number integer not null,
  version_kind text not null default 'draft'
    check (version_kind in ('draft','published','restored')),
  document jsonb not null,
  note text,
  created_by_subject_id uuid references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (page_document_id,version_number)
);

create index if not exists website_page_documents_site_page_idx
  on website.page_documents(site_id,page_id);
create index if not exists website_page_document_versions_history_idx
  on website.page_document_versions(page_document_id,version_number desc);

alter table website.page_documents enable row level security;
alter table website.page_document_versions enable row level security;

revoke all on table website.page_documents from public,anon,authenticated;
revoke all on table website.page_document_versions from public,anon,authenticated;
revoke all on all sequences in schema website from public,anon,authenticated;

create or replace function private_app.website_builder_validate_document(
  p_document jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_document jsonb:=coalesce(p_document,'{}'::jsonb);
  v_blocks jsonb;
  v_block jsonb;
  v_type text;
  v_id text;
  v_allowed constant text[]:=array[
    'hero','heading','text','image','buttons','cards','stats','columns',
    'quote','faq','cta','contact','divider','spacer'
  ];
begin
  if jsonb_typeof(v_document)<>'object' then
    raise exception 'builder_document_invalid';
  end if;
  if coalesce(v_document->>'schemaVersion','') !~ '^[0-9]+$'
     or (v_document->>'schemaVersion')::integer<>1 then
    raise exception 'builder_document_invalid';
  end if;
  if octet_length(v_document::text)>1000000 then
    raise exception 'builder_document_too_large';
  end if;

  v_blocks:=v_document->'blocks';
  if jsonb_typeof(v_blocks)<>'array' then
    raise exception 'builder_document_invalid';
  end if;
  if jsonb_array_length(v_blocks)>80 then
    raise exception 'builder_blocks_limit';
  end if;

  for v_block in select value from jsonb_array_elements(v_blocks) as block(value) loop
    if jsonb_typeof(v_block)<>'object' then
      raise exception 'builder_block_invalid';
    end if;
    v_id:=trim(coalesce(v_block->>'id',''));
    v_type:=trim(coalesce(v_block->>'type',''));
    if v_id !~ '^[A-Za-z0-9_-]{6,80}$' then
      raise exception 'builder_block_invalid';
    end if;
    if not (v_type=any(v_allowed)) then
      raise exception 'builder_block_type_invalid';
    end if;
    if jsonb_typeof(coalesce(v_block->'props','{}'::jsonb))<>'object'
       or jsonb_typeof(coalesce(v_block->'style','{}'::jsonb))<>'object'
       or jsonb_typeof(coalesce(v_block->'responsive','{}'::jsonb))<>'object' then
      raise exception 'builder_block_invalid';
    end if;
    if octet_length(v_block::text)>150000 then
      raise exception 'builder_block_invalid';
    end if;
  end loop;

  return jsonb_build_object(
    'schemaVersion',1,
    'settings',case
      when jsonb_typeof(v_document->'settings')='object'
      then v_document->'settings'
      else jsonb_build_object('contentWidth','wide','background','#ffffff')
    end,
    'blocks',v_blocks
  );
end;
$$;

revoke all on function private_app.website_builder_validate_document(jsonb)
from public,anon,authenticated;

create or replace function private_app.website_builder_record_version(
  p_page_document_id uuid,
  p_document jsonb,
  p_kind text,
  p_note text,
  p_subject_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_next integer;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('website-builder:'||p_page_document_id::text,0)
  );
  select coalesce(max(version.version_number),0)+1
  into v_next
  from website.page_document_versions version
  where version.page_document_id=p_page_document_id;

  insert into website.page_document_versions(
    page_document_id,version_number,version_kind,document,note,
    created_by_subject_id
  ) values (
    p_page_document_id,
    v_next,
    case when p_kind in ('draft','published','restored') then p_kind else 'draft' end,
    private_app.website_builder_validate_document(p_document),
    nullif(left(trim(coalesce(p_note,'')),240),''),
    p_subject_id
  );
  return v_next;
end;
$$;

revoke all on function private_app.website_builder_record_version(
  uuid,jsonb,text,text,uuid
) from public,anon,authenticated;

drop trigger if exists website_page_documents_touch_updated_at on website.page_documents;
create trigger website_page_documents_touch_updated_at
before update on website.page_documents
for each row execute function private_app.website_touch_updated_at();

with documents as (
  select
    page.id as page_id,
    page.site_id,
    page.status,
    case
      when jsonb_typeof(page.content)='object'
       and coalesce(page.content->>'schemaVersion','')='1'
       and jsonb_typeof(page.content->'blocks')='array'
      then private_app.website_builder_validate_document(page.content)
      else jsonb_build_object(
        'schemaVersion',1,
        'settings',jsonb_build_object(
          'contentWidth','wide',
          'background','#ffffff'
        ),
        'blocks',jsonb_build_array(
          jsonb_build_object(
            'id','hero-'||left(replace(page.id::text,'-',''),16),
            'type','hero',
            'props',jsonb_build_object(
              'anchor','',
              'eyebrow','ماركتون',
              'title',page.title,
              'body',coalesce(page.excerpt,''),
              'imageUrl',coalesce(page.cover_url,''),
              'imageAlt',page.title,
              'primaryLabel','تواصل معنا',
              'primaryHref','#contact',
              'secondaryLabel','',
              'secondaryHref',''
            ),
            'style',jsonb_build_object(
              'variant','dark','align','right','paddingY',96,
              'maxWidth','wide','background','','color',''
            ),
            'responsive',jsonb_build_object(
              'hideDesktop',false,'hideTablet',false,'hideMobile',false
            )
          ),
          jsonb_build_object(
            'id','text-'||left(replace(page.id::text,'-',''),16),
            'type','text',
            'props',jsonb_build_object(
              'anchor','details','content',coalesce(page.body,''),'columns',1
            ),
            'style',jsonb_build_object(
              'variant','light','align','right','paddingY',56,
              'maxWidth','reading','background','','color',''
            ),
            'responsive',jsonb_build_object(
              'hideDesktop',false,'hideTablet',false,'hideMobile',false
            )
          ),
          jsonb_build_object(
            'id','contact-'||left(replace(page.id::text,'-',''),16),
            'type','contact',
            'props',jsonb_build_object(
              'anchor','contact','eyebrow','تواصل معنا',
              'title','دعنا نفهم احتياجك',
              'body','اكتب نبذة قصيرة وسيتواصل معك فريق ماركتون.',
              'buttonLabel','إرسال الطلب'
            ),
            'style',jsonb_build_object(
              'variant','light','align','right','paddingY',80,
              'maxWidth','wide','background','','color',''
            ),
            'responsive',jsonb_build_object(
              'hideDesktop',false,'hideTablet',false,'hideMobile',false
            )
          )
        )
      )
    end as document
  from website.pages page
  where page.status<>'archived'
)
insert into website.page_documents(
  site_id,page_id,draft_document,published_document,published_at
)
select
  document.site_id,
  document.page_id,
  document.document,
  case when document.status='published' then document.document else null end,
  case when document.status='published' then now() else null end
from documents document
on conflict (page_id) do nothing;

update website.pages page
set content=document.published_document,
    template_key='visual-builder'
from website.page_documents document
where document.page_id=page.id
  and page.status='published'
  and document.published_document is not null;

commit;
