create schema if not exists website;

comment on schema website is 'Private content management schema for the public Marktone website.';

create table if not exists website.sites (
  id uuid primary key default gen_random_uuid(),
  site_key text not null unique,
  name_ar text not null,
  name_en text,
  status text not null default 'published'
    check (status in ('draft','published','maintenance')),
  settings jsonb not null default '{}'::jsonb,
  theme jsonb not null default '{}'::jsonb,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists website.menu_items (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references website.sites(id) on delete cascade,
  label text not null,
  href text not null,
  item_kind text not null default 'anchor'
    check (item_kind in ('anchor','page','article','external','system')),
  open_in_new_tab boolean not null default false,
  sort_order integer not null default 100,
  is_visible boolean not null default true,
  status text not null default 'published'
    check (status in ('draft','published','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists website.sections (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references website.sites(id) on delete cascade,
  section_key text not null,
  section_type text not null default 'cards',
  eyebrow text,
  title text not null,
  summary text,
  body text,
  primary_cta jsonb not null default '{}'::jsonb,
  secondary_cta jsonb not null default '{}'::jsonb,
  items jsonb not null default '[]'::jsonb,
  media jsonb not null default '{}'::jsonb,
  style_variant text not null default 'light',
  sort_order integer not null default 100,
  is_visible boolean not null default true,
  status text not null default 'published'
    check (status in ('draft','published','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, section_key)
);

create table if not exists website.pages (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references website.sites(id) on delete cascade,
  slug text not null,
  title text not null,
  menu_label text,
  excerpt text,
  body text not null default '',
  content jsonb not null default '{}'::jsonb,
  template_key text not null default 'standard',
  seo_title text,
  seo_description text,
  cover_url text,
  show_in_menu boolean not null default false,
  menu_order integer not null default 100,
  status text not null default 'draft'
    check (status in ('draft','published','archived')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, slug)
);

create table if not exists website.articles (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references website.sites(id) on delete cascade,
  slug text not null,
  title text not null,
  excerpt text,
  body text not null default '',
  category text,
  author_name text,
  cover_url text,
  seo_title text,
  seo_description text,
  featured boolean not null default false,
  status text not null default 'draft'
    check (status in ('draft','published','archived')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, slug)
);

create table if not exists website.contact_submissions (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references website.sites(id) on delete cascade,
  reference_key text not null unique,
  name text not null,
  email text,
  phone text,
  organization text,
  message text not null,
  source_page text,
  status text not null default 'new'
    check (status in ('new','in_progress','resolved','spam','archived')),
  ip_hash text,
  user_agent text,
  consent_at timestamptz,
  handled_by_subject_id uuid references access_control.subjects(id) on delete set null,
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists website.content_revisions (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references website.sites(id) on delete cascade,
  entity_type text not null
    check (entity_type in ('site','menu_item','section','page','article')),
  entity_id uuid not null,
  revision_number integer not null,
  snapshot jsonb not null,
  created_by_subject_id uuid references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (entity_type, entity_id, revision_number)
);

create index if not exists website_menu_items_site_order_idx
  on website.menu_items(site_id, status, is_visible, sort_order);
create index if not exists website_sections_site_order_idx
  on website.sections(site_id, status, is_visible, sort_order);
create index if not exists website_pages_site_status_idx
  on website.pages(site_id, status, updated_at desc);
create index if not exists website_articles_site_status_date_idx
  on website.articles(site_id, status, published_at desc, updated_at desc);
create index if not exists website_contact_submissions_status_date_idx
  on website.contact_submissions(site_id, status, created_at desc);
create index if not exists website_contact_submissions_ip_date_idx
  on website.contact_submissions(ip_hash, created_at desc)
  where ip_hash is not null;
create index if not exists website_content_revisions_entity_idx
  on website.content_revisions(entity_type, entity_id, revision_number desc);

alter table website.sites enable row level security;
alter table website.menu_items enable row level security;
alter table website.sections enable row level security;
alter table website.pages enable row level security;
alter table website.articles enable row level security;
alter table website.contact_submissions enable row level security;
alter table website.content_revisions enable row level security;

revoke all on schema website from public, anon, authenticated;
revoke all on all tables in schema website from public, anon, authenticated;
revoke all on all sequences in schema website from public, anon, authenticated;
alter default privileges in schema website revoke all on tables from public, anon, authenticated;
alter default privileges in schema website revoke all on sequences from public, anon, authenticated;

create or replace function private_app.website_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private_app.website_touch_updated_at() from public, anon, authenticated;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'sites','menu_items','sections','pages','articles','contact_submissions'
  ] loop
    execute format('drop trigger if exists website_touch_updated_at on website.%I',v_table);
    execute format(
      'create trigger website_touch_updated_at before update on website.%I for each row execute function private_app.website_touch_updated_at()',
      v_table
    );
  end loop;
end;
$$;

insert into access_control.permissions(
  permission_key,module_key,name_ar,description
)
values(
  'platform.website.manage',
  'platform',
  'إدارة موقع ماركتون',
  'إدارة القائمة والصفحات والمقالات ومحتوى الموقع العام'
)
on conflict (permission_key) do update
set module_key=excluded.module_key,
    name_ar=excluded.name_ar,
    description=excluded.description;

insert into access_control.role_permissions(role_id,permission_key)
select distinct rp.role_id,'platform.website.manage'
from access_control.role_permissions rp
where rp.permission_key='platform.control.write'
on conflict do nothing;

create or replace function private_app.website_admin_subject()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_subject_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;
  if not private_app.has_platform_permission('platform.website.manage') then
    raise exception 'forbidden';
  end if;

  select s.id
  into v_subject_id
  from access_control.subjects s
  where s.auth_user_id=auth.uid()
    and s.status='active'
    and not s.must_change_password
  limit 1;

  if v_subject_id is null then
    raise exception 'account_not_linked';
  end if;
  return v_subject_id;
end;
$$;

revoke all on function private_app.website_admin_subject() from public, anon, authenticated;

create or replace function private_app.website_record_revision(
  p_site_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_snapshot jsonb,
  p_subject_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_next integer;
begin
  if p_entity_id is null or p_snapshot is null then
    return;
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(p_entity_type||':'||p_entity_id::text,0)
  );
  select coalesce(max(r.revision_number),0)+1
  into v_next
  from website.content_revisions r
  where r.entity_type=p_entity_type
    and r.entity_id=p_entity_id;

  insert into website.content_revisions(
    site_id,entity_type,entity_id,revision_number,snapshot,created_by_subject_id
  ) values (
    p_site_id,p_entity_type,p_entity_id,v_next,p_snapshot,p_subject_id
  );
end;
$$;

revoke all on function private_app.website_record_revision(uuid,text,uuid,jsonb,uuid)
from public, anon, authenticated;

insert into website.sites(
  site_key,name_ar,name_en,status,settings,theme,published_at
)
values(
  'marktone-main',
  'ماركتون',
  'Marktone',
  'published',
  jsonb_build_object(
    'siteTitle','ماركتون | منظومات نمو للمؤسسات',
    'description','ماركتون منظومة تشغيل ونمو متخصصة تساعد المؤسسات ومراكز التدريب على ربط التسويق والمبيعات والتشغيل والبيانات في مسار واحد قابل للقياس.',
    'customerLoginLabel','دخول العملاء',
    'customerLoginUrl','/login',
    'contactCtaLabel','تواصل معنا',
    'contactCtaUrl','#contact',
    'contactEmail','hello@marktone.sa',
    'contactPhone','',
    'country','المملكة العربية السعودية',
    'footerText','ماركتون — منظومة تشغيل ونمو متخصصة للمؤسسات ومراكز التدريب.'
  ),
  jsonb_build_object(
    'navy','#06182e',
    'navySoft','#0b2949',
    'gold','#e6b34e',
    'paper','#f7f2e8',
    'white','#ffffff'
  ),
  now()
)
on conflict (site_key) do nothing;

insert into website.menu_items(
  site_id,label,href,item_kind,sort_order,is_visible,status
)
select s.id,x.label,x.href,'anchor',x.sort_order,true,'published'
from website.sites s
cross join (values
  ('الرئيسية','#home',10),
  ('من نحن','#about',20),
  ('منظومتنا','#system',30),
  ('الحلول','#solutions',40),
  ('الأثر','#impact',50)
) as x(label,href,sort_order)
where s.site_key='marktone-main'
  and not exists(
    select 1 from website.menu_items m
    where m.site_id=s.id and m.href=x.href
  );

insert into website.sections(
  site_id,section_key,section_type,eyebrow,title,summary,body,
  primary_cta,secondary_cta,items,media,style_variant,sort_order,is_visible,status
)
select s.id,x.section_key,x.section_type,x.eyebrow,x.title,x.summary,x.body,
       x.primary_cta,x.secondary_cta,x.items,x.media,x.style_variant,
       x.sort_order,true,'published'
from website.sites s
cross join (values
  (
    'home','hero','استشارات تطوير إداري وتشغيلي',
    'نبني مؤسسات تصنع أثرًا مستدامًا',
    'نحوّل الاستراتيجية إلى منظومة عمل مترابطة تجمع التسويق والمبيعات والتشغيل والبيانات في مسار واحد قابل للقياس.',
    'من التشخيص إلى التنفيذ ثم القياس والتحسين المستمر، تعمل ماركتون كشريك تشغيل ونمو لا كمورد منفصل.',
    '{"label":"اكتشف منهجنا","href":"#system"}'::jsonb,
    '{"label":"تحدث مع خبير","href":"#contact"}'::jsonb,
    '[{"title":"رؤية واحدة للنمو","description":"تسويق ومبيعات وتشغيل وبيانات في منظومة مترابطة"},{"title":"قرارات قابلة للقياس","description":"مؤشرات واضحة بدل الإدارة بالانطباع"}]'::jsonb,
    '{"badge":"منظومة مترابطة","caption":"رؤية واحدة للنمو"}'::jsonb,
    'dark',10
  ),
  (
    'about','journey','رحلتك معنا','أين تبدأ رحلتك معنا؟',
    'نبدأ بالتشخيص قبل الحل، ونحوّل الملاحظات المتفرقة إلى خريطة واضحة تحدد الأولويات والفرص وخطوات التنفيذ.',
    'لا نقدم قالبًا جاهزًا؛ نقرأ الواقع التشغيلي والبيانات ورحلة العميل ثم نبني المسار الأنسب للمؤسسة.',
    '{}'::jsonb,'{}'::jsonb,
    '[{"title":"فهم الوضع الحالي","description":"قراءة دقيقة للمشهد والتحديات"},{"title":"تحليل البيانات","description":"تحويل الأرقام إلى مؤشرات قابلة للتصرف"},{"title":"تحديد فرص النمو","description":"ترتيب الأولويات حسب أثرها الحقيقي"},{"title":"بناء خطة واضحة","description":"مسار تنفيذ بمسؤوليات ومقاييس محددة"}]'::jsonb,
    '{"caption":"نبدأ من الحقيقة، لا من الافتراض"}'::jsonb,
    'light',20
  ),
  (
    'system','system','منظومة واحدة','إمكاناتك… في كل جزء من منظومتك',
    'نربط المحاور التي تعمل منفصلة ونحوّلها إلى منظومة نمو واحدة تتغذى من البيانات وتتحسن باستمرار.',
    'المشكلة غالبًا ليست في غياب الأدوات، بل في عملها دون رابط تشغيلي موحد.',
    '{"label":"شاهد كيف تتحرك المنظومة","href":"#engine"}'::jsonb,'{}'::jsonb,
    '[{"title":"الاستراتيجية","description":"أهداف واختيارات واضحة"},{"title":"التسويق","description":"استقطاب يمكن قياسه"},{"title":"المبيعات","description":"تحويل منضبط للفرص"},{"title":"خدمة العملاء","description":"متابعة وتجربة مستمرة"},{"title":"التحول الرقمي","description":"أتمتة وربط للأنظمة"},{"title":"الجودة والحوكمة","description":"معايير ووضوح للمسؤوليات"}]'::jsonb,
    '{}'::jsonb,'dark',30
  ),
  (
    'engine','process','محرك النمو','خمسة محاور تعمل معًا لتحريك النمو',
    'منهجية مترابطة تبدأ بفهم السوق وتنتهي بنمو قابل للتوسع، وكل محور يغذي المحور الذي يليه.',
    'يتم تحويل كل محور إلى مهام ومسؤوليات ومؤشرات داخل النظام التشغيلي.',
    '{"label":"استكشف المنهجية","href":"#gap"}'::jsonb,'{}'::jsonb,
    '[{"title":"دراسة السوق","description":"فهم المنافسة والفرص وسلوك العميل"},{"title":"استقطاب العملاء","description":"قنوات واضحة لجذب الفرص المؤهلة"},{"title":"المبيعات","description":"رحلة تحويل منضبطة قابلة للقياس"},{"title":"خدمة العملاء","description":"متابعة وتجربة تعززان الثقة والولاء"},{"title":"النمو والتوسع","description":"قرارات أسرع ونمو يمكن تكراره"}]'::jsonb,
    '{}'::jsonb,'paper',40
  ),
  (
    'gap','comparison','التحول','من الفجوة إلى القمة',
    'نحوّل التحديات اليومية إلى نظام تشغيلي متكامل يختصر الوقت، يرفع الكفاءة، ويقود إلى نتائج قابلة للقياس.',
    'التحول الحقيقي يظهر عندما تصبح البيانات والمتابعة والمسؤوليات جزءًا من روتين العمل اليومي.',
    '{}'::jsonb,'{}'::jsonb,
    '[{"title":"قبل","description":"عمليات منفصلة، بيانات متأخرة، تسرب في المتابعة، قرارات بالانطباع"},{"title":"بعد","description":"عمليات مترابطة، رؤية لحظية، متابعة مستمرة، قرارات بالبيانات"}]'::jsonb,
    '{}'::jsonb,'dark',50
  ),
  (
    'team','team','تمكين الفريق','نُمكّن فريقك لنُمكّن مؤسستك',
    'ننقل المعرفة إلى الداخل، ونبني قدرات الفريق ليقود التشغيل والتحسين بعد انتهاء المشروع.',
    'التقنية وحدها لا تكفي؛ لذلك نربط الأدوات بالتدريب وأدلة العمل والمتابعة الإدارية.',
    '{"label":"تعرّف على برامجنا","href":"#contact"}'::jsonb,'{}'::jsonb,
    '[{"title":"كفاءة أعلى","description":"تقليل الهدر والعمل المتكرر"},{"title":"فريق متمكن","description":"أدوار واضحة وأدلة عمل"},{"title":"قيادة واضحة","description":"لوحات متابعة ومؤشرات"},{"title":"أثر مستمر","description":"تحسين لا يتوقف بانتهاء المشروع"}]'::jsonb,
    '{}'::jsonb,'light',60
  ),
  (
    'data','metrics','البيانات','كل قرار يبدأ من رقم واضح',
    'نوحّد البيانات من الحملات والمتاجر والمبيعات وخدمة العملاء لنقدم رؤية تشغيلية واحدة.',
    'من معرفة مصدر العميل إلى قياس العائد على الإنفاق الإعلاني وأداء الموظف، تظهر الصورة في مكان واحد.',
    '{}'::jsonb,'{}'::jsonb,
    '[{"title":"رحلة العميل","description":"تتبّع المصدر والتفاعل والتحويل"},{"title":"أداء الفريق","description":"مبيعات ومهام ومكالمات ومتابعات"},{"title":"كفاءة الحملات","description":"تكلفة العميل والتحويل وROAS"},{"title":"جودة التشغيل","description":"اختناقات ومواعيد ومستوى الإنجاز"}]'::jsonb,
    '{}'::jsonb,'dark',70
  ),
  (
    'impact','impact','الأثر','نقيس ما يتغير، لا ما يتم تنفيذه فقط',
    'كل مبادرة ترتبط بمؤشر قبل وبعد، حتى يعرف صاحب القرار أين تحققت القيمة وما الذي يحتاج إلى تحسين.',
    'الهدف هو بناء قدرة مؤسسية مستدامة، وليس مجرد تسليم مخرجات منفصلة.',
    '{}'::jsonb,'{}'::jsonb,
    '[{"title":"وضوح أكبر","description":"رؤية موحدة للعمليات والأولويات"},{"title":"تحويل أعلى","description":"متابعة أفضل للفرص والعملاء"},{"title":"زمن أقل","description":"أتمتة المهام المتكررة"},{"title":"نمو قابل للتوسع","description":"نظام يمكن تكراره وتطويره"}]'::jsonb,
    '{}'::jsonb,'paper',80
  ),
  (
    'solutions','solutions','حلول متخصصة','حل واحد لا يناسب كل مؤسسة',
    'نختار المزيج الأنسب من الاستشارات والتشغيل والتقنية والتدريب وفق المرحلة والتحدي.',
    'يمكن البدء بمحور واحد ثم التوسع تدريجيًا داخل نفس المنظومة.',
    '{"label":"اطلب جلسة تشخيص","href":"#contact"}'::jsonb,'{}'::jsonb,
    '[{"title":"التسويق والنمو","description":"استراتيجية وحملات وصفحات هبوط وقياس"},{"title":"المبيعات وخدمة العملاء","description":"فرق ومتابعة ومسارات تحويل واتصالات"},{"title":"منصة التشغيل","description":"CRM وأتمتة وتقارير وربط المتاجر"},{"title":"الاستشارات والحوكمة","description":"مؤشرات وإجراءات وجودة وتطوير مؤسسي"},{"title":"التدريب والمحتوى","description":"حقائب وبرامج ومنصات تعلم"},{"title":"الشراكات الدولية","description":"تعاون أكاديمي وتطوير منتجات"}]'::jsonb,
    '{}'::jsonb,'light',90
  ),
  (
    'partnership','partnership','شراكة نمو','نبدأ بخطوة واضحة ونبني عليها',
    'جلسة تشخيص مختصرة تحدد الفجوة والأولوية وأفضل مسار للتنفيذ.',
    'بعد الجلسة تحصل المؤسسة على تصور أولي للخطوات والنطاق ومؤشرات النجاح.',
    '{"label":"ابدأ جلسة التشخيص","href":"#contact"}'::jsonb,
    '{"label":"دخول العملاء","href":"/login"}'::jsonb,
    '[]'::jsonb,'{}'::jsonb,'dark',100
  ),
  (
    'contact','contact','تواصل معنا','دعنا نفهم التحدي أولًا',
    'شاركنا نبذة عن مؤسستك والتحدي الحالي، وسيتواصل فريق ماركتون لترتيب الخطوة المناسبة.',
    'لن نرسل عرضًا عامًا قبل فهم الاحتياج.',
    '{}'::jsonb,'{}'::jsonb,
    '[]'::jsonb,'{}'::jsonb,'light',110
  )
) as x(
  section_key,section_type,eyebrow,title,summary,body,
  primary_cta,secondary_cta,items,media,style_variant,sort_order
)
where s.site_key='marktone-main'
on conflict (site_id,section_key) do nothing;

insert into website.pages(
  site_id,slug,title,menu_label,excerpt,body,template_key,
  seo_title,seo_description,show_in_menu,menu_order,status,published_at
)
select s.id,
  'about-marktone',
  'عن ماركتون',
  'عن ماركتون',
  'ماركتون منظومة تشغيل ونمو متخصصة تربط الاستراتيجية بالتنفيذ والقياس.',
  E'ماركتون شريك تشغيل ونمو للمؤسسات ومراكز التدريب.\n\nنجمع بين الخبرة القطاعية، فرق التشغيل، الأنظمة الرقمية، التحليلات، والاستشارات لبناء رحلة عميل وتشغيل مترابطة.\n\nنبدأ بالتشخيص، ثم نصمم المسار، ثم ننفذ ونقيس وننقل المعرفة إلى فريق المؤسسة.',
  'standard',
  'عن ماركتون',
  'تعرف على منهج ماركتون في ربط التسويق والمبيعات والتشغيل والبيانات.',
  false,100,'published',now()
from website.sites s
where s.site_key='marktone-main'
on conflict (site_id,slug) do nothing;

create or replace function public.v2_public_site_snapshot(
  p_page_slug text default null,
  p_article_slug text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_site website.sites%rowtype;
  v_menu jsonb;
  v_sections jsonb;
  v_pages jsonb;
  v_articles jsonb;
  v_page jsonb;
  v_article jsonb;
begin
  select *
  into v_site
  from website.sites s
  where s.site_key='marktone-main'
    and s.status='published'
  limit 1;

  if v_site.id is null then
    return jsonb_build_object('available',false);
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',m.id,
      'label',m.label,
      'href',m.href,
      'kind',m.item_kind,
      'openInNewTab',m.open_in_new_tab,
      'sortOrder',m.sort_order
    ) order by m.sort_order,m.created_at
  ),'[]'::jsonb)
  into v_menu
  from website.menu_items m
  where m.site_id=v_site.id
    and m.status='published'
    and m.is_visible;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',s.id,
      'key',s.section_key,
      'type',s.section_type,
      'eyebrow',s.eyebrow,
      'title',s.title,
      'summary',s.summary,
      'body',s.body,
      'primaryCta',s.primary_cta,
      'secondaryCta',s.secondary_cta,
      'items',s.items,
      'media',s.media,
      'variant',s.style_variant,
      'sortOrder',s.sort_order
    ) order by s.sort_order,s.created_at
  ),'[]'::jsonb)
  into v_sections
  from website.sections s
  where s.site_id=v_site.id
    and s.status='published'
    and s.is_visible;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',p.id,
      'slug',p.slug,
      'title',p.title,
      'menuLabel',p.menu_label,
      'excerpt',p.excerpt,
      'coverUrl',p.cover_url,
      'updatedAt',p.updated_at
    ) order by p.menu_order,p.title
  ),'[]'::jsonb)
  into v_pages
  from website.pages p
  where p.site_id=v_site.id
    and p.status='published';

  select coalesce(jsonb_agg(item),'[]'::jsonb)
  into v_articles
  from (
    select jsonb_build_object(
      'id',a.id,
      'slug',a.slug,
      'title',a.title,
      'excerpt',a.excerpt,
      'category',a.category,
      'authorName',a.author_name,
      'coverUrl',a.cover_url,
      'featured',a.featured,
      'publishedAt',a.published_at
    ) as item
    from website.articles a
    where a.site_id=v_site.id
      and a.status='published'
      and coalesce(a.published_at,now())<=now()
    order by a.featured desc,a.published_at desc nulls last,a.updated_at desc
    limit 12
  ) latest;

  if nullif(trim(coalesce(p_page_slug,'')),'') is not null then
    select jsonb_build_object(
      'id',p.id,
      'slug',p.slug,
      'title',p.title,
      'excerpt',p.excerpt,
      'body',p.body,
      'content',p.content,
      'template',p.template_key,
      'seoTitle',p.seo_title,
      'seoDescription',p.seo_description,
      'coverUrl',p.cover_url,
      'publishedAt',p.published_at,
      'updatedAt',p.updated_at
    )
    into v_page
    from website.pages p
    where p.site_id=v_site.id
      and p.slug=lower(trim(p_page_slug))
      and p.status='published'
    limit 1;
  end if;

  if nullif(trim(coalesce(p_article_slug,'')),'') is not null then
    select jsonb_build_object(
      'id',a.id,
      'slug',a.slug,
      'title',a.title,
      'excerpt',a.excerpt,
      'body',a.body,
      'category',a.category,
      'authorName',a.author_name,
      'coverUrl',a.cover_url,
      'seoTitle',a.seo_title,
      'seoDescription',a.seo_description,
      'publishedAt',a.published_at,
      'updatedAt',a.updated_at
    )
    into v_article
    from website.articles a
    where a.site_id=v_site.id
      and a.slug=lower(trim(p_article_slug))
      and a.status='published'
      and coalesce(a.published_at,now())<=now()
    limit 1;
  end if;

  return jsonb_build_object(
    'available',true,
    'site',jsonb_build_object(
      'id',v_site.id,
      'key',v_site.site_key,
      'nameAr',v_site.name_ar,
      'nameEn',v_site.name_en,
      'settings',v_site.settings,
      'theme',v_site.theme,
      'publishedAt',v_site.published_at,
      'updatedAt',v_site.updated_at
    ),
    'menu',v_menu,
    'sections',v_sections,
    'pages',v_pages,
    'articles',v_articles,
    'page',v_page,
    'article',v_article
  );
end;
$$;

revoke all on function public.v2_public_site_snapshot(text,text) from public;
grant execute on function public.v2_public_site_snapshot(text,text) to anon, authenticated;

create or replace function public.v2_public_site_submit_contact(
  p_name text,
  p_email text default null,
  p_phone text default null,
  p_organization text default null,
  p_message text default null,
  p_source_page text default null,
  p_ip_hash text default null,
  p_user_agent text default null,
  p_consent boolean default false,
  p_website text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_site_id uuid;
  v_reference text;
  v_email text:=nullif(lower(trim(coalesce(p_email,''))), '');
  v_phone text:=nullif(trim(coalesce(p_phone,'')), '');
  v_name text:=trim(coalesce(p_name,''));
  v_message text:=trim(coalesce(p_message,''));
begin
  if nullif(trim(coalesce(p_website,'')),'') is not null then
    return jsonb_build_object('accepted',true);
  end if;

  select s.id into v_site_id
  from website.sites s
  where s.site_key='marktone-main' and s.status='published'
  limit 1;

  if v_site_id is null then
    raise exception 'site_unavailable';
  end if;
  if char_length(v_name)<2 or char_length(v_name)>120 then
    raise exception 'contact_name_invalid';
  end if;
  if char_length(v_message)<10 or char_length(v_message)>5000 then
    raise exception 'contact_message_invalid';
  end if;
  if v_email is null and v_phone is null then
    raise exception 'contact_channel_required';
  end if;
  if v_email is not null and (
    char_length(v_email)>254
    or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  ) then
    raise exception 'contact_email_invalid';
  end if;
  if v_phone is not null and char_length(v_phone)>40 then
    raise exception 'contact_phone_invalid';
  end if;
  if char_length(coalesce(p_organization,''))>160
     or char_length(coalesce(p_source_page,''))>300
     or char_length(coalesce(p_user_agent,''))>500 then
    raise exception 'contact_payload_invalid';
  end if;

  if nullif(trim(coalesce(p_ip_hash,'')),'') is not null and exists(
    select 1
    from website.contact_submissions c
    where c.site_id=v_site_id
      and c.ip_hash=trim(p_ip_hash)
      and c.created_at>now()-interval '15 minutes'
    group by c.ip_hash
    having count(*)>=5
  ) then
    raise exception 'contact_rate_limited';
  end if;

  v_reference:='MT-'||to_char(now(),'YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));

  insert into website.contact_submissions(
    site_id,reference_key,name,email,phone,organization,message,source_page,
    ip_hash,user_agent,consent_at
  ) values (
    v_site_id,v_reference,v_name,v_email,v_phone,
    nullif(trim(coalesce(p_organization,'')),''),v_message,
    nullif(trim(coalesce(p_source_page,'')),''),
    nullif(trim(coalesce(p_ip_hash,'')),''),
    nullif(left(trim(coalesce(p_user_agent,'')),500),''),
    case when p_consent then now() else null end
  );

  return jsonb_build_object('accepted',true,'reference',v_reference);
end;
$$;

revoke all on function public.v2_public_site_submit_contact(
  text,text,text,text,text,text,text,text,boolean,text
) from public;
grant execute on function public.v2_public_site_submit_contact(
  text,text,text,text,text,text,text,text,boolean,text
) to anon, authenticated;

create or replace function public.v2_platform_site_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_subject_id uuid;
  v_site website.sites%rowtype;
  v_menu jsonb;
  v_sections jsonb;
  v_pages jsonb;
  v_articles jsonb;
  v_submissions jsonb;
  v_revisions jsonb;
begin
  v_subject_id:=private_app.website_admin_subject();

  select * into v_site
  from website.sites s
  where s.site_key='marktone-main'
  limit 1;

  if v_site.id is null then
    raise exception 'site_not_found';
  end if;

  select coalesce(jsonb_agg(to_jsonb(m) order by m.sort_order,m.created_at),'[]'::jsonb)
  into v_menu
  from website.menu_items m
  where m.site_id=v_site.id and m.status<>'archived';

  select coalesce(jsonb_agg(to_jsonb(s) order by s.sort_order,s.created_at),'[]'::jsonb)
  into v_sections
  from website.sections s
  where s.site_id=v_site.id and s.status<>'archived';

  select coalesce(jsonb_agg(to_jsonb(p) order by p.updated_at desc),'[]'::jsonb)
  into v_pages
  from website.pages p
  where p.site_id=v_site.id and p.status<>'archived';

  select coalesce(jsonb_agg(to_jsonb(a) order by a.updated_at desc),'[]'::jsonb)
  into v_articles
  from website.articles a
  where a.site_id=v_site.id and a.status<>'archived';

  select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at desc),'[]'::jsonb)
  into v_submissions
  from (
    select c.*
    from website.contact_submissions c
    where c.site_id=v_site.id and c.status<>'archived'
    order by c.created_at desc
    limit 200
  ) c;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc),'[]'::jsonb)
  into v_revisions
  from (
    select r.*
    from website.content_revisions r
    where r.site_id=v_site.id
    order by r.created_at desc
    limit 50
  ) r;

  return jsonb_build_object(
    'site',to_jsonb(v_site),
    'menu',v_menu,
    'sections',v_sections,
    'pages',v_pages,
    'articles',v_articles,
    'submissions',v_submissions,
    'revisions',v_revisions,
    'stats',jsonb_build_object(
      'publishedSections',(select count(*) from website.sections s where s.site_id=v_site.id and s.status='published' and s.is_visible),
      'publishedPages',(select count(*) from website.pages p where p.site_id=v_site.id and p.status='published'),
      'publishedArticles',(select count(*) from website.articles a where a.site_id=v_site.id and a.status='published'),
      'newSubmissions',(select count(*) from website.contact_submissions c where c.site_id=v_site.id and c.status='new')
    )
  );
end;
$$;

revoke all on function public.v2_platform_site_snapshot() from public, anon;
grant execute on function public.v2_platform_site_snapshot() to authenticated;

create or replace function public.v2_platform_site_action(
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text:=lower(trim(coalesce(p_action,'')));
  v_payload jsonb:=coalesce(p_payload,'{}'::jsonb);
  v_subject_id uuid;
  v_site website.sites%rowtype;
  v_id uuid;
  v_row jsonb;
  v_slug text;
  v_status text;
  v_section_key text;
  v_menu_id uuid;
begin
  v_subject_id:=private_app.website_admin_subject();

  select * into v_site
  from website.sites s
  where s.site_key='marktone-main'
  limit 1
  for update;

  if v_site.id is null then
    raise exception 'site_not_found';
  end if;

  if v_action='save-site' then
    perform private_app.website_record_revision(
      v_site.id,'site',v_site.id,to_jsonb(v_site),v_subject_id
    );

    update website.sites s
    set name_ar=coalesce(nullif(trim(v_payload->>'nameAr'),''),s.name_ar),
        name_en=coalesce(nullif(trim(v_payload->>'nameEn'),''),s.name_en),
        status=case
          when v_payload->>'status' in ('draft','published','maintenance')
          then v_payload->>'status' else s.status end,
        settings=case when jsonb_typeof(v_payload->'settings')='object'
          then s.settings||(v_payload->'settings') else s.settings end,
        theme=case when jsonb_typeof(v_payload->'theme')='object'
          then s.theme||(v_payload->'theme') else s.theme end,
        published_at=case
          when coalesce(v_payload->>'status',s.status)='published'
          then coalesce(s.published_at,now()) else s.published_at end
    where s.id=v_site.id
    returning to_jsonb(s) into v_row;

  elsif v_action='save-menu-item' then
    if nullif(v_payload->>'id','') is not null then
      v_id:=(v_payload->>'id')::uuid;
      select to_jsonb(m) into v_row
      from website.menu_items m
      where m.id=v_id and m.site_id=v_site.id
      for update;
      if v_row is null then raise exception 'menu_item_not_found'; end if;
      perform private_app.website_record_revision(
        v_site.id,'menu_item',v_id,v_row,v_subject_id
      );
      update website.menu_items m
      set label=coalesce(nullif(trim(v_payload->>'label'),''),m.label),
          href=coalesce(nullif(trim(v_payload->>'href'),''),m.href),
          item_kind=case when v_payload->>'kind' in ('anchor','page','article','external','system') then v_payload->>'kind' else m.item_kind end,
          open_in_new_tab=coalesce((v_payload->>'openInNewTab')::boolean,m.open_in_new_tab),
          sort_order=coalesce((v_payload->>'sortOrder')::integer,m.sort_order),
          is_visible=coalesce((v_payload->>'isVisible')::boolean,m.is_visible),
          status=case when v_payload->>'status' in ('draft','published','archived') then v_payload->>'status' else m.status end
      where m.id=v_id
      returning to_jsonb(m) into v_row;
    else
      if nullif(trim(v_payload->>'label'),'') is null or nullif(trim(v_payload->>'href'),'') is null then
        raise exception 'menu_item_required_fields';
      end if;
      insert into website.menu_items as created_menu(
        site_id,label,href,item_kind,open_in_new_tab,sort_order,is_visible,status
      ) values (
        v_site.id,trim(v_payload->>'label'),trim(v_payload->>'href'),
        case when v_payload->>'kind' in ('anchor','page','article','external','system') then v_payload->>'kind' else 'anchor' end,
        coalesce((v_payload->>'openInNewTab')::boolean,false),
        coalesce((v_payload->>'sortOrder')::integer,100),
        coalesce((v_payload->>'isVisible')::boolean,true),
        case when v_payload->>'status' in ('draft','published') then v_payload->>'status' else 'published' end
      ) returning to_jsonb(created_menu) into v_row;
    end if;

  elsif v_action='delete-menu-item' then
    v_id:=(v_payload->>'id')::uuid;
    select to_jsonb(m) into v_row
    from website.menu_items m
    where m.id=v_id and m.site_id=v_site.id
    for update;
    if v_row is null then raise exception 'menu_item_not_found'; end if;
    perform private_app.website_record_revision(
      v_site.id,'menu_item',v_id,v_row,v_subject_id
    );
    update website.menu_items set status='archived',is_visible=false where id=v_id;
    v_row:=jsonb_build_object('id',v_id,'archived',true);

  elsif v_action='save-section' then
    v_section_key:=lower(trim(coalesce(v_payload->>'sectionKey','')));
    if v_section_key !~ '^[a-z0-9][a-z0-9_-]{1,63}$' then
      raise exception 'section_key_invalid';
    end if;
    if nullif(v_payload->>'id','') is not null then
      v_id:=(v_payload->>'id')::uuid;
      select to_jsonb(sec) into v_row
      from website.sections sec
      where sec.id=v_id and sec.site_id=v_site.id
      for update;
      if v_row is null then raise exception 'section_not_found'; end if;
      perform private_app.website_record_revision(
        v_site.id,'section',v_id,v_row,v_subject_id
      );
      update website.sections sec
      set section_key=v_section_key,
          section_type=coalesce(nullif(trim(v_payload->>'sectionType'),''),sec.section_type),
          eyebrow=nullif(trim(coalesce(v_payload->>'eyebrow','')),''),
          title=coalesce(nullif(trim(v_payload->>'title'),''),sec.title),
          summary=nullif(trim(coalesce(v_payload->>'summary','')),''),
          body=nullif(trim(coalesce(v_payload->>'body','')),''),
          primary_cta=case when jsonb_typeof(v_payload->'primaryCta')='object' then v_payload->'primaryCta' else sec.primary_cta end,
          secondary_cta=case when jsonb_typeof(v_payload->'secondaryCta')='object' then v_payload->'secondaryCta' else sec.secondary_cta end,
          items=case when jsonb_typeof(v_payload->'items')='array' then v_payload->'items' else sec.items end,
          media=case when jsonb_typeof(v_payload->'media')='object' then v_payload->'media' else sec.media end,
          style_variant=coalesce(nullif(trim(v_payload->>'styleVariant'),''),sec.style_variant),
          sort_order=coalesce((v_payload->>'sortOrder')::integer,sec.sort_order),
          is_visible=coalesce((v_payload->>'isVisible')::boolean,sec.is_visible),
          status=case when v_payload->>'status' in ('draft','published','archived') then v_payload->>'status' else sec.status end
      where sec.id=v_id
      returning to_jsonb(sec) into v_row;
    else
      if nullif(trim(v_payload->>'title'),'') is null then raise exception 'section_title_required'; end if;
      insert into website.sections as created_section(
        site_id,section_key,section_type,eyebrow,title,summary,body,
        primary_cta,secondary_cta,items,media,style_variant,
        sort_order,is_visible,status
      ) values (
        v_site.id,v_section_key,
        coalesce(nullif(trim(v_payload->>'sectionType'),''),'cards'),
        nullif(trim(coalesce(v_payload->>'eyebrow','')),''),
        trim(v_payload->>'title'),
        nullif(trim(coalesce(v_payload->>'summary','')),''),
        nullif(trim(coalesce(v_payload->>'body','')),''),
        case when jsonb_typeof(v_payload->'primaryCta')='object' then v_payload->'primaryCta' else '{}'::jsonb end,
        case when jsonb_typeof(v_payload->'secondaryCta')='object' then v_payload->'secondaryCta' else '{}'::jsonb end,
        case when jsonb_typeof(v_payload->'items')='array' then v_payload->'items' else '[]'::jsonb end,
        case when jsonb_typeof(v_payload->'media')='object' then v_payload->'media' else '{}'::jsonb end,
        coalesce(nullif(trim(v_payload->>'styleVariant'),''),'light'),
        coalesce((v_payload->>'sortOrder')::integer,100),
        coalesce((v_payload->>'isVisible')::boolean,true),
        case when v_payload->>'status' in ('draft','published') then v_payload->>'status' else 'draft' end
      ) returning to_jsonb(created_section) into v_row;
    end if;

  elsif v_action='delete-section' then
    v_id:=(v_payload->>'id')::uuid;
    select to_jsonb(sec) into v_row
    from website.sections sec
    where sec.id=v_id and sec.site_id=v_site.id
    for update;
    if v_row is null then raise exception 'section_not_found'; end if;
    perform private_app.website_record_revision(v_site.id,'section',v_id,v_row,v_subject_id);
    update website.sections set status='archived',is_visible=false where id=v_id;
    v_row:=jsonb_build_object('id',v_id,'archived',true);

  elsif v_action='save-page' then
    v_slug:=lower(trim(coalesce(v_payload->>'slug','')));
    if v_slug !~ '^[a-z0-9][a-z0-9-]{1,95}$' then raise exception 'page_slug_invalid'; end if;
    v_status:=case when v_payload->>'status' in ('draft','published','archived') then v_payload->>'status' else 'draft' end;
    if nullif(v_payload->>'id','') is not null then
      v_id:=(v_payload->>'id')::uuid;
      select to_jsonb(p) into v_row from website.pages p where p.id=v_id and p.site_id=v_site.id for update;
      if v_row is null then raise exception 'page_not_found'; end if;
      perform private_app.website_record_revision(v_site.id,'page',v_id,v_row,v_subject_id);
      update website.pages p
      set slug=v_slug,
          title=coalesce(nullif(trim(v_payload->>'title'),''),p.title),
          menu_label=nullif(trim(coalesce(v_payload->>'menuLabel','')),''),
          excerpt=nullif(trim(coalesce(v_payload->>'excerpt','')),''),
          body=coalesce(v_payload->>'body',p.body),
          content=case when jsonb_typeof(v_payload->'content')='object' then v_payload->'content' else p.content end,
          template_key=coalesce(nullif(trim(v_payload->>'templateKey'),''),p.template_key),
          seo_title=nullif(trim(coalesce(v_payload->>'seoTitle','')),''),
          seo_description=nullif(trim(coalesce(v_payload->>'seoDescription','')),''),
          cover_url=nullif(trim(coalesce(v_payload->>'coverUrl','')),''),
          show_in_menu=coalesce((v_payload->>'showInMenu')::boolean,p.show_in_menu),
          menu_order=coalesce((v_payload->>'menuOrder')::integer,p.menu_order),
          status=v_status,
          published_at=case when v_status='published' then coalesce(p.published_at,now()) else p.published_at end
      where p.id=v_id
      returning to_jsonb(p) into v_row;
    else
      if nullif(trim(v_payload->>'title'),'') is null then raise exception 'page_title_required'; end if;
      insert into website.pages as created_page(
        site_id,slug,title,menu_label,excerpt,body,content,template_key,
        seo_title,seo_description,cover_url,show_in_menu,menu_order,status,published_at
      ) values (
        v_site.id,v_slug,trim(v_payload->>'title'),
        nullif(trim(coalesce(v_payload->>'menuLabel','')),''),
        nullif(trim(coalesce(v_payload->>'excerpt','')),''),
        coalesce(v_payload->>'body',''),
        case when jsonb_typeof(v_payload->'content')='object' then v_payload->'content' else '{}'::jsonb end,
        coalesce(nullif(trim(v_payload->>'templateKey'),''),'standard'),
        nullif(trim(coalesce(v_payload->>'seoTitle','')),''),
        nullif(trim(coalesce(v_payload->>'seoDescription','')),''),
        nullif(trim(coalesce(v_payload->>'coverUrl','')),''),
        coalesce((v_payload->>'showInMenu')::boolean,false),
        coalesce((v_payload->>'menuOrder')::integer,100),
        v_status,case when v_status='published' then now() else null end
      ) returning to_jsonb(created_page) into v_row;
      v_id:=(v_row->>'id')::uuid;
    end if;

    if coalesce((v_payload->>'showInMenu')::boolean,false) then
      select m.id into v_menu_id
      from website.menu_items m
      where m.site_id=v_site.id and m.item_kind='page' and m.href='/p/'||v_slug
      limit 1;
      if v_menu_id is null then
        insert into website.menu_items(site_id,label,href,item_kind,sort_order,is_visible,status)
        values(
          v_site.id,
          coalesce(nullif(trim(v_payload->>'menuLabel'),''),nullif(trim(v_payload->>'title'),''),v_slug),
          '/p/'||v_slug,'page',coalesce((v_payload->>'menuOrder')::integer,100),true,
          case when v_status='published' then 'published' else 'draft' end
        );
      else
        update website.menu_items
        set label=coalesce(nullif(trim(v_payload->>'menuLabel'),''),nullif(trim(v_payload->>'title'),''),label),
            sort_order=coalesce((v_payload->>'menuOrder')::integer,sort_order),
            status=case when v_status='published' then 'published' else 'draft' end,
            is_visible=true
        where id=v_menu_id;
      end if;
    end if;

  elsif v_action='delete-page' then
    v_id:=(v_payload->>'id')::uuid;
    select to_jsonb(p) into v_row from website.pages p where p.id=v_id and p.site_id=v_site.id for update;
    if v_row is null then raise exception 'page_not_found'; end if;
    perform private_app.website_record_revision(v_site.id,'page',v_id,v_row,v_subject_id);
    update website.pages set status='archived',show_in_menu=false where id=v_id;
    update website.menu_items set status='archived',is_visible=false
    where site_id=v_site.id and item_kind='page' and href='/p/'||(v_row->>'slug');
    v_row:=jsonb_build_object('id',v_id,'archived',true);

  elsif v_action='save-article' then
    v_slug:=lower(trim(coalesce(v_payload->>'slug','')));
    if v_slug !~ '^[a-z0-9][a-z0-9-]{1,95}$' then raise exception 'article_slug_invalid'; end if;
    v_status:=case when v_payload->>'status' in ('draft','published','archived') then v_payload->>'status' else 'draft' end;
    if nullif(v_payload->>'id','') is not null then
      v_id:=(v_payload->>'id')::uuid;
      select to_jsonb(a) into v_row from website.articles a where a.id=v_id and a.site_id=v_site.id for update;
      if v_row is null then raise exception 'article_not_found'; end if;
      perform private_app.website_record_revision(v_site.id,'article',v_id,v_row,v_subject_id);
      update website.articles a
      set slug=v_slug,
          title=coalesce(nullif(trim(v_payload->>'title'),''),a.title),
          excerpt=nullif(trim(coalesce(v_payload->>'excerpt','')),''),
          body=coalesce(v_payload->>'body',a.body),
          category=nullif(trim(coalesce(v_payload->>'category','')),''),
          author_name=nullif(trim(coalesce(v_payload->>'authorName','')),''),
          cover_url=nullif(trim(coalesce(v_payload->>'coverUrl','')),''),
          seo_title=nullif(trim(coalesce(v_payload->>'seoTitle','')),''),
          seo_description=nullif(trim(coalesce(v_payload->>'seoDescription','')),''),
          featured=coalesce((v_payload->>'featured')::boolean,a.featured),
          status=v_status,
          published_at=case when v_status='published' then coalesce(a.published_at,now()) else a.published_at end
      where a.id=v_id
      returning to_jsonb(a) into v_row;
    else
      if nullif(trim(v_payload->>'title'),'') is null then raise exception 'article_title_required'; end if;
      insert into website.articles as created_article(
        site_id,slug,title,excerpt,body,category,author_name,cover_url,
        seo_title,seo_description,featured,status,published_at
      ) values (
        v_site.id,v_slug,trim(v_payload->>'title'),
        nullif(trim(coalesce(v_payload->>'excerpt','')),''),
        coalesce(v_payload->>'body',''),
        nullif(trim(coalesce(v_payload->>'category','')),''),
        nullif(trim(coalesce(v_payload->>'authorName','')),''),
        nullif(trim(coalesce(v_payload->>'coverUrl','')),''),
        nullif(trim(coalesce(v_payload->>'seoTitle','')),''),
        nullif(trim(coalesce(v_payload->>'seoDescription','')),''),
        coalesce((v_payload->>'featured')::boolean,false),
        v_status,case when v_status='published' then now() else null end
      ) returning to_jsonb(created_article) into v_row;
    end if;

  elsif v_action='delete-article' then
    v_id:=(v_payload->>'id')::uuid;
    select to_jsonb(a) into v_row from website.articles a where a.id=v_id and a.site_id=v_site.id for update;
    if v_row is null then raise exception 'article_not_found'; end if;
    perform private_app.website_record_revision(v_site.id,'article',v_id,v_row,v_subject_id);
    update website.articles set status='archived',featured=false where id=v_id;
    v_row:=jsonb_build_object('id',v_id,'archived',true);

  elsif v_action='set-submission-status' then
    v_id:=(v_payload->>'id')::uuid;
    v_status:=v_payload->>'status';
    if v_status not in ('new','in_progress','resolved','spam','archived') then
      raise exception 'submission_status_invalid';
    end if;
    update website.contact_submissions c
    set status=v_status,
        handled_by_subject_id=case when v_status in ('resolved','spam','archived') then v_subject_id else c.handled_by_subject_id end,
        handled_at=case when v_status in ('resolved','spam','archived') then now() else c.handled_at end
    where c.id=v_id and c.site_id=v_site.id
    returning to_jsonb(c) into v_row;
    if v_row is null then raise exception 'submission_not_found'; end if;

  else
    raise exception 'website_action_not_supported';
  end if;

  return jsonb_build_object('success',true,'action',v_action,'data',v_row);
exception
  when unique_violation then
    raise exception 'website_unique_value_conflict';
  when invalid_text_representation then
    raise exception 'website_payload_invalid';
end;
$$;

revoke all on function public.v2_platform_site_action(text,jsonb) from public, anon;
grant execute on function public.v2_platform_site_action(text,jsonb) to authenticated;

comment on function public.v2_public_site_snapshot(text,text)
is 'Returns only published public website content; callable by anonymous visitors.';
comment on function public.v2_public_site_submit_contact(text,text,text,text,text,text,text,text,boolean,text)
is 'Validates and stores public contact requests with honeypot and rate limiting.';
comment on function public.v2_platform_site_snapshot()
is 'Returns the complete website CMS workspace to authorized platform administrators.';
comment on function public.v2_platform_site_action(text,jsonb)
is 'Performs authorized CMS mutations and records revisions before destructive changes.';
