begin;

-- Hash-only provenance. Never retain another copy of the deleted lesson text.
create table zoom_core.authoring_sources (
 tenant_id uuid not null references core.tenants(id), draft_id uuid not null,
 course_id uuid not null, topic_hash text not null, unit_hash text not null, header_hash text not null,
 redacted_topic_hash text not null, redacted_unit_hash text not null, redacted_header_hash text not null,
 created_at timestamptz not null default now(), deleted_at timestamptz,
 deleted_by uuid references access_control.subjects(id), deletion_reason text,
 primary key(tenant_id,draft_id),
 foreign key(tenant_id,draft_id) references zoom_core.ai_drafts(tenant_id,id),
 foreign key(tenant_id,course_id) references academy.courses(tenant_id,id)
);
create index zoom_authoring_sources_course_idx on zoom_core.authoring_sources(tenant_id,course_id);
-- A private, transaction-local, exact old/new row permit. No session flag can
-- disable immutability; no public RPC accepts arbitrary row replacements.
create table zoom_core.redaction_permits (
 transaction_id bigint not null, table_oid oid not null, old_hash text not null,new_hash text not null,
 primary key(transaction_id,table_oid,old_hash,new_hash)
);
alter table zoom_core.authoring_sources enable row level security;
alter table zoom_core.redaction_permits enable row level security;
revoke all on zoom_core.authoring_sources,zoom_core.redaction_permits from public,anon,authenticated,service_role;

create function zoom_core.content_hash(p_value jsonb) returns text language sql immutable set search_path='' as $$
 select encode(sha256(convert_to(p_value::text,'UTF8')),'hex')
$$;
create function zoom_core.unit_projection(p_unit jsonb) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('title',p_unit->>'title','kind',p_unit->>'kind','required',coalesce((p_unit->>'required')::boolean,true),
 'minimumSeconds',coalesce((p_unit->>'minimumSeconds')::int,0),'body',coalesce(p_unit->>'body',''),
 'url',nullif(p_unit->>'url',''),'questions',coalesce(p_unit->'questions','[]'),
 'maxAttempts',coalesce((p_unit->>'maxAttempts')::int,3),'passPercent',round(coalesce((p_unit->>'passPercent')::numeric,70),2)::text)
$$;
create function zoom_core.redacted_topic(p_topic jsonb) returns jsonb language sql immutable set search_path='' as $$
 select p_topic||jsonb_build_object('title','محتوى أزيل بطلب معتمد','summary','',
 'units',jsonb_build_array((p_topic->'units'->0)||jsonb_build_object('title','محتوى أزيل بطلب معتمد','body','أزيل محتوى المصدر وفق طلب حذف معتمد.')))
$$;
create function zoom_core.capture_authoring_source() returns trigger language plpgsql security definer set search_path='' as $$
declare topic jsonb;clean jsonb;
begin
 if new.applied_course_id is null or old.applied_course_id is not null then return new;end if;
 select x into topic from academy.course_authoring a cross join lateral jsonb_array_elements(a.document->'topics') x
 where a.tenant_id=new.tenant_id and a.course_id=new.applied_course_id and x->>'id'='zoom-'||new.id::text;
 if topic is null or jsonb_array_length(topic->'units')<>1 or topic->'units'->0->>'id'<>'zoom-unit-'||new.id::text
 or topic->'units'->0->>'kind'<>'text' or topic->'units'->0->'required' is distinct from 'false'::jsonb then raise exception 'zoom_source_provenance_required';end if;
 clean:=zoom_core.redacted_topic(topic);
 insert into zoom_core.authoring_sources(tenant_id,draft_id,course_id,topic_hash,unit_hash,header_hash,redacted_topic_hash,redacted_unit_hash,redacted_header_hash)
 values(new.tenant_id,new.id,new.applied_course_id,zoom_core.content_hash(topic),zoom_core.content_hash(zoom_core.unit_projection(topic->'units'->0)),zoom_core.content_hash(topic-'units'),
 zoom_core.content_hash(clean),zoom_core.content_hash(zoom_core.unit_projection(clean->'units'->0)),zoom_core.content_hash(clean-'units'));
 return new;
end $$;
create trigger zoom_capture_authoring_source after update of applied_course_id on zoom_core.ai_drafts for each row execute function zoom_core.capture_authoring_source();

create function zoom_core.exact_redaction(p_table oid,p_old jsonb,p_new jsonb) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from zoom_core.redaction_permits where transaction_id=txid_current() and table_oid=p_table
 and old_hash=zoom_core.content_hash(p_old) and new_hash=zoom_core.content_hash(p_new))
$$;
create or replace function private_app.training_version_immutable_v1() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and zoom_core.exact_redaction(tg_relid,to_jsonb(old),to_jsonb(new)) then return new;end if;
 if tg_table_name='training_course_versions' then
  if old.status='published' then raise exception 'training_published_version_immutable';end if;
 elsif exists(select 1 from academy.training_course_versions where id=old.version_id and status='published') then
  raise exception 'training_published_version_immutable';
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create or replace function private_app.academy_authoring_release_immutable_v1() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='course_authoring_releases' and tg_op='UPDATE' and zoom_core.exact_redaction(tg_relid,to_jsonb(old),to_jsonb(new)) then return new;end if;
 raise exception 'academy_authoring_release_immutable';
end $$;

-- A tombstoned source cannot be republished from a stale authoring tab.
create function zoom_core.source_marker(p_id text) returns uuid language sql immutable set search_path='' as $$
 select case when p_id ~ '^zoom-(unit-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then regexp_replace(p_id,'^zoom-(unit-)?','')::uuid end
$$;
create function zoom_core.authoring_tombstone_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare s zoom_core.authoring_sources%rowtype;x jsonb;source_id uuid;source_course uuid;
begin
 for source_id in select distinct zoom_core.source_marker(q.marker) from (
  select topic->>'id' marker from jsonb_array_elements(new.document->'topics') topic
  union all select unit->>'id' from jsonb_array_elements(new.document->'topics') topic cross join lateral jsonb_array_elements(topic->'units') unit
 )q where zoom_core.source_marker(q.marker) is not null loop
  select coalesce(d.applied_course_id,cr.course_id) into source_course from zoom_core.ai_drafts d
  join zoom_core.recordings rec on rec.tenant_id=d.tenant_id and rec.id=d.recording_id
  join zoom_core.instances i on i.tenant_id=rec.tenant_id and i.id=rec.instance_id
  join zoom_core.links l on l.tenant_id=i.tenant_id and l.id=i.link_id
  join academy.course_run_sessions cs on cs.tenant_id=l.tenant_id and cs.id=l.session_id
  join academy.course_runs cr on cr.tenant_id=cs.tenant_id and cr.id=cs.course_run_id
  where d.tenant_id=new.tenant_id and d.id=source_id;
  if source_course is not null and source_course<>new.course_id then raise exception 'zoom_source_course_mismatch';end if;
  select * into s from zoom_core.authoring_sources where tenant_id=new.tenant_id and draft_id=source_id and deleted_at is not null;
  if s.draft_id is not null then
   for x in select value from jsonb_array_elements(new.document->'topics') loop
    if x->>'id'='zoom-'||s.draft_id::text then
     if zoom_core.content_hash(x)<>s.redacted_topic_hash then raise exception 'zoom_deleted_source';end if;
    elsif exists(select 1 from jsonb_array_elements(x->'units') u where u->>'id'='zoom-unit-'||s.draft_id::text) then raise exception 'zoom_deleted_source';end if;
   end loop;
  end if;
 end loop;
 return new;
end $$;
create trigger zoom_authoring_tombstone_guard before insert or update of document on academy.course_authoring for each row execute function zoom_core.authoring_tombstone_guard();
create trigger zoom_release_tombstone_guard before insert or update of document on academy.course_authoring_releases for each row execute function zoom_core.authoring_tombstone_guard();

create function zoom_core.learning_tombstone_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare s zoom_core.authoring_sources%rowtype;headers jsonb;x jsonb;projection jsonb;course uuid;
begin
 if tg_table_name='training_course_versions' then headers:=coalesce(new.policy->'curriculumTopics','[]');course:=new.course_id;
 else select coalesce(policy->'curriculumTopics','[]'),course_id into headers,course from academy.training_course_versions where tenant_id=new.tenant_id and id=new.version_id;end if;
 for x in select value from jsonb_array_elements(headers) loop
  select * into s from zoom_core.authoring_sources where tenant_id=new.tenant_id and draft_id=zoom_core.source_marker(x->>'id');
  if s.draft_id is not null and s.course_id<>course then raise exception 'zoom_source_course_mismatch';end if;
  if s.deleted_at is not null then
   if tg_table_name='training_course_versions' then
    if zoom_core.content_hash(x-'startPosition'-'unitCount')<>s.redacted_header_hash or x->>'unitCount'<>'1' then raise exception 'zoom_deleted_source';end if;
   elsif new.position=(x->>'startPosition')::int then
    projection:=zoom_core.unit_projection(jsonb_build_object('title',new.title,'kind',new.kind,'required',new.required,'minimumSeconds',new.minimum_seconds,'body',new.body,'url',new.url,'questions',new.questions,'maxAttempts',new.max_attempts,'passPercent',new.pass_percent));
    if zoom_core.content_hash(projection)<>s.redacted_unit_hash then raise exception 'zoom_deleted_source';end if;
   end if;
  end if;
 end loop;
 return new;
end $$;
create trigger zoom_learning_tombstone_guard before insert or update on academy.training_course_versions for each row execute function zoom_core.learning_tombstone_guard();
create trigger zoom_unit_tombstone_guard before insert or update on academy.training_units for each row execute function zoom_core.learning_tombstone_guard();

-- Internal plan includes only exact row replacements. The public preview exposes
-- identifiers/counts/hashes, never full lesson or learner data.
create function zoom_core.derivative_plan(t uuid,p_draft uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare s zoom_core.authoring_sources%rowtype;r record;x jsonb;doc jsonb;items jsonb;h text;pos integer;u record;u_json jsonb;v record;clean jsonb;
 changes jsonb:='[]';conflicts jsonb:='[]';headers jsonb;source_topic text:='zoom-'||p_draft::text;bytes_seen bigint:=0;
begin
 select * into s from zoom_core.authoring_sources where tenant_id=t and draft_id=p_draft;
 if s.draft_id is null then return jsonb_build_object('changes',changes,'conflicts',jsonb_build_array(jsonb_build_object('kind','provenance_missing')));end if;
 for r in
  select 'draft' kind,to_jsonb(a) row_data,a.document,a.course_id::text key from academy.course_authoring a where a.tenant_id=t and a.course_id=s.course_id
  union all select 'release',to_jsonb(a),a.document,a.version_id::text from academy.course_authoring_releases a where a.tenant_id=t and a.course_id=s.course_id
 order by kind,key
 loop
  bytes_seen:=bytes_seen+pg_column_size(r.row_data);
  if bytes_seen>8388608 then raise exception 'zoom_retention_batch_too_large';end if;
  items:='[]';
  for x in select value from jsonb_array_elements(r.document->'topics') loop
   if x->>'id'=source_topic then
    h:=zoom_core.content_hash(x);
    if h=s.topic_hash then x:=zoom_core.redacted_topic(x);
    elsif h<>s.redacted_topic_hash then conflicts:=conflicts||jsonb_build_array(jsonb_build_object('kind',r.kind,'key',r.key,'reason','human_edit'));end if;
   elsif exists(select 1 from jsonb_array_elements(x->'units') q where q->>'id'='zoom-unit-'||p_draft::text) then
    conflicts:=conflicts||jsonb_build_array(jsonb_build_object('kind',r.kind,'key',r.key,'reason','moved_unit'));
   end if;
   items:=items||jsonb_build_array(x);
  end loop;
  doc:=jsonb_set(r.document,'{topics}',items);
  if r.kind='release' and exists(select 1 from jsonb_array_elements(r.document->'topics') z where z->>'id'=source_topic)
  and not exists(select 1 from academy.training_course_versions ver where ver.tenant_id=t and ver.id=r.key::uuid and ver.policy->'curriculumTopics' @> jsonb_build_array(jsonb_build_object('id',source_topic))) then
   conflicts:=conflicts||jsonb_build_array(jsonb_build_object('kind','version','key',r.key,'reason','mapping_missing'));
  end if;
  if doc<>r.document then changes:=changes||jsonb_build_array(jsonb_build_object('kind',r.kind,'key',r.key,'before',r.row_data,'after',r.row_data||jsonb_build_object('document',doc)));end if;
 end loop;
 -- Authoring publication records the topic's startPosition. Each copied unit
 -- must still match the captured projection; IDs/positions/assessment gates stay.
 for v in select * from academy.training_course_versions where tenant_id=t and course_id=s.course_id order by id loop
  headers:='[]';
  for x in select value from jsonb_array_elements(coalesce(v.policy->'curriculumTopics','[]')) loop
   if x->>'id'=source_topic then
    if coalesce(x->>'unitCount','')<>'1' or coalesce(x->>'startPosition','')!~'^[0-9]{1,3}$' then
     conflicts:=conflicts||jsonb_build_array(jsonb_build_object('kind','version','key',v.id,'reason','structure_changed'));
    else
     pos:=(x->>'startPosition')::integer;
     select * into u from academy.training_units where tenant_id=t and version_id=v.id and position=pos;
     u_json:=zoom_core.unit_projection(jsonb_build_object('title',u.title,'kind',u.kind,'required',u.required,'minimumSeconds',u.minimum_seconds,'body',u.body,'url',u.url,'questions',u.questions,'maxAttempts',u.max_attempts,'passPercent',u.pass_percent));
     h:=zoom_core.content_hash(u_json);
     if u.id is null or h not in(s.unit_hash,s.redacted_unit_hash) then
      conflicts:=conflicts||jsonb_build_array(jsonb_build_object('kind','unit','key',v.id,'reason','human_edit'));
     elsif h=s.unit_hash then
      changes:=changes||jsonb_build_array(jsonb_build_object('kind','unit','key',u.id,'before',to_jsonb(u),'after',to_jsonb(u)||jsonb_build_object('title','محتوى أزيل بطلب معتمد','body','أزيل محتوى المصدر وفق طلب حذف معتمد.')));
     end if;
    end if;
    h:=zoom_core.content_hash(x-'startPosition'-'unitCount');
    if h=s.header_hash then x:=x||jsonb_build_object('title','محتوى أزيل بطلب معتمد','summary','');
    elsif h<>s.redacted_header_hash then conflicts:=conflicts||jsonb_build_array(jsonb_build_object('kind','version','key',v.id,'reason','human_edit'));end if;
   end if;
   headers:=headers||jsonb_build_array(x);
  end loop;
  if headers is distinct from coalesce(v.policy->'curriculumTopics','[]') then
   changes:=changes||jsonb_build_array(jsonb_build_object('kind','version','key',v.id,'before',to_jsonb(v),'after',to_jsonb(v)||jsonb_build_object('policy',jsonb_set(v.policy,'{curriculumTopics}',headers))));
  end if;
 end loop;
 for r in select * from academy.training_learning_events where tenant_id=t and event_type='version_published' and payload->'policy'->'curriculumTopics' @> jsonb_build_array(jsonb_build_object('id',source_topic)) order by id loop
  headers:='[]';
  for x in select value from jsonb_array_elements(r.payload->'policy'->'curriculumTopics') loop
   if x->>'id'=source_topic then
    h:=zoom_core.content_hash(x-'startPosition'-'unitCount');
    if h=s.header_hash then x:=x||jsonb_build_object('title','محتوى أزيل بطلب معتمد','summary','');
    elsif h<>s.redacted_header_hash then conflicts:=conflicts||jsonb_build_array(jsonb_build_object('kind','event','key',r.id,'reason','human_edit'));end if;
   end if;
   headers:=headers||jsonb_build_array(x);
  end loop;
  clean:=jsonb_set(r.payload,'{policy,curriculumTopics}',headers);
  if clean<>r.payload then changes:=changes||jsonb_build_array(jsonb_build_object('kind','event','key',r.id,'before',to_jsonb(r),'after',to_jsonb(r)||jsonb_build_object('payload',clean)));end if;
 end loop;
 -- Refuse an unbounded synchronous sweep; operational review can split courses.
 if jsonb_array_length(changes)>500 then raise exception 'zoom_retention_batch_too_large';end if;
 return jsonb_build_object('changes',changes,'conflicts',conflicts);
end $$;

create function zoom_core.derivative_authorize(p_slug text) returns uuid language plpgsql stable security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug,false);
begin
 if not zoom_core.allowed(t,'retention.manage') or not private_app.academy_has_permission_v1(t,'manageLearning') or not private_app.academy_has_permission_v1(t,'manageCourses') then raise exception 'zoom_forbidden';end if;
 return t;
end $$;
create function public.v1_zoom_derivative_snapshot(p_slug text,p_offset int default 0) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid:=zoom_core.derivative_authorize(p_slug);rows jsonb;
begin
 if p_offset is null or p_offset not between 0 and 100000 then raise exception 'zoom_invalid_request';end if;
 select coalesce(jsonb_agg(to_jsonb(r)),'[]') into rows from(
 select d.id draft_id,d.applied_course_id course_id,c.title_ar course_title,s.deleted_at,(s.draft_id is not null) provenance_available
 from zoom_core.ai_drafts d join academy.courses c on c.tenant_id=d.tenant_id and c.id=d.applied_course_id
 left join zoom_core.authoring_sources s on s.tenant_id=d.tenant_id and s.draft_id=d.id
 where d.tenant_id=t and d.state='source_removed' order by d.id limit 50 offset p_offset)r;
 return jsonb_build_object('rows',rows,'offset',p_offset,'hasMore',jsonb_array_length(rows)=50);
end $$;
create function public.v1_zoom_derivative_preview(p_slug text,p_draft_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid:=zoom_core.derivative_authorize(p_slug);plan jsonb;rows jsonb;
begin
 if not exists(select 1 from zoom_core.ai_drafts where tenant_id=t and id=p_draft_id and applied_course_id is not null and state='source_removed') then raise exception 'zoom_source_not_found';end if;
 plan:=zoom_core.derivative_plan(t,p_draft_id);
 select coalesce(jsonb_agg(jsonb_build_object('kind',x->>'kind','key',x->>'key')),'[]') into rows from jsonb_array_elements(plan->'changes') x;
 return jsonb_build_object('draftId',p_draft_id,'previewHash',zoom_core.content_hash(plan),'changes',rows,'conflicts',plan->'conflicts','backupDeletion','requires_storage_policy');
end $$;

create function zoom_core.derivative_execute(t uuid,p_draft uuid,p_plan jsonb) returns integer language plpgsql security definer set search_path='' as $$
declare x jsonb;table_name text;new_row jsonb;old_row jsonb;course uuid;changed integer:=0;
begin
 if jsonb_array_length(p_plan->'conflicts')<>0 then raise exception 'zoom_derivative_human_review_required';end if;
 select course_id into course from zoom_core.authoring_sources where tenant_id=t and draft_id=p_draft;
 for x in select value from jsonb_array_elements(p_plan->'changes') loop
  old_row:=x->'before';new_row:=x->'after';
  table_name:=case x->>'kind' when 'release' then 'academy.course_authoring_releases' when 'unit' then 'academy.training_units' when 'version' then 'academy.training_course_versions' end;
  if table_name is not null then insert into zoom_core.redaction_permits values(txid_current(),table_name::regclass,zoom_core.content_hash(old_row),zoom_core.content_hash(new_row));end if;
  case x->>'kind'
   when 'draft' then update academy.course_authoring set document=new_row->'document',revision=revision+1,updated_at=now(),updated_by_subject_id=coalesce(private_app.current_subject_id(),updated_by_subject_id) where tenant_id=t and course_id=course;
   when 'release' then update academy.course_authoring_releases set document=new_row->'document' where tenant_id=t and version_id=(x->>'key')::uuid;
   when 'unit' then update academy.training_units set title=new_row->>'title',body=new_row->>'body' where tenant_id=t and id=(x->>'key')::uuid;
   when 'version' then update academy.training_course_versions set policy=new_row->'policy' where tenant_id=t and id=(x->>'key')::uuid;
   when 'event' then update academy.training_learning_events set payload=new_row->'payload' where tenant_id=t and id=(x->>'key')::uuid;
   else raise exception 'zoom_invalid_request';
  end case;
  changed:=changed+1;
 end loop;
 delete from zoom_core.redaction_permits where transaction_id=txid_current();
 return changed;
end $$;
create function public.v1_zoom_derivative_delete(p_slug text,p_command_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.derivative_authorize(p_slug);d uuid:=(p_payload->>'draftId')::uuid;s zoom_core.authoring_sources%rowtype;plan jsonb;cached jsonb;v_result jsonb;n integer;
begin
 if p_payload->'reviewed' is distinct from 'true'::jsonb or length(trim(coalesce(p_payload->>'reason',''))) not between 10 and 500 then raise exception 'zoom_retention_approval_required';end if;
 cached:=zoom_core.command(t,p_command_id,'derivative_delete',p_payload);if cached is not null then return cached;end if;
 select * into s from zoom_core.authoring_sources where tenant_id=t and draft_id=d;
 if s.draft_id is null or not exists(select 1 from zoom_core.ai_drafts where tenant_id=t and id=d and state='source_removed') then raise exception 'zoom_source_not_found';end if;
 -- Same first lock as save/publish. This serializes previews against publication.
 perform 1 from academy.courses where tenant_id=t and id=s.course_id for update;
 perform 1 from academy.course_authoring where tenant_id=t and course_id=s.course_id for update;
 perform 1 from academy.training_course_versions where tenant_id=t and course_id=s.course_id order by id for update;
 select * into s from zoom_core.authoring_sources where tenant_id=t and draft_id=d for update;
 plan:=zoom_core.derivative_plan(t,d);
 if p_payload->>'previewHash' is distinct from zoom_core.content_hash(plan) then raise exception 'zoom_retention_preview_changed';end if;
 n:=zoom_core.derivative_execute(t,d,plan);
 update zoom_core.authoring_sources set deleted_at=coalesce(deleted_at,now()),deleted_by=coalesce(deleted_by,private_app.current_subject_id()),deletion_reason=coalesce(deletion_reason,trim(p_payload->>'reason')) where tenant_id=t and draft_id=d;
 -- Other derived sources and attendance remain separate required decisions.
 update zoom_core.purge_requests p set derivatives_need_review=false,state=case when derived_attendance_purged_at is not null then 'complete' else 'policy_required' end,
 completed_at=case when derived_attendance_purged_at is not null then now() end
 where p.tenant_id=t and p.advanced_purged_at is not null and p.derivatives_need_review
 and not exists(select 1 from zoom_core.ai_drafts a join zoom_core.recordings r on r.tenant_id=a.tenant_id and r.id=a.recording_id join zoom_core.instances i on i.tenant_id=r.tenant_id and i.id=r.instance_id
 left join zoom_core.authoring_sources src on src.tenant_id=a.tenant_id and src.draft_id=a.id
 where a.tenant_id=t and i.connection_id=p.connection_id and a.applied_course_id is not null and src.deleted_at is null);
 v_result:=jsonb_build_object('draftId',d,'changedCopies',n,'status','local_derivative_removed','backupDeletion','requires_storage_policy');
 update zoom_core.commands set result=v_result where tenant_id=t and id=p_command_id;
 perform private_app.write_audit('zoom.derivative_delete','zoom_ai_draft',d::text,t,jsonb_build_object('changedCopies',n,'courseId',s.course_id));
 return v_result;
end $$;

revoke all on function zoom_core.content_hash(jsonb),zoom_core.unit_projection(jsonb),zoom_core.redacted_topic(jsonb),zoom_core.capture_authoring_source(),zoom_core.exact_redaction(oid,jsonb,jsonb),zoom_core.source_marker(text),zoom_core.authoring_tombstone_guard(),zoom_core.learning_tombstone_guard(),zoom_core.derivative_plan(uuid,uuid),zoom_core.derivative_authorize(text),zoom_core.derivative_execute(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.v1_zoom_derivative_snapshot(text,int),public.v1_zoom_derivative_preview(text,uuid),public.v1_zoom_derivative_delete(text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v1_zoom_derivative_snapshot(text,int),public.v1_zoom_derivative_preview(text,uuid),public.v1_zoom_derivative_delete(text,uuid,jsonb) to authenticated;

-- Export outside the database backup, sign with a separately held operator key,
-- and replay into an isolated restore BEFORE opening it to users. This is a
-- derivative ledger, not evidence that the provider expired every backup.
create function public.v1_zoom_derivative_ledger(p_tenant_id uuid,p_after uuid default null) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare rows jsonb;
begin
 perform zoom_core.service_only();
 select coalesce(jsonb_agg(to_jsonb(r) order by r.draft_id),'[]') into rows from(
 select tenant_id,draft_id,course_id,topic_hash,unit_hash,header_hash,redacted_topic_hash,redacted_unit_hash,redacted_header_hash,deleted_at,deleted_by
 from zoom_core.authoring_sources where tenant_id=p_tenant_id and deleted_at is not null and (p_after is null or draft_id>p_after) order by draft_id limit 200)r;
 return jsonb_build_object('entries',rows,'hasMore',jsonb_array_length(rows)=200);
end $$;
create function public.v1_zoom_derivative_replay(p_tenant_id uuid,p_tombstone jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare s zoom_core.authoring_sources%rowtype;d uuid;plan jsonb;changed int;connection uuid;
begin
 perform zoom_core.service_only();
 if p_tombstone is null or jsonb_typeof(p_tombstone)<>'object' or octet_length(p_tombstone::text)>4096 or p_tombstone->>'tenant_id' is distinct from p_tenant_id::text
 or nullif(p_tombstone->>'deleted_at','') is null or nullif(p_tombstone->>'deleted_by','') is null then raise exception 'zoom_deletion_ledger_invalid';end if;
 d:=(p_tombstone->>'draft_id')::uuid;
 select * into s from zoom_core.authoring_sources where tenant_id=p_tenant_id and draft_id=d;
 if s.draft_id is null then return jsonb_build_object('draftId',d,'status','source_absent_in_backup');end if;
 if p_tombstone-'deleted_at'-'deleted_by' is distinct from jsonb_build_object('tenant_id',s.tenant_id,'draft_id',s.draft_id,'course_id',s.course_id,
 'topic_hash',s.topic_hash,'unit_hash',s.unit_hash,'header_hash',s.header_hash,'redacted_topic_hash',s.redacted_topic_hash,'redacted_unit_hash',s.redacted_unit_hash,'redacted_header_hash',s.redacted_header_hash) then raise exception 'zoom_deletion_ledger_invalid';end if;
 perform 1 from academy.courses where tenant_id=p_tenant_id and id=s.course_id for update;
 perform 1 from academy.course_authoring where tenant_id=p_tenant_id and course_id=s.course_id for update;
 perform 1 from academy.training_course_versions where tenant_id=p_tenant_id and course_id=s.course_id order by id for update;
 perform 1 from zoom_core.authoring_sources where tenant_id=p_tenant_id and draft_id=d for update;
 plan:=zoom_core.derivative_plan(p_tenant_id,d);changed:=zoom_core.derivative_execute(p_tenant_id,d,plan);
 update zoom_core.authoring_sources set deleted_at=coalesce(deleted_at,(p_tombstone->>'deleted_at')::timestamptz),deleted_by=coalesce(deleted_by,(p_tombstone->>'deleted_by')::uuid),deletion_reason=coalesce(deletion_reason,'Replayed verified external deletion ledger') where tenant_id=p_tenant_id and draft_id=d;
 select i.connection_id into connection from zoom_core.ai_drafts a join zoom_core.recordings r on r.tenant_id=a.tenant_id and r.id=a.recording_id join zoom_core.instances i on i.tenant_id=r.tenant_id and i.id=r.instance_id where a.tenant_id=p_tenant_id and a.id=d;
 if changed>0 then insert into zoom_core.retention_runs(tenant_id,connection_id,status,counts) values(p_tenant_id,connection,'derivative_ledger_replayed',jsonb_build_object('draftId',d,'changedCopies',changed));end if;
 return jsonb_build_object('draftId',d,'status','local_derivative_removed','changedCopies',changed,'backupDeletion','requires_storage_policy');
end $$;
revoke all on function public.v1_zoom_derivative_ledger(uuid,uuid),public.v1_zoom_derivative_replay(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v1_zoom_derivative_ledger(uuid,uuid),public.v1_zoom_derivative_replay(uuid,jsonb) to service_role;

commit;
