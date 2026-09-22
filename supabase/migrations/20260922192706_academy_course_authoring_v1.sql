begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

-- Installation and activation are deliberately separate. No tenant is enabled,
-- no course is backfilled, and no enrollment or financial row is rewritten.
create table academy.authoring_settings (
 tenant_id uuid primary key references core.tenants(id),enabled boolean not null default false,
 updated_at timestamptz not null default now()
);
create table academy.course_authoring (
 tenant_id uuid not null references core.tenants(id),course_id uuid not null,
 revision integer not null check(revision>0),document jsonb not null check(jsonb_typeof(document)='object' and octet_length(document::text)<=1048576),
 created_by_authoring boolean not null default false,
 published_revision integer,published_version_id uuid,published_at timestamptz,
 updated_by_subject_id uuid not null references access_control.subjects(id),updated_at timestamptz not null default now(),
 primary key(tenant_id,course_id),foreign key(tenant_id,course_id) references academy.courses(tenant_id,id),
 foreign key(tenant_id,published_version_id) references academy.training_course_versions(tenant_id,id),
 check(published_revision is null or published_revision between 1 and revision),
 check((published_revision is null and published_version_id is null and published_at is null) or (published_revision is not null and published_version_id is not null and published_at is not null))
);
create index course_authoring_actor_idx on academy.course_authoring(updated_by_subject_id);
create index course_authoring_published_idx on academy.course_authoring(tenant_id,published_version_id) where published_version_id is not null;
create table academy.course_authoring_releases (
 tenant_id uuid not null references core.tenants(id),course_id uuid not null,revision integer not null,
 version_id uuid not null,document jsonb not null,
 published_by_subject_id uuid not null references access_control.subjects(id),published_at timestamptz not null default now(),
 primary key(tenant_id,course_id,revision),unique(tenant_id,version_id),
 foreign key(tenant_id,course_id) references academy.courses(tenant_id,id),
 foreign key(tenant_id,version_id) references academy.training_course_versions(tenant_id,id)
);
create index course_authoring_releases_actor_idx on academy.course_authoring_releases(published_by_subject_id);
create table academy.learning_paths (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references core.tenants(id),
 revision integer not null check(revision>0),document jsonb not null check(jsonb_typeof(document)='object' and octet_length(document::text)<=65536),
 published_revision integer,published_document jsonb,published_at timestamptz,
 updated_by_subject_id uuid not null references access_control.subjects(id),updated_at timestamptz not null default now(),
 unique(tenant_id,id),check(published_revision is null or published_revision between 1 and revision),
 check((published_revision is null and published_document is null and published_at is null) or (published_revision is not null and published_document is not null and published_at is not null))
);
create index learning_paths_list_idx on academy.learning_paths(tenant_id,updated_at desc,id);
create index learning_paths_actor_idx on academy.learning_paths(updated_by_subject_id);
create table academy.learning_path_courses (
 tenant_id uuid not null,path_id uuid not null,course_id uuid not null,position integer not null check(position between 1 and 100),
 primary key(tenant_id,path_id,position),unique(tenant_id,path_id,course_id),
 foreign key(tenant_id,path_id) references academy.learning_paths(tenant_id,id),
 foreign key(tenant_id,course_id) references academy.courses(tenant_id,id)
);
create index learning_path_courses_course_idx on academy.learning_path_courses(tenant_id,course_id);
create table academy.learning_path_releases (
 tenant_id uuid not null,path_id uuid not null,revision integer not null,document jsonb not null,
 published_by_subject_id uuid not null references access_control.subjects(id),published_at timestamptz not null default now(),
 primary key(tenant_id,path_id,revision),foreign key(tenant_id,path_id) references academy.learning_paths(tenant_id,id)
);
create index learning_path_releases_actor_idx on academy.learning_path_releases(published_by_subject_id);
create table academy.learning_path_release_courses (
 tenant_id uuid not null,path_id uuid not null,revision integer not null,course_id uuid not null,position integer not null,
 primary key(tenant_id,path_id,revision,position),unique(tenant_id,path_id,revision,course_id),
 foreign key(tenant_id,path_id,revision) references academy.learning_path_releases(tenant_id,path_id,revision),
 foreign key(tenant_id,course_id) references academy.courses(tenant_id,id)
);
create index learning_path_release_courses_course_idx on academy.learning_path_release_courses(tenant_id,course_id);

do $$ declare n text;begin
 foreach n in array array['authoring_settings','course_authoring','course_authoring_releases','learning_paths','learning_path_courses','learning_path_releases','learning_path_release_courses'] loop
  execute format('alter table academy.%I enable row level security',n);
  execute format('revoke all on academy.%I from public,anon,authenticated',n);
 end loop;
end $$;

create function private_app.academy_authoring_release_immutable_v1() returns trigger
language plpgsql set search_path='' as $$ begin raise exception 'academy_authoring_release_immutable';end $$;
create trigger course_authoring_release_immutable before update or delete on academy.course_authoring_releases for each row execute function private_app.academy_authoring_release_immutable_v1();
create trigger learning_path_release_immutable before update or delete on academy.learning_path_releases for each row execute function private_app.academy_authoring_release_immutable_v1();
create trigger learning_path_release_courses_immutable before update or delete on academy.learning_path_release_courses for each row execute function private_app.academy_authoring_release_immutable_v1();

create function private_app.academy_authoring_enabled_v1(p_tenant_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select p_tenant_id='3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid
 and exists(select 1 from core.tenants where id=p_tenant_id and slug='marktone')
 and exists(select 1 from academy.authoring_settings where tenant_id=p_tenant_id and enabled)
$$;

create function private_app.academy_authoring_blank_v1(p_title text,p_category text) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('title',p_title,'description','','category',coalesce(nullif(trim(p_category),''),'تدريب عام'),
 'level','all','language','ar','thumbnailUrl','','introVideoUrl','','learningMode','self_paced',
 'policy',jsonb_build_object('minAttendancePercent',0,'minAssessmentPercent',70,'requireCompletedRun',false,'certificateEnabled',false,'termsVersion','','supportEmail',''),
 'topics','[]'::jsonb,'aiBrief',jsonb_build_object('goal','','audience','','language','ar','topicCount',5,'notes',''))
$$;

create function private_app.academy_authoring_pick_v1(p_object jsonb,p_keys text[]) returns jsonb
language sql immutable set search_path='' as $$
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(p_object) where key=any(p_keys)
$$;

create function private_app.academy_authoring_ai_brief_validate_v1(p_brief jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare k text;
begin
 if p_brief is null or p_brief='null'::jsonb then return;end if;
 if jsonb_typeof(p_brief)<>'object' or octet_length(p_brief::text)>40000 then raise exception 'academy_authoring_ai_brief_invalid';end if;
 foreach k in array array['goal','audience','language','notes'] loop
  if p_brief?k and (jsonb_typeof(p_brief->k)<>'string' or length(p_brief->>k)>case k when 'goal' then 2000 when 'audience' then 1000 when 'notes' then 6000 else 5 end) then raise exception 'academy_authoring_ai_brief_invalid';end if;
 end loop;
 if p_brief?'language' and p_brief->>'language' not in ('ar','en') then raise exception 'academy_authoring_ai_brief_invalid';end if;
 if p_brief?'topicCount' and (jsonb_typeof(p_brief->'topicCount')<>'number' or (p_brief->>'topicCount')!~'^[0-9]{1,2}$' or (p_brief->>'topicCount')::int not between 1 and 30) then raise exception 'academy_authoring_ai_brief_invalid';end if;
end $$;

create function private_app.academy_authoring_document_validate_v1(p_document jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare d jsonb;topic jsonb;u jsonb;q jsonb;k text;unit_count int:=0;topic_ids text[]:='{}';unit_ids text[]:='{}';clean_topics jsonb:='[]';clean_units jsonb;clean_questions jsonb;
begin
 if p_document is null or jsonb_typeof(p_document)<>'object' or octet_length(p_document::text)>1048576 then raise exception 'academy_authoring_document_invalid';end if;
 d:=private_app.academy_authoring_blank_v1(p_document->>'title',p_document->>'category')||p_document;
 foreach k in array array['title','description','category','level','language','thumbnailUrl','introVideoUrl','learningMode'] loop
  if jsonb_typeof(d->k) is distinct from 'string' then raise exception 'academy_authoring_document_invalid';end if;
 end loop;
 if length(trim(d->>'title')) not between 2 and 300 or length(d->>'description')>20000 or length(trim(d->>'category')) not between 2 and 120
 or d->>'level' not in ('beginner','intermediate','advanced','all') or d->>'language' not in ('ar','en') or d->>'learningMode' not in ('self_paced','live','blended')
 or jsonb_typeof(d->'policy') is distinct from 'object' or octet_length((d->'policy')::text)>30000 then raise exception 'academy_authoring_document_invalid';end if;
 foreach k in array array['thumbnailUrl','introVideoUrl'] loop
  if (d->>k)<>'' and (length(d->>k)>2048 or d->>k !~ '^https://[^/?#[:space:]@]+([/?#][^[:space:]]*)?$' or strpos(d->>k,chr(92))>0) then raise exception 'academy_authoring_url_invalid';end if;
 end loop;
 perform private_app.academy_authoring_ai_brief_validate_v1(d->'aiBrief');
 if jsonb_typeof(d->'topics') is distinct from 'array' or jsonb_array_length(d->'topics')>30 then raise exception 'academy_authoring_topics_invalid';end if;
 for topic in select value from jsonb_array_elements(d->'topics') loop
  if jsonb_typeof(topic)<>'object' or coalesce(topic->>'id','') !~ '^[a-zA-Z0-9_-]{1,64}$' or topic->>'id'=any(topic_ids)
  or jsonb_typeof(topic->'title') is distinct from 'string' or length(topic->>'title')>300
  or (topic?'summary' and (jsonb_typeof(topic->'summary')<>'string' or length(topic->>'summary')>2000))
  or jsonb_typeof(topic->'units') is distinct from 'array' then raise exception 'academy_authoring_topic_invalid';end if;
  topic_ids:=array_append(topic_ids,topic->>'id');unit_count:=unit_count+jsonb_array_length(topic->'units');
  if unit_count>100 then raise exception 'academy_authoring_units_limit';end if;
  clean_units:='[]';
  for u in select value from jsonb_array_elements(topic->'units') loop
   if jsonb_typeof(u)<>'object' or jsonb_typeof(u->'title') is distinct from 'string' or length(u->>'title')>300
   or coalesce(u->>'kind','') not in ('text','video','link','quiz','assignment') then raise exception 'academy_authoring_unit_invalid';end if;
   if u?'id' then
    if coalesce(u->>'id','') !~ '^[a-zA-Z0-9_-]{1,64}$' or u->>'id'=any(unit_ids) then raise exception 'academy_authoring_unit_invalid';end if;
    unit_ids:=array_append(unit_ids,u->>'id');
   end if;
   if u?'body' and (jsonb_typeof(u->'body')<>'string' or length(u->>'body')>50000) then raise exception 'academy_authoring_unit_invalid';end if;
   if u?'url' and u->'url'<>'null'::jsonb and (jsonb_typeof(u->'url')<>'string' or ((u->>'url')<>'' and (length(u->>'url')>2048 or u->>'url' !~ '^https://[^/?#[:space:]@]+([/?#][^[:space:]]*)?$' or strpos(u->>'url',chr(92))>0))) then raise exception 'academy_authoring_url_invalid';end if;
   if u?'required' and jsonb_typeof(u->'required')<>'boolean' then raise exception 'academy_authoring_unit_invalid';end if;
   foreach k in array array['minimumSeconds','maxAttempts','passPercent'] loop
    if u?k and (jsonb_typeof(u->k)<>'number' or u->>k !~ '^[0-9]+([.][0-9]{1,2})?$' or (u->>k)::numeric not between case k when 'maxAttempts' then 1 else 0 end and case k when 'minimumSeconds' then 86400 when 'maxAttempts' then 20 else 100 end
    or (k<>'passPercent' and u->>k !~ '^[0-9]+$')) then raise exception 'academy_authoring_unit_invalid';end if;
   end loop;
   if u?'questions' and (jsonb_typeof(u->'questions')<>'array' or jsonb_array_length(u->'questions')>50) then raise exception 'academy_authoring_unit_invalid';end if;
   perform private_app.academy_authoring_ai_brief_validate_v1(u->'aiBrief');
   clean_questions:='[]';
   for q in select value from jsonb_array_elements(coalesce(u->'questions','[]')) loop
    if jsonb_typeof(q)<>'object' then raise exception 'academy_authoring_unit_invalid';end if;
    clean_questions:=clean_questions||jsonb_build_array(private_app.academy_authoring_pick_v1(q,array['id','prompt','options','correctOptionIndex']));
   end loop;
   u:=private_app.academy_authoring_pick_v1(u,array['id','title','kind','required','minimumSeconds','body','url','questions','maxAttempts','passPercent','aiBrief'])||jsonb_build_object('questions',clean_questions);
   if jsonb_typeof(u->'aiBrief')='object' then u:=jsonb_set(u,'{aiBrief}',private_app.academy_authoring_pick_v1(u->'aiBrief',array['goal','audience','language','topicCount','notes']));end if;
   clean_units:=clean_units||jsonb_build_array(u);
  end loop;
  clean_topics:=clean_topics||jsonb_build_array(private_app.academy_authoring_pick_v1(topic,array['id','title','summary'])||jsonb_build_object('units',clean_units));
 end loop;
 d:=private_app.academy_authoring_pick_v1(d,array['title','description','category','level','language','thumbnailUrl','introVideoUrl','learningMode','policy','topics','aiBrief']);
 d:=jsonb_set(d,'{topics}',clean_topics);
 d:=jsonb_set(d,'{policy}',private_app.academy_authoring_pick_v1(d->'policy',array['minAttendancePercent','minAssessmentPercent','requireCompletedRun','certificateEnabled','termsVersion','supportEmail']));
 if jsonb_typeof(d->'aiBrief')='object' then d:=jsonb_set(d,'{aiBrief}',private_app.academy_authoring_pick_v1(d->'aiBrief',array['goal','audience','language','topicCount','notes']));end if;
 return jsonb_set(d,'{title}',to_jsonb(trim(d->>'title')));
end $$;

create function private_app.academy_authoring_path_validate_v1(p_document jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare d jsonb;
begin
 if p_document is null or jsonb_typeof(p_document)<>'object' or octet_length(p_document::text)>65536 then raise exception 'academy_authoring_path_invalid';end if;
 d:=jsonb_build_object('description','','courseIds','[]'::jsonb)||p_document;
 if jsonb_typeof(d->'title') is distinct from 'string' or length(trim(d->>'title')) not between 2 and 300 or jsonb_typeof(d->'description')<>'string' or length(d->>'description')>20000
 or jsonb_typeof(d->'courseIds') is distinct from 'array' or jsonb_array_length(d->'courseIds')>100 then raise exception 'academy_authoring_path_invalid';end if;
 if exists(select 1 from jsonb_array_elements(d->'courseIds') x where jsonb_typeof(x)<>'string' or x#>>'{}' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
 or (select count(distinct lower(value)) from jsonb_array_elements_text(d->'courseIds'))<>jsonb_array_length(d->'courseIds') then raise exception 'academy_authoring_path_courses_invalid';end if;
 return jsonb_set(private_app.academy_authoring_pick_v1(d,array['title','description','courseIds']),'{title}',to_jsonb(trim(d->>'title')));
end $$;

create function private_app.academy_authoring_existing_document_v1(p_tenant_id uuid,p_course_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare c academy.courses%rowtype;v academy.training_course_versions%rowtype;d jsonb;units jsonb;
begin
 select * into c from academy.courses where tenant_id=p_tenant_id and id=p_course_id;
 if c.id is null then raise exception 'academy_authoring_course_not_found';end if;
 select * into v from academy.training_course_versions where tenant_id=p_tenant_id and course_id=c.id order by version desc limit 1;
 d:=private_app.academy_authoring_blank_v1(coalesce(v.title,c.title_ar),c.category)||jsonb_build_object('description',coalesce(c.description,''),'thumbnailUrl',coalesce(c.primary_image_url,''));
 if v.id is not null then
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'title',title,'kind',kind,'body',body,'url',coalesce(url,''),'questions',questions,'required',required,'minimumSeconds',minimum_seconds,'maxAttempts',max_attempts,'passPercent',pass_percent) order by position),'[]') into units from academy.training_units where tenant_id=p_tenant_id and version_id=v.id;
  d:=d||jsonb_build_object('learningMode',v.learning_mode,'policy',v.policy,'topics',jsonb_build_array(jsonb_build_object('id','existing-curriculum','title','المنهج الحالي','summary','','units',units)));
 end if;
 return d;
end $$;

create function public.v1_academy_authoring_snapshot(p_slug text,p_course_id uuid default null,p_path_id uuid default null,p_offset integer default 0,p_query text default '',p_path_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare t uuid;course_data jsonb;path_data jsonb;course_rows jsonb;path_rows jsonb;more_courses boolean;more_paths boolean;
begin
 t:=private_app.academy_training_tenant_v1(p_slug);
 if not private_app.academy_has_permission_v1(t,'manageLearning') or not private_app.academy_has_permission_v1(t,'manageCourses') then raise exception 'academy_authoring_permission_denied' using errcode='42501';end if;
 if p_offset is null or p_offset not between 0 and 100000 or p_path_offset is null or p_path_offset not between 0 and 100000 or p_query is null or length(p_query)>100 then raise exception 'academy_authoring_query_invalid';end if;
 if not private_app.academy_authoring_enabled_v1(t) then return jsonb_build_object('available',false,'tenant',jsonb_build_object('id',t,'slug',p_slug),'offset',p_offset,'pathOffset',p_path_offset,'query',p_query,'courses','[]'::jsonb,'paths','[]'::jsonb,'course',null,'path',null,'hasMore',jsonb_build_object('courses',false,'paths',false),'ai',jsonb_build_object('status','unconfigured','configured',false));end if;
 with candidates as (
  select c.id,c.title_ar,c.category,c.status,c.updated_at,a.revision,a.document,case when a.published_version_id=v.id then a.published_revision end published_revision,a.published_version_id authoring_version_id,(a.course_id is not null and v.id is not null and a.published_version_id is distinct from v.id) externally_updated,a.updated_at draft_updated_at,
  v.id version_id,v.published_at
  from academy.courses c left join academy.course_authoring a on a.tenant_id=c.tenant_id and a.course_id=c.id
  left join lateral(select id,published_at from academy.training_course_versions where tenant_id=t and course_id=c.id and status='published' order by version desc limit 1)v on true
  where c.tenant_id=t and (p_query='' or strpos(lower(c.title_ar),lower(p_query))>0 or strpos(lower(coalesce(a.document->>'title','')),lower(p_query))>0)
  order by coalesce(a.updated_at,c.updated_at) desc,c.id limit 51 offset p_offset
 ), numbered as(select *,row_number()over() n from candidates)
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'title',title_ar,'draftTitle',document->>'title','category',category,'courseStatus',status,'authoringRevision',coalesce(revision,0),'publishedRevision',published_revision,'publishedVersionId',version_id,'authoringPublishedVersionId',authoring_version_id,'externallyUpdated',externally_updated,'publishedAt',published_at,'updatedAt',coalesce(draft_updated_at,updated_at)) order by n)filter(where n<=50),'[]'),count(*)>50 into course_rows,more_courses from numbered;
 with candidates as(select * from academy.learning_paths where tenant_id=t and (p_query='' or strpos(lower(document->>'title'),lower(p_query))>0) order by updated_at desc,id limit 51 offset p_path_offset),numbered as(select *,row_number()over() n from candidates)
 select coalesce(jsonb_agg(jsonb_build_object('pathId',id,'title',document->>'title','revision',revision,'publishedRevision',published_revision,'courseCount',jsonb_array_length(document->'courseIds'),'updatedAt',updated_at,'publishedAt',published_at) order by n)filter(where n<=50),'[]'),count(*)>50 into path_rows,more_paths from numbered;
 if p_course_id is not null then
  if not exists(select 1 from academy.courses where tenant_id=t and id=p_course_id) then raise exception 'academy_authoring_course_not_found';end if;
  select jsonb_build_object('courseId',c.id,'revision',coalesce(a.revision,0),'document',coalesce(a.document,private_app.academy_authoring_existing_document_v1(t,c.id)),'publishedRevision',case when a.published_version_id=v.id then a.published_revision end,'publishedVersionId',v.id,'authoringPublishedVersionId',a.published_version_id,'externallyUpdated',a.course_id is not null and v.id is not null and a.published_version_id is distinct from v.id,'publishedAt',v.published_at)
  into course_data from academy.courses c left join academy.course_authoring a on a.tenant_id=t and a.course_id=c.id
  left join lateral(select id,published_at from academy.training_course_versions where tenant_id=t and course_id=c.id and status='published' order by version desc limit 1)v on true where c.tenant_id=t and c.id=p_course_id;
 end if;
 if p_path_id is not null then
  select jsonb_build_object('pathId',p.id,'revision',p.revision,'document',p.document,'publishedRevision',p.published_revision,'publishedDocument',p.published_document,'publishedAt',p.published_at,
  'courses',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'title',c.title_ar,'draftTitle',a.document->>'title','courseStatus',c.status,'publishedVersionId',v.id) order by pc.position)
   from academy.learning_path_courses pc join academy.courses c on c.tenant_id=pc.tenant_id and c.id=pc.course_id
   left join academy.course_authoring a on a.tenant_id=c.tenant_id and a.course_id=c.id
   left join lateral(select id from academy.training_course_versions where tenant_id=t and course_id=c.id and status='published' order by version desc limit 1)v on true
   where pc.tenant_id=t and pc.path_id=p.id),'[]'))
  into path_data from academy.learning_paths p where p.tenant_id=t and p.id=p_path_id;
  if path_data is null then raise exception 'academy_authoring_path_not_found';end if;
 end if;
 return jsonb_build_object('available',true,'tenant',jsonb_build_object('id',t,'slug',p_slug),'offset',p_offset,'pathOffset',p_path_offset,'query',p_query,'courses',course_rows,'paths',path_rows,'course',course_data,'path',path_data,'hasMore',jsonb_build_object('courses',more_courses,'paths',more_paths),'ai',jsonb_build_object('status','unconfigured','configured',false));
end $$;

create function public.v1_academy_authoring_action(p_slug text,p_action text,p_command_id uuid,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare t uuid;s uuid;cached jsonb;result jsonb;d jsonb;course_id uuid;path_id uuid;expected integer;revision integer;position integer;units jsonb:='[]';topics jsonb:='[]';topic jsonb;policy jsonb;version_id uuid;training_result jsonb;
 a academy.course_authoring%rowtype;p academy.learning_paths%rowtype;
begin
 t:=private_app.academy_training_tenant_v1(p_slug);s:=private_app.current_subject_id();
 if not private_app.academy_has_permission_v1(t,'manageLearning') or not private_app.academy_has_permission_v1(t,'manageCourses') then raise exception 'academy_authoring_permission_denied' using errcode='42501';end if;
 if not private_app.academy_authoring_enabled_v1(t) then raise exception 'academy_authoring_not_available' using errcode='42501';end if;
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>1048576 then raise exception 'academy_authoring_payload_invalid';end if;
 if p_action is null or p_action not in ('create_course','save_course','publish_course','save_path','publish_path') then raise exception 'academy_authoring_action_invalid';end if;
 cached:=private_app.training_journey_command_v1(t,p_command_id,'authoring.'||p_action,p_payload);
 if cached is not null then return cached;end if;
 if p_action<>'create_course' then
  if jsonb_typeof(p_payload->'expectedRevision') is distinct from 'number' or p_payload->>'expectedRevision' !~ '^[0-9]{1,10}$' or (p_payload->>'expectedRevision')::numeric>2147483646 then raise exception 'academy_authoring_revision_required';end if;
  expected:=(p_payload->>'expectedRevision')::integer;
 end if;
 if p_action='create_course' then
  if jsonb_typeof(p_payload->'title') is distinct from 'string' or (p_payload?'category' and jsonb_typeof(p_payload->'category')<>'string') then raise exception 'academy_authoring_document_invalid';end if;
  d:=private_app.academy_authoring_document_validate_v1(private_app.academy_authoring_blank_v1(p_payload->>'title',p_payload->>'category'));
  course_id:=gen_random_uuid();
  insert into academy.courses(id,tenant_id,course_code,title_ar,category,delivery_mode,status,program_kind)
  values(course_id,t,'LMS-'||replace(course_id::text,'-',''),d->>'title',d->>'category','online','draft','short_course');
  insert into academy.course_authoring(tenant_id,course_id,revision,document,created_by_authoring,updated_by_subject_id) values(t,course_id,1,d,true,s);
  result:=jsonb_build_object('courseId',course_id,'revision',1,'status','draft');
 elsif p_action in ('save_course','publish_course') then
  course_id:=(p_payload->>'courseId')::uuid;
  perform 1 from academy.courses c where c.tenant_id=t and c.id=course_id for update;
  if not found then raise exception 'academy_authoring_course_not_found';end if;
  select * into a from academy.course_authoring ca where ca.tenant_id=t and ca.course_id=course_id for update;
  if coalesce(a.revision,0)<>expected then raise exception 'academy_authoring_revision_conflict';end if;
  if p_action='save_course' then
   d:=private_app.academy_authoring_document_validate_v1(p_payload->'document');revision:=expected+1;
   insert into academy.course_authoring(tenant_id,course_id,revision,document,updated_by_subject_id) values(t,course_id,revision,d,s)
   on conflict on constraint course_authoring_pkey do update set revision=excluded.revision,document=excluded.document,updated_by_subject_id=s,updated_at=now();
   result:=jsonb_build_object('courseId',course_id,'revision',revision,'status','draft');
  else
   if a.course_id is null then raise exception 'academy_authoring_draft_required';end if;
   if p_payload->'humanReviewed' is distinct from 'true'::jsonb then raise exception 'training_human_review_required';end if;
   if a.published_revision=a.revision then
    if exists(select 1 from academy.training_course_versions v where v.tenant_id=t and v.course_id=course_id and v.status='published' and v.version>(select old.version from academy.training_course_versions old where old.tenant_id=t and old.id=a.published_version_id)) then raise exception 'academy_authoring_external_change';end if;
    result:=jsonb_build_object('courseId',course_id,'revision',a.revision,'versionId',a.published_version_id,'status','published');
   else
    d:=private_app.academy_authoring_document_validate_v1(a.document);position:=1;
    for topic in select value from jsonb_array_elements(d->'topics') loop
     if length(trim(topic->>'title'))<2 then raise exception 'academy_authoring_topic_invalid';end if;
     if jsonb_array_length(topic->'units')=0 then raise exception 'academy_authoring_topic_empty';end if;
     topics:=topics||jsonb_build_array(jsonb_build_object('id',topic->>'id','title',topic->>'title','summary',coalesce(topic->>'summary',''),'startPosition',position,'unitCount',jsonb_array_length(topic->'units')));
     units:=units||(topic->'units');position:=position+jsonb_array_length(topic->'units');
    end loop;
    policy:=(d->'policy')||jsonb_build_object('curriculumTopics',topics);
    training_result:=public.v1_academy_training_action(p_slug,'save_draft',gen_random_uuid(),jsonb_build_object('courseId',course_id,'title',d->>'title','learningMode',d->>'learningMode','policy',policy,'units',units));
    version_id:=(training_result->>'versionId')::uuid;
    perform public.v1_academy_training_action(p_slug,'publish_version',gen_random_uuid(),jsonb_build_object('versionId',version_id,'humanReviewed',true));
    insert into academy.course_authoring_releases(tenant_id,course_id,revision,version_id,document,published_by_subject_id) values(t,course_id,a.revision,version_id,d,s);
    update academy.course_authoring ca set published_revision=a.revision,published_version_id=version_id,published_at=now(),updated_by_subject_id=s,updated_at=now() where ca.tenant_id=t and ca.course_id=course_id;
    update academy.courses c set title_ar=d->>'title',description=d->>'description',category=d->>'category',primary_image_url=nullif(d->>'thumbnailUrl',''),status=case when a.created_by_authoring and c.status='draft' then 'active' else c.status end,updated_at=now() where c.tenant_id=t and c.id=course_id;
    result:=jsonb_build_object('courseId',course_id,'revision',a.revision,'versionId',version_id,'status','published');
   end if;
  end if;
 elsif p_action='save_path' then
  path_id:=nullif(p_payload->>'pathId','')::uuid;
  d:=private_app.academy_authoring_path_validate_v1(p_payload->'document');
  -- Deterministic course locks and composite foreign keys protect ordered links.
  perform 1 from academy.courses c where c.tenant_id=t and c.id in(select value::uuid from jsonb_array_elements_text(d->'courseIds')) order by c.id for key share;
  if (select count(*) from academy.courses c where c.tenant_id=t and c.id in(select value::uuid from jsonb_array_elements_text(d->'courseIds')))<>jsonb_array_length(d->'courseIds') then raise exception 'academy_authoring_path_course_not_found';end if;
  if path_id is null then
   if expected<>0 then raise exception 'academy_authoring_revision_conflict';end if;
   path_id:=gen_random_uuid();revision:=1;
   insert into academy.learning_paths(id,tenant_id,revision,document,updated_by_subject_id) values(path_id,t,revision,d,s);
  else
   select * into p from academy.learning_paths lp where lp.tenant_id=t and lp.id=path_id for update;
   if p.id is null then raise exception 'academy_authoring_path_not_found';end if;
   if p.revision<>expected then raise exception 'academy_authoring_revision_conflict';end if;
   revision:=expected+1;
   update academy.learning_paths lp set document=d,revision=expected+1,updated_by_subject_id=s,updated_at=now() where lp.tenant_id=t and lp.id=path_id;
   delete from academy.learning_path_courses pc where pc.tenant_id=t and pc.path_id=path_id;
  end if;
  insert into academy.learning_path_courses(tenant_id,path_id,course_id,position) select t,path_id,value::uuid,ordinality::int from jsonb_array_elements_text(d->'courseIds') with ordinality;
  result:=jsonb_build_object('pathId',path_id,'revision',revision,'status','draft');
 elsif p_action='publish_path' then
  path_id:=(p_payload->>'pathId')::uuid;
  select * into p from academy.learning_paths lp where lp.tenant_id=t and lp.id=path_id for update;
  if p.id is null then raise exception 'academy_authoring_path_not_found';end if;
  if p.revision<>expected then raise exception 'academy_authoring_revision_conflict';end if;
  if p_payload->'humanReviewed' is distinct from 'true'::jsonb then raise exception 'training_human_review_required';end if;
  if p.published_revision is distinct from p.revision then
   if jsonb_array_length(p.document->'courseIds')=0 then raise exception 'academy_authoring_path_courses_required';end if;
   if exists(select 1 from academy.learning_path_courses pc join academy.courses c on c.tenant_id=pc.tenant_id and c.id=pc.course_id where pc.tenant_id=t and pc.path_id=path_id and (c.status<>'active' or not exists(select 1 from academy.training_course_versions v where v.tenant_id=t and v.course_id=c.id and v.status='published'))) then raise exception 'academy_authoring_path_course_unpublished';end if;
   insert into academy.learning_path_releases(tenant_id,path_id,revision,document,published_by_subject_id) values(t,path_id,p.revision,p.document,s);
   insert into academy.learning_path_release_courses(tenant_id,path_id,revision,course_id,position) select t,path_id,p.revision,pc.course_id,pc.position from academy.learning_path_courses pc where pc.tenant_id=t and pc.path_id=path_id;
   update academy.learning_paths lp set published_revision=p.revision,published_document=p.document,published_at=now(),updated_by_subject_id=s,updated_at=now() where lp.tenant_id=t and lp.id=path_id;
  end if;
  result:=jsonb_build_object('pathId',path_id,'revision',p.revision,'status','published');
 end if;
 perform private_app.training_learning_event_v1(t,null,'authoring_'||p_action,result);
 return private_app.training_journey_complete_command_v1(t,p_command_id,result);
end $$;

-- Read-only learner projection. A path is a suggested ordered collection. It
-- neither enrolls learners nor replaces course financial/admission gates.
create function public.v1_academy_learner_paths(p_slug text,p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare t uuid;s uuid;student uuid;rows jsonb;more boolean;
begin
 t:=private_app.academy_training_tenant_v1(p_slug);s:=private_app.current_subject_id();
 if p_offset is null or p_offset not between 0 and 100000 then raise exception 'academy_authoring_query_invalid';end if;
 -- A disabled additive projection must not change existing learner access.
 -- Authentication/tenant availability still precede this empty response.
 if not private_app.academy_authoring_enabled_v1(t) then return jsonb_build_object('paths','[]'::jsonb,'hasMore',false,'offset',p_offset,'pageSize',20);end if;
 select la.student_id into student from academy.training_learner_accounts la
 where la.tenant_id=t and la.subject_id=s and la.status='active';
 if student is null then raise exception 'training_permission_denied' using errcode='42501';end if;
 -- Existing learner snapshots retain an empty dashboard for bound students
 -- whose record is inactive/blocked. An additive path must preserve that result.
 if not exists(select 1 from academy.students st where st.tenant_id=t and st.id=student and st.status in ('active','graduated')) then
  return jsonb_build_object('paths','[]'::jsonb,'hasMore',false,'offset',p_offset,'pageSize',20);
 end if;
 with own_enrollments as materialized (
  select e.id,e.course_id,e.status,ev.version_id from academy.enrollments e left join academy.training_enrollment_versions ev on ev.tenant_id=e.tenant_id and ev.enrollment_id=e.id
  where e.tenant_id=t and e.student_id=student and e.status in ('confirmed','active','completed')
 ), candidates as (
  select p.id,p.published_revision,p.published_document,p.published_at
  from academy.learning_paths p where p.tenant_id=t and p.published_revision is not null
  and exists(select 1 from academy.learning_path_release_courses pc join own_enrollments e on e.course_id=pc.course_id where pc.tenant_id=t and pc.path_id=p.id and pc.revision=p.published_revision)
  order by p.published_at desc,p.id limit 21 offset p_offset
 ), numbered as (select *,row_number()over() n from candidates)
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'title',p.published_document->>'title','description',p.published_document->>'description','courses',(
  select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'title',c.title_ar,'enrolled',coalesce(e.enrolled,false),'completed',coalesce(e.completed,false),'progressPercent',e.progress) order by pc.position),'[]')
  from academy.learning_path_release_courses pc join academy.courses c on c.tenant_id=pc.tenant_id and c.id=pc.course_id
  left join lateral(
   select true enrolled,bool_or(en.status='completed' or pr.progress=100) completed,max(case when en.status='completed' then 100 else pr.progress end) progress
   from own_enrollments en cross join lateral(
    select case when count(*)=0 then 0 else floor(100.0*count(*) filter(where up.completed_at is not null)/count(*))::int end progress
    from academy.training_units u left join academy.training_unit_progress up on up.tenant_id=t and up.enrollment_id=en.id and up.unit_id=u.id
    where u.tenant_id=t and u.version_id=en.version_id and u.required
   )pr where en.course_id=c.id having count(*)>0
  )e on true where pc.tenant_id=t and pc.path_id=p.id and pc.revision=p.published_revision
 )) order by p.n)filter(where p.n<=20),'[]'),count(*)>20 into rows,more from numbered p;
 return jsonb_build_object('paths',rows,'hasMore',more,'offset',p_offset,'pageSize',20);
end $$;

revoke all on function private_app.academy_authoring_release_immutable_v1(),private_app.academy_authoring_enabled_v1(uuid),private_app.academy_authoring_blank_v1(text,text),private_app.academy_authoring_pick_v1(jsonb,text[]),private_app.academy_authoring_ai_brief_validate_v1(jsonb),private_app.academy_authoring_document_validate_v1(jsonb),private_app.academy_authoring_path_validate_v1(jsonb),private_app.academy_authoring_existing_document_v1(uuid,uuid) from public,anon,authenticated;
revoke all on function public.v1_academy_authoring_snapshot(text,uuid,uuid,integer,text,integer),public.v1_academy_authoring_action(text,text,uuid,jsonb),public.v1_academy_learner_paths(text,integer) from public,anon;
grant execute on function public.v1_academy_authoring_snapshot(text,uuid,uuid,integer,text,integer),public.v1_academy_authoring_action(text,text,uuid,jsonb),public.v1_academy_learner_paths(text,integer) to authenticated;
commit;
