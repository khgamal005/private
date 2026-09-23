-- A tenant-managed academy directory backed by canonical students and staff.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

create unique index if not exists academy_people_staff_tenant_id_uq on people.staff_profiles(tenant_id,id);
create unique index if not exists academy_people_invitation_tenant_id_uq on academy.platform_invitations(tenant_id,id);
create table academy.instructor_directory (
 tenant_id uuid not null references core.tenants(id),staff_id uuid not null,subject_id uuid references access_control.subjects(id),invitation_id uuid,
 created_by_subject_id uuid not null references access_control.subjects(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 primary key(tenant_id,staff_id),unique(tenant_id,subject_id),unique(invitation_id),
 foreign key(tenant_id,staff_id) references people.staff_profiles(tenant_id,id),
 foreign key(tenant_id,invitation_id) references academy.platform_invitations(tenant_id,id)
);
create index academy_instructor_directory_actor_idx on academy.instructor_directory(created_by_subject_id);
create index academy_instructor_directory_invitation_idx on academy.instructor_directory(tenant_id,invitation_id) where invitation_id is not null;
create index academy_instructor_directory_subject_idx on academy.instructor_directory(subject_id) where subject_id is not null;
alter table academy.instructor_directory enable row level security;
alter table academy.instructor_directory force row level security;
revoke all on academy.instructor_directory from public,anon,authenticated,service_role;

create function private_app.academy_person_contact_v1(t uuid,person jsonb,p_source text) returns uuid
language plpgsql security definer set search_path='' as $$
declare c sales_core.contacts%rowtype;phone text:=private_app.normalize_lead_phone(person->>'phone');email text:=lower(btrim(person->>'email'));actor uuid:=private_app.current_subject_id();
begin
 if actor is null or p_source not in ('academy_store','academy_dashboard') or phone is null or coalesce(length(btrim(person->>'name')),0) not between 2 and 200
  or coalesce(email,'')!~'^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' or length(email)>254 then raise exception 'academy_identity_required';end if;
 perform pg_advisory_xact_lock(hashtextextended(t::text||':academy-person:'||phone,220926));
 select * into c from sales_core.contacts where tenant_id=t and (id in(select contact_id from sales_core.contact_identities where tenant_id=t and identity_type='phone' and identity_value=phone)
  or private_app.normalize_lead_phone(sales_core.contacts.phone)=phone) order by created_at,id limit 1 for update;
 if c.id is not null then
  if lower(coalesce(c.email,''))<>email then raise exception 'academy_identity_review_required';end if;
  return c.id;
 end if;
 insert into sales_core.contacts(tenant_id,contact_key,full_name,phone,email,source,created_by_subject_id,metadata)
 values(t,'academy-'||gen_random_uuid()::text,btrim(person->>'name'),phone,email,p_source,actor,jsonb_build_object('source',p_source)) returning id into c.id;
 return c.id;
end $$;
create or replace function private_app.academy_store_contact_v1(t uuid,person jsonb) returns uuid
language sql security definer set search_path='' as $$
 select private_app.academy_person_contact_v1(t,person,'academy_store')
$$;

create function public.v1_academy_people_snapshot(p_slug text,p_query text default '',p_offset integer default 0,p_kind text default 'students') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare t uuid;rows jsonb;more boolean;can_team boolean;can_students boolean;
begin
 t:=private_app.academy_training_tenant_v1(p_slug);
 can_team:=private_app.academy_has_permission_v1(t,'manageTeam');can_students:=private_app.academy_has_permission_v1(t,'manageAdmissions');
 if not (can_team or can_students or private_app.academy_has_permission_v1(t,'manageLearning')) then raise exception 'forbidden' using errcode='42501';end if;
 if p_query is null or length(p_query)>100 or p_offset is null or p_offset not between 0 and 100000 or p_kind is null or p_kind not in ('students','instructors') then raise exception 'invalid_request';end if;
 if not private_app.academy_delivery_enabled_v1(t) then return jsonb_build_object('available',false,'rows','[]'::jsonb);end if;
 if p_kind='students' then
  with selected as(select st.*,row_number()over(order by st.created_at desc,st.id) n from academy.students st
   where st.tenant_id=t and (p_query='' or strpos(lower(st.full_name),lower(p_query))>0 or strpos(lower(coalesce(st.email,'')),lower(p_query))>0 or strpos(coalesce(st.phone,''),p_query)>0)
   order by st.created_at desc,st.id limit 51 offset p_offset)
  select coalesce(jsonb_agg(jsonb_build_object('id',st.id,'name',st.full_name,'email',st.email,'phone',st.phone,'status',st.status,'contactId',st.contact_id,
   'accountStatus',(select a.status from academy.training_learner_accounts a where a.tenant_id=t and a.student_id=st.id),
   'ownerName',(select sp.full_name from sales_core.contacts c join people.staff_profiles sp on sp.tenant_id=c.tenant_id and sp.id=c.owner_staff_id where c.tenant_id=t and c.id=st.contact_id),
   'enrollmentCount',(select count(*) from academy.enrollments e where e.tenant_id=t and e.student_id=st.id and e.status in ('confirmed','active','completed')),
   'invitationPending',exists(select 1 from academy.training_invitations i where i.tenant_id=t and i.student_id=st.id and i.status='pending' and i.expires_at>now())) order by n)filter(where n<=p_offset+50),'[]'),count(*)>50 into rows,more from selected st;
 else
  with selected as(select d.*,sp.full_name,sp.email,sp.phone,sp.employment_status,pm.status account_status,i.status invitation_status,i.expires_at,
   row_number()over(order by d.created_at desc,d.staff_id) n
   from academy.instructor_directory d join people.staff_profiles sp on sp.tenant_id=t and sp.id=d.staff_id
   left join academy.platform_memberships pm on pm.tenant_id=t and pm.subject_id=d.subject_id
   left join academy.platform_invitations i on i.tenant_id=t and i.id=d.invitation_id
   where d.tenant_id=t and (p_query='' or strpos(lower(sp.full_name),lower(p_query))>0 or strpos(lower(coalesce(sp.email,'')),lower(p_query))>0)
   order by d.created_at desc,d.staff_id limit 51 offset p_offset)
  select coalesce(jsonb_agg(jsonb_build_object('id',staff_id,'name',full_name,'email',email,'phone',phone,'status',employment_status,'subjectId',subject_id,
   'accountStatus',account_status,'invitationPending',invitation_status='pending' and expires_at>now(),
   'runCount',(select count(*) from academy.training_run_instructors r where r.tenant_id=t and r.subject_id=selected.subject_id and r.active)) order by n)filter(where n<=p_offset+50),'[]'),count(*)>50 into rows,more from selected;
 end if;
 return jsonb_build_object('available',true,'tenantSlug',p_slug,'kind',p_kind,'query',p_query,'offset',p_offset,'hasMore',more,'rows',rows,
  'canAddStudents',can_students,'canManageInstructors',can_team and private_app.academy_has_permission_v1(t,'manageLearning'),
  'canInviteStudents',private_app.academy_has_permission_v1(t,'manageLearning'),
  'staff',case when can_team then coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.full_name,'email',s.email,'phone',s.phone)) from
   (select * from people.staff_profiles where tenant_id=t and employment_status='active' and (p_query='' or strpos(lower(full_name),lower(p_query))>0 or strpos(lower(coalesce(email,'')),lower(p_query))>0) order by full_name,id limit 50)s),'[]') else '[]'::jsonb end);
end $$;

create function public.v1_academy_people_action(p_slug text,p_action text,p_command_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
<<invite_instructor>>
declare t uuid;actor uuid:=private_app.current_subject_id();cached academy.platform_commands%rowtype;result jsonb;cid uuid;student academy.students%rowtype;
 staff people.staff_profiles%rowtype;email text;phone text;inv uuid;subject uuid;expiry timestamptz;
begin
 t:=private_app.academy_delivery_tenant_v1(p_slug);
 if p_action='add_student' then
  if private_app.academy_has_permission_v1(t,'manageAdmissions') is not true then raise exception 'forbidden' using errcode='42501';end if;
 elsif p_action='invite_student' then
  if private_app.academy_has_permission_v1(t,'manageLearning') is not true then raise exception 'forbidden' using errcode='42501';end if;
 elsif p_action='invite_instructor' then
  if private_app.academy_has_permission_v1(t,'manageTeam') is not true or private_app.academy_has_permission_v1(t,'manageLearning') is not true then raise exception 'forbidden' using errcode='42501';end if;
 else raise exception 'invalid_request';end if;
 if p_command_id is null or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>8192 then raise exception 'invalid_request';end if;
 perform pg_advisory_xact_lock(hashtextextended(t::text||':academy-people:'||p_command_id::text,230926));
 select * into cached from academy.platform_commands where tenant_id=t and command_id=p_command_id;
 if cached.command_id is not null then
  if cached.actor_subject_id<>actor or cached.action<>'people.'||p_action or cached.payload<>p_payload then raise exception 'academy_command_conflict';end if;
  return cached.response;
 end if;
 if p_action='add_student' then
  cid:=private_app.academy_person_contact_v1(t,p_payload,'academy_dashboard');
  select * into student from academy.students where tenant_id=t and contact_id=cid for update;
  if student.id is null then
   insert into academy.students(tenant_id,student_key,student_number,contact_id,full_name,email,phone,created_by_subject_id,metadata)
   select t,'contact-'||c.id::text,'STU-'||upper(replace(c.id::text,'-','')),c.id,c.full_name,c.email,c.phone,actor,jsonb_build_object('source','academy_dashboard')
   from sales_core.contacts c where c.tenant_id=t and c.id=cid returning * into student;
  elsif student.status not in ('active','graduated') then raise exception 'academy_learner_blocked';end if;
  result:=jsonb_build_object('studentId',student.id,'contactId',cid,'linked',true);
 elsif p_action='invite_student' then
  result:=public.v1_academy_training_action(p_slug,'issue_invitation',p_command_id,p_payload);
 else
  email:=lower(btrim(p_payload->>'email'));phone:=private_app.normalize_lead_phone(p_payload->>'phone');
  if coalesce(email,'')!~'^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' or length(email)>254 or coalesce(length(btrim(p_payload->>'name')),0) not between 2 and 200
   or coalesce(p_payload->>'tokenHash','')!~'^[0-9a-f]{64}$' then raise exception 'academy_identity_required';end if;
  perform pg_advisory_xact_lock(hashtextextended(t::text||':academy-instructor:'||email,230926));
  if nullif(p_payload->>'staffId','') is not null then
   select * into staff from people.staff_profiles where tenant_id=t and id=(p_payload->>'staffId')::uuid and employment_status='active' for update;
   if staff.id is null or lower(coalesce(staff.email,''))<>email then raise exception 'academy_identity_review_required';end if;
  else
   if (select count(*) from people.staff_profiles sp where sp.tenant_id=t and lower(sp.email)=invite_instructor.email)>1 then raise exception 'academy_identity_review_required';end if;
   select * into staff from people.staff_profiles where tenant_id=t and lower(people.staff_profiles.email)=invite_instructor.email for update;
   if staff.id is not null and staff.employment_status<>'active' then raise exception 'academy_identity_review_required';end if;
   if staff.id is null then
    insert into people.staff_profiles(tenant_id,full_name,email,phone,job_title,role_key,account_status,metadata)
    values(t,btrim(p_payload->>'name'),email,phone,'محاضر','instructor','profile_only',jsonb_build_object('source','academy_dashboard')) returning * into staff;
   end if;
  end if;
  select m.subject_id into subject from access_control.memberships m where m.id=staff.membership_id and m.tenant_id=t;
  if exists(select 1 from academy.platform_memberships pm join access_control.subjects s on s.id=pm.subject_id where pm.tenant_id=t and lower(s.email)=invite_instructor.email and pm.role_key<>'instructor') then raise exception 'academy_member_role_conflict';end if;
  if subject is not null and not exists(select 1 from access_control.subjects s join auth.users u on u.id=s.auth_user_id where s.id=subject and s.status='active' and lower(s.email)=invite_instructor.email and lower(u.email)=invite_instructor.email and u.email_confirmed_at is not null) then raise exception 'academy_identity_review_required';end if;
  update academy.platform_invitations set status='revoked' where tenant_id=t and academy.platform_invitations.email=invite_instructor.email and status='pending';
  expiry:=now()+interval '7 days';
  insert into academy.platform_invitations(tenant_id,email,role_key,token_hash,expires_at,invited_by_subject_id)
  values(t,email,'instructor',p_payload->>'tokenHash',expiry,actor) returning id into inv;
  insert into academy.instructor_directory(tenant_id,staff_id,invitation_id,created_by_subject_id) values(t,staff.id,inv,actor)
  on conflict(tenant_id,staff_id) do update set invitation_id=excluded.invitation_id,updated_at=now();
  result:=jsonb_build_object('staffId',staff.id,'invitationId',inv,'expiresAt',expiry);
 end if;
 insert into academy.platform_commands(tenant_id,command_id,actor_subject_id,action,payload,response) values(t,p_command_id,actor,'people.'||p_action,p_payload,result);
 perform private_app.write_audit('academy.people.'||p_action,'academy_people',coalesce(result->>'studentId',result->>'staffId',result->>'invitationId'),t,jsonb_build_object('commandId',p_command_id));
 return result;
end $$;

-- Verified invitation acceptance links the canonical staff profile. It never
-- grants an operational employee membership or impersonates an existing person.
create function private_app.academy_instructor_accept_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare directory academy.instructor_directory%rowtype;subject uuid;
begin
 if new.status<>'accepted' or old.status='accepted' or new.role_key<>'instructor' then return new;end if;
 select * into directory from academy.instructor_directory where tenant_id=new.tenant_id and invitation_id=new.id for update;
 if directory.staff_id is null then return new;end if;
 select m.subject_id into subject from people.staff_profiles sp join access_control.memberships m on m.id=sp.membership_id and m.tenant_id=sp.tenant_id where sp.tenant_id=new.tenant_id and sp.id=directory.staff_id;
 if (subject is not null and subject<>new.accepted_by_subject_id) or (directory.subject_id is not null and directory.subject_id<>new.accepted_by_subject_id) then raise exception 'academy_identity_review_required';end if;
 update academy.instructor_directory set subject_id=new.accepted_by_subject_id,updated_at=now() where tenant_id=new.tenant_id and staff_id=directory.staff_id;
 return new;
end $$;
create trigger academy_instructor_accept after update of status on academy.platform_invitations for each row execute function private_app.academy_instructor_accept_v1();

do $membership_guard$
declare definition text;needle text:='insert into academy.platform_memberships(tenant_id,subject_id,role_key,status,created_by_subject_id) values(inv.tenant_id';
begin
 definition:=pg_get_functiondef('public.v1_academy_membership_accept(text,text)'::regprocedure);
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'academy_membership_accept_baseline_changed';end if;
 execute replace(definition,needle,$guard$if exists(select 1 from academy.instructor_directory d where d.tenant_id=inv.tenant_id and d.invitation_id=inv.id)
  and exists(select 1 from academy.platform_memberships m where m.tenant_id=inv.tenant_id and m.subject_id=subject and m.role_key<>'instructor') then raise exception 'academy_member_role_conflict';end if;
 insert into academy.platform_memberships(tenant_id,subject_id,role_key,status,created_by_subject_id) values(inv.tenant_id$guard$);
end $membership_guard$;
revoke all on function private_app.academy_person_contact_v1(uuid,jsonb,text),private_app.academy_instructor_accept_v1(),public.v1_academy_people_snapshot(text,text,integer,text),public.v1_academy_people_action(text,text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v1_academy_people_snapshot(text,text,integer,text),public.v1_academy_people_action(text,text,uuid,jsonb) to authenticated;
commit;
