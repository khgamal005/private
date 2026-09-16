begin;

-- Additive pilot storage. Canonical contacts, enrollments, money, attendance and
-- certificates remain authoritative. No pilot is enabled by this migration.
create unique index if not exists training_courses_tenant_id_uq on academy.courses(tenant_id,id);
create unique index if not exists training_students_tenant_id_uq on academy.students(tenant_id,id);
create unique index if not exists training_enrollments_tenant_id_uq on academy.enrollments(tenant_id,id);
create unique index if not exists training_runs_tenant_id_uq on academy.course_runs(tenant_id,id);

create table academy.training_course_versions (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references core.tenants(id),
 course_id uuid not null, version integer not null check(version>0), title text not null check(length(trim(title)) between 2 and 300),
 status text not null default 'draft' check(status in ('draft','published')),
 learning_mode text not null check(learning_mode in ('self_paced','live','blended')),
 policy jsonb not null default '{}' check(jsonb_typeof(policy)='object'),
 created_by_subject_id uuid not null references access_control.subjects(id),
 reviewed_by_subject_id uuid references access_control.subjects(id), published_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(tenant_id,course_id) references academy.courses(tenant_id,id),
 unique(tenant_id,id), unique(tenant_id,course_id,version),
 check((status='draft' and published_at is null) or (status='published' and published_at is not null and reviewed_by_subject_id is not null))
);
create table academy.training_units (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references core.tenants(id),version_id uuid not null,
 position integer not null check(position between 1 and 100), title text not null check(length(trim(title)) between 2 and 300),
 kind text not null check(kind in ('text','video','link','quiz','assignment')), required boolean not null default true,
 minimum_seconds integer not null default 0 check(minimum_seconds between 0 and 86400),
 body text not null default '' check(length(body)<=50000), url text check(url is null or (length(url)<=2048 and url ~ '^https://[^[:space:]]+$')),
 questions jsonb not null default '[]' check(jsonb_typeof(questions)='array' and jsonb_array_length(questions)<=50),
 max_attempts integer not null default 3 check(max_attempts between 1 and 20),
 pass_percent numeric(5,2) not null default 70 check(pass_percent between 0 and 100),
 foreign key(tenant_id,version_id) references academy.training_course_versions(tenant_id,id),
 unique(tenant_id,id), unique(tenant_id,version_id,id),unique(tenant_id,version_id,position)
);
create table academy.training_enrollment_versions (
 tenant_id uuid not null references core.tenants(id),enrollment_id uuid not null,version_id uuid not null,
 assigned_by_subject_id uuid not null references access_control.subjects(id),assigned_at timestamptz not null default now(),
 primary key(tenant_id,enrollment_id), unique(tenant_id,enrollment_id,version_id),
 foreign key(tenant_id,enrollment_id) references academy.enrollments(tenant_id,id),
 foreign key(tenant_id,version_id) references academy.training_course_versions(tenant_id,id)
);
create table academy.training_learner_accounts (
 tenant_id uuid not null references core.tenants(id),student_id uuid not null,subject_id uuid not null references access_control.subjects(id),
 status text not null default 'active' check(status in ('active','suspended')), bound_at timestamptz not null default now(),
 primary key(tenant_id,student_id),unique(tenant_id,subject_id),
 foreign key(tenant_id,student_id) references academy.students(tenant_id,id)
);
create table academy.training_invitations (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references core.tenants(id),student_id uuid not null,
 email text not null check(email=lower(trim(email)) and length(email)<=254),token_hash text not null unique check(token_hash~'^[0-9a-f]{64}$'),
 status text not null default 'pending' check(status in ('pending','accepted','revoked')),
 expires_at timestamptz not null, invited_by_subject_id uuid not null references access_control.subjects(id),
 accepted_by_subject_id uuid references access_control.subjects(id),accepted_at timestamptz,
 activation_claim_id uuid,activation_claim_expires_at timestamptz,created_at timestamptz not null default now(),
 foreign key(tenant_id,student_id) references academy.students(tenant_id,id),
 check(expires_at>created_at),check((status='accepted')=(accepted_at is not null))
);
create unique index training_invitation_one_pending_idx on academy.training_invitations(tenant_id,student_id) where status='pending';
create index training_invitation_student_idx on academy.training_invitations(tenant_id,student_id,created_at desc);
create table academy.training_run_instructors (
 tenant_id uuid not null references core.tenants(id),run_id uuid not null,subject_id uuid not null references access_control.subjects(id),
 active boolean not null default true,assigned_by_subject_id uuid not null references access_control.subjects(id),assigned_at timestamptz not null default now(),
 primary key(tenant_id,run_id,subject_id),foreign key(tenant_id,run_id) references academy.course_runs(tenant_id,id)
);
create index training_instructor_subject_idx on academy.training_run_instructors(tenant_id,subject_id,run_id) where active;
create table academy.training_unit_progress (
 tenant_id uuid not null references core.tenants(id),enrollment_id uuid not null,version_id uuid not null,unit_id uuid not null,
 opened_at timestamptz not null default now(),last_opened_at timestamptz not null default now(),completed_at timestamptz,
 completed_by_subject_id uuid references access_control.subjects(id),
 primary key(tenant_id,enrollment_id,unit_id),
 foreign key(tenant_id,enrollment_id,version_id) references academy.training_enrollment_versions(tenant_id,enrollment_id,version_id),
 foreign key(tenant_id,version_id,unit_id) references academy.training_units(tenant_id,version_id,id)
);
create table academy.training_quiz_attempts (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references core.tenants(id),enrollment_id uuid not null,version_id uuid not null,unit_id uuid not null,
 attempt integer not null check(attempt>0),answers jsonb not null check(jsonb_typeof(answers)='object'),score numeric(5,2) not null check(score between 0 and 100),
 passed boolean not null,submitted_by_subject_id uuid not null references access_control.subjects(id),submitted_at timestamptz not null default now(),
 foreign key(tenant_id,enrollment_id,version_id) references academy.training_enrollment_versions(tenant_id,enrollment_id,version_id),
 foreign key(tenant_id,version_id,unit_id) references academy.training_units(tenant_id,version_id,id),unique(tenant_id,enrollment_id,unit_id,attempt)
);
create table academy.training_submissions (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references core.tenants(id),enrollment_id uuid not null,version_id uuid not null,unit_id uuid not null,
 attempt integer not null check(attempt>0),body text not null check(length(trim(body)) between 2 and 50000),
 submitted_by_subject_id uuid not null references access_control.subjects(id),submitted_at timestamptz not null default now(),
 foreign key(tenant_id,enrollment_id,version_id) references academy.training_enrollment_versions(tenant_id,enrollment_id,version_id),
 foreign key(tenant_id,version_id,unit_id) references academy.training_units(tenant_id,version_id,id),unique(tenant_id,id),unique(tenant_id,enrollment_id,unit_id,attempt)
);
create index training_submission_queue_idx on academy.training_submissions(tenant_id,submitted_at,id);
create table academy.training_grades (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references core.tenants(id),submission_id uuid not null,
 score numeric(5,2) not null check(score between 0 and 100),feedback text not null check(length(trim(feedback)) between 2 and 10000),
 graded_by_subject_id uuid not null references access_control.subjects(id),graded_at timestamptz not null default now(),
 foreign key(tenant_id,submission_id) references academy.training_submissions(tenant_id,id)
);
create index training_grades_latest_idx on academy.training_grades(tenant_id,submission_id,graded_at desc,id);
create table academy.training_learning_events (
 id uuid primary key default gen_random_uuid(),sequence bigint generated always as identity unique,
 tenant_id uuid not null references core.tenants(id),enrollment_id uuid,actor_subject_id uuid not null references access_control.subjects(id),
 event_type text not null,payload jsonb not null default '{}',created_at timestamptz not null default now(),
 external_delivery_status text not null default 'disabled' check(external_delivery_status in ('disabled','pending','acknowledged','failed')),
 foreign key(tenant_id,enrollment_id) references academy.enrollments(tenant_id,id)
);
create index training_learning_events_enrollment_idx on academy.training_learning_events(tenant_id,enrollment_id,sequence);

-- No direct table access: every response is projected by the authorized RPC.
do $$ declare v_table text; begin
 foreach v_table in array array['training_course_versions','training_units','training_enrollment_versions','training_learner_accounts','training_invitations','training_run_instructors','training_unit_progress','training_quiz_attempts','training_submissions','training_grades','training_learning_events'] loop
  execute format('alter table academy.%I enable row level security',v_table);
  execute format('revoke all on table academy.%I from public,anon,authenticated',v_table);
 end loop;
end $$;

create function private_app.training_version_immutable_v1() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_table_name='training_course_versions' then
  if old.status='published' then raise exception 'training_published_version_immutable';end if;
 elsif exists(select 1 from academy.training_course_versions where id=old.version_id and status='published') then
  raise exception 'training_published_version_immutable';
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger training_version_immutable before update or delete on academy.training_course_versions for each row execute function private_app.training_version_immutable_v1();
create trigger training_unit_immutable before update or delete on academy.training_units for each row execute function private_app.training_version_immutable_v1();
create function private_app.training_unit_insert_guard_v1() returns trigger language plpgsql set search_path='' as $$
begin
 if exists(select 1 from academy.training_course_versions where id=new.version_id and status='published') then raise exception 'training_published_version_immutable';end if;return new;
end $$;
create trigger training_unit_insert_guard before insert on academy.training_units for each row execute function private_app.training_unit_insert_guard_v1();
create function private_app.training_enrollment_version_guard_v1() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op<>'INSERT' then raise exception 'training_enrollment_version_immutable';end if;
 if not exists(select 1 from academy.enrollments e join academy.training_course_versions v on v.tenant_id=e.tenant_id and v.course_id=e.course_id where e.tenant_id=new.tenant_id and e.id=new.enrollment_id and v.id=new.version_id and v.status='published') then raise exception 'training_version_course_mismatch';end if;
 if exists(select 1 from academy.enrollments e join academy.course_runs r on r.tenant_id=e.tenant_id and r.id=e.course_run_id join academy.training_course_versions v on v.tenant_id=e.tenant_id and v.id=new.version_id where e.tenant_id=new.tenant_id and e.id=new.enrollment_id and r.metadata->>'trainingJourneySelfpaced'='true' and v.learning_mode<>'self_paced') then raise exception 'training_learning_mode_mismatch';end if;return new;
end $$;
create trigger training_enrollment_version_guard before insert or update or delete on academy.training_enrollment_versions for each row execute function private_app.training_enrollment_version_guard_v1();

create function private_app.training_is_learner_v1(p_tenant_id uuid,p_enrollment_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from academy.training_learner_accounts a join academy.enrollments e on e.tenant_id=a.tenant_id and e.student_id=a.student_id join academy.students s on s.tenant_id=a.tenant_id and s.id=a.student_id where a.tenant_id=p_tenant_id and e.id=p_enrollment_id and a.subject_id=private_app.current_subject_id() and a.status='active' and s.status in ('active','graduated'))
$$;
create function private_app.training_is_instructor_v1(p_tenant_id uuid,p_run_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from academy.training_run_instructors i join access_control.memberships m on m.tenant_id=i.tenant_id and m.subject_id=i.subject_id and m.scope='tenant' and m.status='active' join access_control.subjects actor on actor.id=i.subject_id and actor.status='active' and not actor.must_change_password where i.tenant_id=p_tenant_id and i.run_id=p_run_id and i.subject_id=private_app.current_subject_id() and i.active)
$$;
create function private_app.training_learning_event_v1(p_tenant_id uuid,p_enrollment_id uuid,p_event_type text,p_payload jsonb) returns void language plpgsql security definer set search_path='' as $$
begin
 if private_app.current_subject_id() is null then raise exception 'authentication_required';end if;
 insert into academy.training_learning_events(tenant_id,enrollment_id,actor_subject_id,event_type,payload) values(p_tenant_id,p_enrollment_id,private_app.current_subject_id(),p_event_type,p_payload);
 perform private_app.write_audit('training.'||p_event_type,'training_journey',coalesce(p_enrollment_id::text,p_payload->>'id'),p_tenant_id,p_payload);
end $$;

create function private_app.training_learning_eligibility_v1(p_enrollment_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
 e academy.enrollments%rowtype;v academy.training_course_versions%rowtype;r academy.course_runs%rowtype;
 v_required int;v_completed int;v_assessment_count int;v_graded_count int;v_score numeric;v_total int;v_done int;v_marked int;v_attended int;v_attendance numeric;
 v_reasons jsonb:='[]';v_finance jsonb;
begin
 select * into e from academy.enrollments where id=p_enrollment_id;
 select cv.* into v from academy.training_enrollment_versions ev join academy.training_course_versions cv on cv.tenant_id=ev.tenant_id and cv.id=ev.version_id where ev.tenant_id=e.tenant_id and ev.enrollment_id=e.id;
 if v.id is null then return null;end if;
 select * into r from academy.course_runs where tenant_id=e.tenant_id and id=e.course_run_id;
 select count(*),count(*) filter(where p.completed_at is not null) into v_required,v_completed from academy.training_units u left join academy.training_unit_progress p on p.tenant_id=u.tenant_id and p.unit_id=u.id and p.enrollment_id=e.id where u.tenant_id=e.tenant_id and u.version_id=v.id and u.required;
 select count(*),count(score),round(avg(score),2) into v_assessment_count,v_graded_count,v_score from (
  select case when u.kind='quiz' then (select max(a.score) from academy.training_quiz_attempts a where a.tenant_id=e.tenant_id and a.enrollment_id=e.id and a.unit_id=u.id) else (select g.score from academy.training_submissions s join academy.training_grades g on g.tenant_id=s.tenant_id and g.submission_id=s.id where s.tenant_id=e.tenant_id and s.enrollment_id=e.id and s.unit_id=u.id order by s.attempt desc,g.graded_at desc,g.id desc limit 1) end score from academy.training_units u where u.tenant_id=e.tenant_id and u.version_id=v.id and u.required and u.kind in ('quiz','assignment')
 ) x;
 select count(*),count(*) filter(where s.status='completed') into v_total,v_done from academy.course_run_sessions s where s.tenant_id=e.tenant_id and s.course_run_id=e.course_run_id and s.status<>'cancelled';
 select count(*),count(*) filter(where a.status in ('present','late')) into v_marked,v_attended from academy.attendance_records a join academy.course_run_sessions s on s.tenant_id=a.tenant_id and s.id=a.session_id and s.status<>'cancelled' where a.tenant_id=e.tenant_id and a.enrollment_id=e.id;
 v_attendance:=case when v_total=0 then 0 else round(v_attended*100.0/v_total,2) end;
 v_finance:=private_app.training_journey_financial_access_v1(e.id);
 if e.status not in ('confirmed','active','completed') then v_reasons:=v_reasons||'"enrollment_inactive"'::jsonb;end if;
 if not coalesce((v.policy->>'certificateEnabled')::boolean,false) then v_reasons:=v_reasons||'"certificate_disabled"'::jsonb;end if;
 if v_required=0 or v_completed<v_required then v_reasons:=v_reasons||'"required_units_incomplete"'::jsonb;end if;
 if v_assessment_count=0 or v_graded_count<v_assessment_count then v_reasons:=v_reasons||'"assessment_missing"'::jsonb;
 elsif v_score<(v.policy->>'minAssessmentPercent')::numeric then v_reasons:=v_reasons||'"assessment_below_threshold"'::jsonb;end if;
 if v.learning_mode<>'self_paced' then
  if v_total=0 then v_reasons:=v_reasons||'"no_sessions"'::jsonb;end if;
  if v_done<v_total then v_reasons:=v_reasons||'"sessions_pending"'::jsonb;end if;
  if v_marked<v_total then v_reasons:=v_reasons||'"attendance_incomplete"'::jsonb;end if;
  if v_attendance<(v.policy->>'minAttendancePercent')::numeric then v_reasons:=v_reasons||'"attendance_below_threshold"'::jsonb;end if;
 end if;
 if coalesce((v.policy->>'requireCompletedRun')::boolean,false) and r.status<>'completed' then v_reasons:=v_reasons||'"run_not_completed"'::jsonb;end if;
 if not coalesce((v_finance->>'certificationAllowed')::boolean,false) then v_reasons:=v_reasons||'"financial_clearance_required"'::jsonb;end if;
 return jsonb_build_object('eligible',jsonb_array_length(v_reasons)=0,'reasons',v_reasons,'versionId',v.id,'versionTitle',v.title,'policy',v.policy,'totalUnits',v_required,'completedUnits',v_completed,'assessmentPercent',v_score,'minAssessmentPercent',(v.policy->>'minAssessmentPercent')::numeric,'totalSessions',v_total,'completedSessions',v_done,'recordedSessions',v_marked,'attendedSessions',v_attended,'attendancePercent',v_attendance,'minAttendancePercent',(v.policy->>'minAttendancePercent')::numeric,'financialAccess',v_finance);
end $$;
-- Existing issuance RPCs call this canonical eligibility function. Preserve the
-- legacy result for every enrollment that is not explicitly pinned to the pilot.
alter function private_app.training_eligibility(uuid) rename to training_eligibility_before_journey_v1;
create function private_app.training_eligibility(p_enrollment_id uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare v_result jsonb;begin
 v_result:=private_app.training_learning_eligibility_v1(p_enrollment_id);
 if v_result is not null then return v_result-'financialAccess';end if;
 if exists(select 1 from academy.enrollments e join academy.training_financial_links l on l.tenant_id=e.tenant_id and l.handoff_id=e.handoff_id join academy.training_journey_settings cfg on cfg.tenant_id=e.tenant_id and cfg.enabled where e.id=p_enrollment_id and e.tenant_id='3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid) then return jsonb_build_object('eligible',false,'reasons',jsonb_build_array('training_version_required'));end if;
 return private_app.training_eligibility_before_journey_v1(p_enrollment_id);
end $$;
create function private_app.training_certificate_guard_v1() returns trigger language plpgsql set search_path='' as $$
declare v_result jsonb;begin
 if new.status='issued' then
  v_result:=case when exists(select 1 from academy.training_enrollment_versions where tenant_id=new.tenant_id and enrollment_id=new.enrollment_id) or exists(select 1 from academy.enrollments e join academy.training_financial_links l on l.tenant_id=e.tenant_id and l.handoff_id=e.handoff_id join academy.training_journey_settings cfg on cfg.tenant_id=e.tenant_id and cfg.enabled where e.tenant_id=new.tenant_id and e.id=new.enrollment_id) then private_app.training_eligibility(new.enrollment_id) end;
  if v_result is not null then
   if not coalesce((v_result->>'eligible')::boolean,false) then raise exception 'training_certificate_not_eligible';end if;
   new.metadata:=coalesce(new.metadata,'{}')||jsonb_build_object('trainingJourneyEvidence',v_result,'trainingEvidenceRecordedAt',now());
  end if;
 end if;return new;
end $$;
create trigger training_certificate_eligibility_guard before insert or update of status on academy.certificates for each row execute function private_app.training_certificate_guard_v1();

create function private_app.training_reconcile_assessment_v1(p_tenant_id uuid,p_enrollment_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare v_result jsonb;v_run uuid;begin
 v_result:=private_app.training_learning_eligibility_v1(p_enrollment_id);
 if v_result->>'assessmentPercent' is not null then
  select course_run_id into v_run from academy.enrollments where tenant_id=p_tenant_id and id=p_enrollment_id;
  insert into academy.assessment_results(tenant_id,course_run_id,enrollment_id,assessment_key,title,score,max_score,notes,assessed_by_subject_id)
  values(p_tenant_id,v_run,p_enrollment_id,'final','التقييم النهائي',(v_result->>'assessmentPercent')::numeric,100,'محسوب من أدلة التعلم المعتمدة',private_app.current_subject_id())
  on conflict(enrollment_id,assessment_key) do update set score=excluded.score,max_score=100,notes=excluded.notes,assessed_at=now(),assessed_by_subject_id=excluded.assessed_by_subject_id;
 end if;
end $$;

create function public.v1_training_learning_action(p_tenant_slug text,p_action text,p_command_id uuid,p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare
 t uuid;s uuid;v_cached jsonb;v_response jsonb;v_course uuid;v_version uuid;v_num int;v_i int;v_n int;v_correct int;v_score numeric;v_passed boolean;v_q jsonb;v_item jsonb;v_policy jsonb;
 e academy.enrollments%rowtype;v academy.training_course_versions%rowtype;u academy.training_units%rowtype;
 inv academy.training_invitations%rowtype;sub academy.training_submissions%rowtype;v_student academy.students%rowtype;
 v_email text;v_confirmed timestamptz;v_expiry timestamptz;v_id uuid;v_subject uuid;v_finance jsonb;v_eligibility jsonb;v_before jsonb;
begin
 if auth.uid() is null then raise exception 'authentication_required';end if;
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>1048576 then raise exception 'training_invalid_payload';end if;
 if p_command_id is null then raise exception 'training_command_required';end if;
 -- Invitation proof is the sole bootstrap path for a new learner subject.
 if p_action='accept_invitation' then
  select * into inv from academy.training_invitations where token_hash=p_payload->>'tokenHash' for update;
  select lower(trim(email)),email_confirmed_at into v_email,v_confirmed from auth.users where id=auth.uid();
  if inv.id is null or inv.tenant_id<>'3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid or p_tenant_slug<>'marktone' or inv.expires_at<=now() or inv.status='revoked' or v_email is distinct from inv.email or v_confirmed is null then raise exception 'training_invitation_invalid';end if;
  select * into v_student from academy.students where tenant_id=inv.tenant_id and id=inv.student_id;
  if v_student.id is null or v_student.status not in ('active','graduated') or lower(trim(v_student.email)) is distinct from inv.email then raise exception 'training_invitation_invalid';end if;
  insert into access_control.subjects(auth_user_id,email,full_name,status,must_change_password) values(auth.uid(),v_email,v_student.full_name,'active',false) on conflict(auth_user_id) do nothing;
  select id into s from access_control.subjects where auth_user_id=auth.uid() and status='active' and not must_change_password and lower(email)=v_email;
  if s is null then raise exception 'training_subject_inactive';end if;
 end if;
 t:=private_app.training_journey_tenant_v1(p_tenant_slug);s:=private_app.current_subject_id();
 if s is null then raise exception 'authentication_required';end if;
 if p_action in ('save_draft','publish_version','assign_version','assign_instructor','issue_invitation','issue_certificate') then
  if not private_app.has_tenant_permission(t,'tenant.academy.write') then raise exception 'training_permission_denied';end if;
 elsif p_action in ('open_unit','complete_unit','submit_quiz','submit_assignment') then
  select * into e from academy.enrollments where tenant_id=t and id=(p_payload->>'enrollmentId')::uuid for update;
  if e.id is null or not private_app.training_is_learner_v1(t,e.id) then raise exception 'training_permission_denied';end if;
  if e.status not in ('confirmed','active','completed') then raise exception 'training_enrollment_inactive';end if;
  select unit.* into u from academy.training_enrollment_versions ev join academy.training_units unit on unit.tenant_id=ev.tenant_id and unit.version_id=ev.version_id where ev.tenant_id=t and ev.enrollment_id=e.id and unit.id=(p_payload->>'unitId')::uuid;
  if u.id is null then raise exception 'training_unit_not_found';end if;
  v_finance:=private_app.training_journey_financial_access_v1(e.id);
  if not coalesce((v_finance->>'trainingAllowed')::boolean,false) and not (p_action='open_unit' and exists(select 1 from academy.training_unit_progress where tenant_id=t and enrollment_id=e.id and unit_id=u.id and completed_at is not null)) then raise exception 'training_financial_access_suspended';end if;
  if exists(select 1 from academy.training_units prior where prior.tenant_id=t and prior.version_id=u.version_id and prior.position<u.position and prior.required and not exists(select 1 from academy.training_unit_progress p where p.tenant_id=t and p.enrollment_id=e.id and p.unit_id=prior.id and p.completed_at is not null)) then raise exception 'training_previous_units_required';end if;
 elsif p_action='grade_assignment' then
  select * into sub from academy.training_submissions where tenant_id=t and id=(p_payload->>'submissionId')::uuid;
  select * into e from academy.enrollments where tenant_id=t and id=sub.enrollment_id for update;
  if e.id is null or not private_app.training_is_instructor_v1(t,e.course_run_id) then raise exception 'training_instructor_assignment_required';end if;
 elsif p_action='create_request' then
  select * into e from academy.enrollments where tenant_id=t and id=(p_payload->>'enrollmentId')::uuid for update;
  if e.id is null or not private_app.training_is_learner_v1(t,e.id) then raise exception 'training_permission_denied';end if;
 elsif p_action='record_attendance' then
  select * into e from academy.enrollments where tenant_id=t and id=(p_payload->>'enrollmentId')::uuid for update;
  if e.id is null or not(private_app.training_is_instructor_v1(t,e.course_run_id) or private_app.has_tenant_permission(t,'tenant.training.write')) then raise exception 'training_permission_denied';end if;
 elsif p_action<>'accept_invitation' then raise exception 'training_unknown_action';end if;
 v_cached:=private_app.training_journey_command_v1(t,p_command_id,'learning.'||p_action,p_payload);
 if v_cached is not null then return v_cached;end if;

 if p_action='save_draft' then
  v_course:=(p_payload->>'courseId')::uuid;
  perform 1 from academy.courses where tenant_id=t and id=v_course for update;
  if not found then raise exception 'training_course_not_found';end if;
  if jsonb_typeof(p_payload->'units') is distinct from 'array' or jsonb_array_length(p_payload->'units') not between 1 and 100 then raise exception 'training_units_required';end if;
  v_version:=nullif(p_payload->>'versionId','')::uuid;
  if v_version is null then
   select coalesce(max(version),0)+1 into v_num from academy.training_course_versions where tenant_id=t and course_id=v_course;
   insert into academy.training_course_versions(tenant_id,course_id,version,title,learning_mode,policy,created_by_subject_id) values(t,v_course,v_num,trim(p_payload->>'title'),p_payload->>'learningMode',coalesce(p_payload->'policy','{}'),s) returning id into v_version;
  else
   select * into v from academy.training_course_versions where tenant_id=t and id=v_version and course_id=v_course for update;
   if v.id is null or v.status<>'draft' then raise exception 'training_draft_required';end if;
   update academy.training_course_versions set title=trim(p_payload->>'title'),learning_mode=p_payload->>'learningMode',policy=coalesce(p_payload->'policy','{}'),updated_at=now() where tenant_id=t and id=v_version;
   delete from academy.training_units where tenant_id=t and version_id=v_version;
  end if;
  v_i:=0;
  for v_item in select value from jsonb_array_elements(p_payload->'units') loop
   v_i:=v_i+1;
   insert into academy.training_units(tenant_id,version_id,position,title,kind,required,minimum_seconds,body,url,questions,max_attempts,pass_percent) values(t,v_version,v_i,trim(v_item->>'title'),v_item->>'kind',coalesce((v_item->>'required')::boolean,true),coalesce((v_item->>'minimumSeconds')::int,0),coalesce(v_item->>'body',''),nullif(v_item->>'url',''),coalesce(v_item->'questions','[]'),coalesce((v_item->>'maxAttempts')::int,3),coalesce((v_item->>'passPercent')::numeric,70));
  end loop;
  perform private_app.training_learning_event_v1(t,null,'draft_saved',jsonb_build_object('id',v_version,'courseId',v_course));
  v_response:=jsonb_build_object('versionId',v_version);
 elsif p_action='publish_version' then
  select * into v from academy.training_course_versions where tenant_id=t and id=(p_payload->>'versionId')::uuid for update;
  if v.id is null or v.status<>'draft' then raise exception 'training_draft_required';end if;
  if p_payload->'humanReviewed' is distinct from 'true'::jsonb then raise exception 'training_human_review_required';end if;
  v_policy:=v.policy;
  if jsonb_typeof(v_policy->'minAttendancePercent') is distinct from 'number' or jsonb_typeof(v_policy->'minAssessmentPercent') is distinct from 'number' or not(v_policy?'minAttendancePercent' and v_policy?'minAssessmentPercent' and v_policy?'requireCompletedRun' and v_policy?'certificateEnabled') or (v_policy->>'minAttendancePercent')::numeric not between 0 and 100 or (v_policy->>'minAssessmentPercent')::numeric not between 0 and 100 or jsonb_typeof(v_policy->'requireCompletedRun')<>'boolean' or jsonb_typeof(v_policy->'certificateEnabled')<>'boolean' or length(trim(coalesce(v_policy->>'termsVersion','')))<2 or coalesce(v_policy->>'supportEmail','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'training_policy_review_required';end if;
  if not exists(select 1 from academy.training_units where tenant_id=t and version_id=v.id and required and kind in ('quiz','assignment')) then raise exception 'training_assessment_required';end if;
  for u in select * from academy.training_units where tenant_id=t and version_id=v.id loop
   if u.kind in ('text','assignment') and length(trim(u.body))<2 then raise exception 'training_unit_content_required';end if;
   if u.kind in ('video','link') and u.url is null then raise exception 'training_unit_url_required';end if;
   if u.kind='quiz' then
    if jsonb_array_length(u.questions)=0 then raise exception 'training_quiz_questions_required';end if;
    if (select count(distinct q->>'id') from jsonb_array_elements(u.questions)q)<>jsonb_array_length(u.questions) then raise exception 'training_quiz_question_ids_invalid';end if;
    for v_q in select value from jsonb_array_elements(u.questions) loop
     if coalesce(v_q->>'id','') !~ '^[a-zA-Z0-9_-]{1,64}$' or length(trim(coalesce(v_q->>'prompt','')))<2 or length(v_q->>'prompt')>2000 or jsonb_typeof(v_q->'options') is distinct from 'array' then raise exception 'training_quiz_question_invalid';end if;
     if jsonb_typeof(v_q->'correctOptionIndex') is distinct from 'number' or coalesce(v_q->>'correctOptionIndex','') !~ '^[0-9]+$' or jsonb_array_length(v_q->'options') not between 2 and 8 or (v_q->>'correctOptionIndex')::int not between 0 and jsonb_array_length(v_q->'options')-1 or not(v_q?'correctOptionIndex') or exists(select 1 from jsonb_array_elements(v_q->'options')x where jsonb_typeof(x)<>'string' or length(trim(x#>>'{}')) not between 1 and 2000) then raise exception 'training_quiz_options_invalid';end if;
    end loop;
   end if;
  end loop;
  update academy.training_course_versions set status='published',reviewed_by_subject_id=s,published_at=now(),updated_at=now() where tenant_id=t and id=v.id;
  perform private_app.training_learning_event_v1(t,null,'version_published',jsonb_build_object('id',v.id,'courseId',v.course_id,'policy',v.policy));
  v_response:=jsonb_build_object('versionId',v.id,'status','published');
 elsif p_action='assign_version' then
  select * into e from academy.enrollments where tenant_id=t and id=(p_payload->>'enrollmentId')::uuid for update;
  if e.id is null then raise exception 'training_enrollment_not_found';end if;
  v_version:=(p_payload->>'versionId')::uuid;
  if exists(select 1 from academy.training_enrollment_versions where tenant_id=t and enrollment_id=e.id and version_id<>v_version) then raise exception 'training_enrollment_version_immutable';end if;
  insert into academy.training_enrollment_versions(tenant_id,enrollment_id,version_id,assigned_by_subject_id) values(t,e.id,v_version,s) on conflict(tenant_id,enrollment_id) do nothing;
  perform private_app.training_learning_event_v1(t,e.id,'version_assigned',jsonb_build_object('versionId',v_version));
  v_response:=jsonb_build_object('enrollmentId',e.id,'versionId',v_version);
 elsif p_action='assign_instructor' then
  v_id:=(p_payload->>'runId')::uuid;v_subject:=(p_payload->>'subjectId')::uuid;
  if not exists(select 1 from academy.course_runs where tenant_id=t and id=v_id) or not exists(select 1 from access_control.subjects a join access_control.memberships m on m.subject_id=a.id and m.tenant_id=t and m.status='active' and m.scope='tenant' where a.id=v_subject and a.status='active') then raise exception 'training_instructor_subject_invalid';end if;
  insert into academy.training_run_instructors(tenant_id,run_id,subject_id,active,assigned_by_subject_id) values(t,v_id,v_subject,coalesce((p_payload->>'active')::boolean,true),s) on conflict(tenant_id,run_id,subject_id) do update set active=excluded.active,assigned_by_subject_id=s,assigned_at=now();
  perform private_app.training_learning_event_v1(t,null,'instructor_assigned',jsonb_build_object('runId',v_id,'subjectId',v_subject,'active',coalesce((p_payload->>'active')::boolean,true)));
  v_response:=jsonb_build_object('runId',v_id,'subjectId',v_subject);
 elsif p_action='issue_invitation' then
  select * into v_student from academy.students where tenant_id=t and id=(p_payload->>'studentId')::uuid for update;
  v_email:=lower(trim(p_payload->>'email'));
  if v_student.id is null or v_student.status not in ('active','graduated') or v_email is distinct from lower(trim(v_student.email)) or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'training_student_email_mismatch';end if;
  v_expiry:=coalesce(nullif(p_payload->>'expiresAt','')::timestamptz,now()+interval '7 days');
  if v_expiry not between now()+interval '5 minutes' and now()+interval '7 days' then raise exception 'training_invitation_expiry_invalid';end if;
  if exists(select 1 from academy.training_learner_accounts where tenant_id=t and student_id=v_student.id) then raise exception 'training_student_already_linked';end if;
  update academy.training_invitations set status='revoked' where tenant_id=t and student_id=v_student.id and status='pending';
  insert into academy.training_invitations(tenant_id,student_id,email,token_hash,expires_at,invited_by_subject_id) values(t,v_student.id,v_email,p_payload->>'tokenHash',v_expiry,s) returning id into v_id;
  perform private_app.training_learning_event_v1(t,null,'invitation_created',jsonb_build_object('id',v_id,'studentId',v_student.id));
  v_response:=jsonb_build_object('invitationId',v_id,'expiresAt',v_expiry);
 elsif p_action='accept_invitation' then
  if inv.status<>'pending' then raise exception 'training_invitation_already_used';end if;
  insert into academy.training_learner_accounts(tenant_id,student_id,subject_id) values(t,inv.student_id,s);
  update academy.training_invitations set status='accepted',accepted_by_subject_id=s,accepted_at=now(),activation_claim_id=null,activation_claim_expires_at=null where id=inv.id;
  perform private_app.training_learning_event_v1(t,null,'learner_bound',jsonb_build_object('studentId',inv.student_id));
  v_response:=jsonb_build_object('studentId',inv.student_id,'tenantSlug',p_tenant_slug);
 elsif p_action='open_unit' then
  insert into academy.training_unit_progress(tenant_id,enrollment_id,version_id,unit_id) values(t,e.id,u.version_id,u.id) on conflict(tenant_id,enrollment_id,unit_id) do update set last_opened_at=now();
  perform private_app.training_learning_event_v1(t,e.id,'unit_opened',jsonb_build_object('unitId',u.id));
  v_response:=jsonb_build_object('unit',jsonb_build_object('id',u.id,'title',u.title,'kind',u.kind,'body',u.body,'url',u.url,'minimumSeconds',u.minimum_seconds,'maxAttempts',u.max_attempts,'passPercent',u.pass_percent,'questions',coalesce((select jsonb_agg(jsonb_build_object('id',q->>'id','prompt',q->>'prompt','options',q->'options')) from jsonb_array_elements(u.questions)q),'[]'::jsonb)));
 elsif p_action in ('complete_unit','submit_quiz','submit_assignment') then
  if not exists(select 1 from academy.training_unit_progress where tenant_id=t and enrollment_id=e.id and unit_id=u.id and opened_at<=now()-make_interval(secs=>u.minimum_seconds)) then raise exception 'training_unit_review_required';end if;
  if p_action='complete_unit' then
   if u.kind not in ('text','video','link') then raise exception 'training_unit_requires_assessment';end if;
   update academy.training_unit_progress set completed_at=coalesce(completed_at,now()),completed_by_subject_id=s where tenant_id=t and enrollment_id=e.id and unit_id=u.id;
   perform private_app.training_learning_event_v1(t,e.id,'unit_completed',jsonb_build_object('unitId',u.id,'evidenceType','learner_acknowledgement','minimumSeconds',u.minimum_seconds));
   v_response:=jsonb_build_object('unitId',u.id,'completed',true);
  elsif p_action='submit_quiz' then
   if u.kind<>'quiz' or jsonb_typeof(p_payload->'answers') is distinct from 'object' then raise exception 'training_quiz_answers_invalid';end if;
   select count(*)+1 into v_num from academy.training_quiz_attempts where tenant_id=t and enrollment_id=e.id and unit_id=u.id;
   if v_num>u.max_attempts then raise exception 'training_attempts_exhausted';end if;
   v_correct:=0;v_n:=jsonb_array_length(u.questions);
   if (select count(*) from jsonb_object_keys(p_payload->'answers'))<>v_n then raise exception 'training_quiz_answers_invalid';end if;
   for v_q in select value from jsonb_array_elements(u.questions) loop
    if not(p_payload->'answers' ? (v_q->>'id')) or jsonb_typeof(p_payload->'answers'->(v_q->>'id'))<>'number' or (p_payload->'answers'->>(v_q->>'id')) !~ '^[0-9]+$' then raise exception 'training_quiz_answers_invalid';end if;
    v_i:=(p_payload->'answers'->>(v_q->>'id'))::int;
    if v_i not between 0 and jsonb_array_length(v_q->'options')-1 then raise exception 'training_quiz_answers_invalid';end if;
    if v_i=(v_q->>'correctOptionIndex')::int then v_correct:=v_correct+1;end if;
   end loop;
   v_score:=round(v_correct*100.0/v_n,2);v_passed:=v_score>=u.pass_percent;
   insert into academy.training_quiz_attempts(tenant_id,enrollment_id,version_id,unit_id,attempt,answers,score,passed,submitted_by_subject_id) values(t,e.id,u.version_id,u.id,v_num,p_payload->'answers',v_score,v_passed,s);
   if v_passed then update academy.training_unit_progress set completed_at=coalesce(completed_at,now()),completed_by_subject_id=s where tenant_id=t and enrollment_id=e.id and unit_id=u.id;end if;
   perform private_app.training_reconcile_assessment_v1(t,e.id);
   perform private_app.training_learning_event_v1(t,e.id,'quiz_submitted',jsonb_build_object('unitId',u.id,'score',v_score,'passed',v_passed,'attempt',v_num));
   v_response:=jsonb_build_object('score',v_score,'passed',v_passed,'attempt',v_num);
  else
   if u.kind<>'assignment' then raise exception 'training_assignment_required';end if;
   if exists(select 1 from academy.certificates where tenant_id=t and enrollment_id=e.id and status='issued') then raise exception 'training_certificate_already_issued';end if;
   select count(*)+1 into v_num from academy.training_submissions where tenant_id=t and enrollment_id=e.id and unit_id=u.id;
   if v_num>u.max_attempts then raise exception 'training_attempts_exhausted';end if;
   insert into academy.training_submissions(tenant_id,enrollment_id,version_id,unit_id,attempt,body,submitted_by_subject_id) values(t,e.id,u.version_id,u.id,v_num,trim(p_payload->>'body'),s) returning id into v_id;
   update academy.training_unit_progress set completed_at=null,completed_by_subject_id=null where tenant_id=t and enrollment_id=e.id and unit_id=u.id;
   perform private_app.training_learning_event_v1(t,e.id,'assignment_submitted',jsonb_build_object('submissionId',v_id,'unitId',u.id));
   v_response:=jsonb_build_object('submissionId',v_id);
  end if;
 elsif p_action='grade_assignment' then
  if exists(select 1 from academy.certificates where tenant_id=t and enrollment_id=e.id and status='issued') then raise exception 'training_certificate_already_issued';end if;
  if exists(select 1 from academy.training_submissions where tenant_id=t and enrollment_id=e.id and unit_id=sub.unit_id and attempt>sub.attempt) then raise exception 'training_latest_submission_required';end if;
  select * into u from academy.training_units where tenant_id=t and id=sub.unit_id;
  v_score:=(p_payload->>'score')::numeric;
  insert into academy.training_grades(tenant_id,submission_id,score,feedback,graded_by_subject_id) values(t,sub.id,v_score,trim(p_payload->>'feedback'),s) returning id into v_id;
  update academy.training_unit_progress set completed_at=case when v_score>=u.pass_percent then now() end,completed_by_subject_id=case when v_score>=u.pass_percent then s end where tenant_id=t and enrollment_id=e.id and unit_id=u.id;
  perform private_app.training_reconcile_assessment_v1(t,e.id);
  perform private_app.training_learning_event_v1(t,e.id,'assignment_graded',jsonb_build_object('gradeId',v_id,'submissionId',sub.id,'score',v_score));
  v_response:=jsonb_build_object('gradeId',v_id,'score',v_score,'passed',v_score>=u.pass_percent);
 elsif p_action='create_request' then
  if p_payload->>'kind' not in ('transfer','defer','resume','withdraw') then raise exception 'training_request_kind_invalid';end if;
  v_response:=private_app.training_journey_request_v1(t,e.id,p_payload->>'kind',p_payload->>'reason',nullif(p_payload->>'targetRunId','')::uuid);
 elsif p_action='record_attendance' then
  if exists(select 1 from academy.certificates where tenant_id=t and enrollment_id=e.id and status='issued') then raise exception 'training_certificate_already_issued';end if;
  if not exists(select 1 from academy.course_run_sessions where tenant_id=t and course_run_id=e.course_run_id and id=(p_payload->>'sessionId')::uuid and status<>'cancelled') then raise exception 'training_session_not_found';end if;
  if length(trim(coalesce(p_payload->>'reason',''))) not between 3 and 2000 then raise exception 'training_attendance_reason_required';end if;
  select to_jsonb(a) into v_before from academy.attendance_records a where tenant_id=t and enrollment_id=e.id and session_id=(p_payload->>'sessionId')::uuid;
  insert into academy.attendance_records(tenant_id,course_run_id,session_id,enrollment_id,status,minutes_late,notes,marked_by_subject_id,metadata) values(t,e.course_run_id,(p_payload->>'sessionId')::uuid,e.id,p_payload->>'status',coalesce((p_payload->>'minutesLate')::int,0),p_payload->>'reason',s,jsonb_build_object('source','training_journey_manual')) on conflict(enrollment_id,session_id) do update set status=excluded.status,minutes_late=excluded.minutes_late,notes=excluded.notes,marked_by_subject_id=s,marked_at=now();
  perform private_app.training_learning_event_v1(t,e.id,'attendance_recorded',jsonb_build_object('sessionId',p_payload->>'sessionId','before',v_before,'status',p_payload->>'status','reason',p_payload->>'reason'));
  v_response:=jsonb_build_object('recorded',true);
 elsif p_action='issue_certificate' then
  select * into e from academy.enrollments where tenant_id=t and id=(p_payload->>'enrollmentId')::uuid for update;
  if e.id is null then raise exception 'training_enrollment_not_found';end if;
  v_eligibility:=private_app.training_learning_eligibility_v1(e.id);
  if v_eligibility is null or not coalesce((v_eligibility->>'eligible')::boolean,false) then raise exception 'training_certificate_not_eligible';end if;
  select id into v_id from academy.certificates where tenant_id=t and enrollment_id=e.id;
  if v_id is not null then raise exception 'training_certificate_already_exists';end if;
  v_id:=gen_random_uuid();
  insert into academy.certificates(id,tenant_id,course_run_id,enrollment_id,certificate_number,verification_code,issued_by_subject_id,metadata) values(v_id,t,e.course_run_id,e.id,'TR-'||upper(replace(v_id::text,'-','')),replace(gen_random_uuid()::text,'-',''),s,jsonb_build_object('trainingJourneyEvidence',v_eligibility-'financialAccess'));
  update academy.enrollments set status='completed' where tenant_id=t and id=e.id;
  perform private_app.training_learning_event_v1(t,e.id,'certificate_issued',jsonb_build_object('certificateId',v_id,'versionId',v_eligibility->>'versionId'));
  v_response:=jsonb_build_object('certificateId',v_id);
 end if;
 return private_app.training_journey_complete_command_v1(t,p_command_id,v_response);
end $$;

create function private_app.training_learning_owns_enrollment_v1(p_tenant_id uuid,p_enrollment_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select private_app.training_is_learner_v1(p_tenant_id,p_enrollment_id)
$$;
create function private_app.training_financial_projection_v1(p_tenant_id uuid,p_enrollment_id uuid,p_role text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare f jsonb;sponsored boolean;begin
 f:=private_app.training_journey_financial_access_v1(p_enrollment_id);
 select coalesce(l.sponsor,false) into sponsored from academy.enrollments e left join academy.training_financial_links l on l.tenant_id=e.tenant_id and l.handoff_id=e.handoff_id where e.tenant_id=p_tenant_id and e.id=p_enrollment_id;
 if (p_role='manager' and private_app.has_accounting_permission(p_tenant_id,'tenant.accounting.read')) or (p_role='learner' and not coalesce(sponsored,false) and private_app.training_is_learner_v1(p_tenant_id,p_enrollment_id)) then return f;end if;
 return jsonb_build_object('trainingAllowed',f->'trainingAllowed','certificationAllowed',f->'certificationAllowed','financialStatus',f->'financialStatus','reasonCodes',f->'reasonCodes','graceEndsOn',f->'graceEndsOn');
end $$;

create function public.v1_training_learning_snapshot(p_tenant_slug text,p_role text default 'learner',p_enrollment_id uuid default null,p_course_id uuid default null,p_offset integer default 0) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid;s uuid;v_courses jsonb;v_enrollments jsonb;v_submissions jsonb;v_instructors jsonb:='[]';v_candidates jsonb:='[]';v_requests jsonb:='[]';v_available_runs jsonb:='[]';v_total int;v_course_total int;
begin
 t:=private_app.training_journey_tenant_v1(p_tenant_slug);s:=private_app.current_subject_id();
 if s is null or p_role not in ('learner','manager','instructor') or p_offset not between 0 and 100000 then raise exception 'training_permission_denied';end if;
 if p_role='manager' and not private_app.has_tenant_permission(t,'tenant.academy.write') then raise exception 'training_permission_denied';end if;
 if p_role='learner' and not exists(select 1 from academy.training_learner_accounts a where a.tenant_id=t and a.subject_id=s and a.status='active') then raise exception 'training_learner_binding_required';end if;
 if p_role='instructor' and not exists(select 1 from academy.training_run_instructors i where i.tenant_id=t and i.subject_id=s and i.active and private_app.training_is_instructor_v1(t,i.run_id)) then raise exception 'training_instructor_assignment_required';end if;
 if p_enrollment_id is not null and not exists(select 1 from academy.enrollments e where e.tenant_id=t and e.id=p_enrollment_id and (p_role='manager' or (p_role='instructor' and private_app.training_is_instructor_v1(t,e.course_run_id)) or (p_role='learner' and private_app.training_is_learner_v1(t,e.id)))) then raise exception 'training_permission_denied';end if;
 select coalesce(jsonb_agg(x.row),'[]') into v_courses from (
 select jsonb_build_object('id',c.id,'title',c.title_ar,'status',c.status,'versions',coalesce((
  select jsonb_agg(vr.row order by vr.version desc) from (
   select v.version,jsonb_build_object('id',v.id,'version',v.version,'title',v.title,'status',v.status,'learningMode',v.learning_mode,'policy',v.policy,'publishedAt',v.published_at,'units',coalesce((
    select jsonb_agg(jsonb_build_object('id',u.id,'position',u.position,'title',u.title,'kind',u.kind,'required',u.required,'minimumSeconds',u.minimum_seconds,'maxAttempts',u.max_attempts,'passPercent',u.pass_percent)||case when p_role='manager' then jsonb_build_object('body',u.body,'url',u.url,'questions',u.questions) else '{}'::jsonb end order by u.position) from academy.training_units u where u.tenant_id=t and u.version_id=v.id and p_role='manager' and p_course_id=c.id and v.version=(select max(latest.version) from academy.training_course_versions latest where latest.tenant_id=t and latest.course_id=c.id)
   ),'[]')) row from academy.training_course_versions v where v.tenant_id=t and v.course_id=c.id and (p_role='manager' or (v.status='published' and exists(select 1 from academy.training_enrollment_versions ev join academy.enrollments e on e.tenant_id=ev.tenant_id and e.id=ev.enrollment_id where ev.tenant_id=t and ev.version_id=v.id and ((p_role='instructor' and private_app.training_is_instructor_v1(t,e.course_run_id)) or (p_role='learner' and private_app.training_is_learner_v1(t,e.id)))))) order by v.version desc limit 10
  ) vr
 ),'[]')) row from academy.courses c where c.tenant_id=t and (p_course_id is null or c.id=p_course_id) and (p_role='manager' or exists(select 1 from academy.enrollments e where e.tenant_id=t and e.course_id=c.id and ((p_role='instructor' and private_app.training_is_instructor_v1(t,e.course_run_id)) or (p_role='learner' and private_app.training_is_learner_v1(t,e.id))))) order by c.title_ar,c.id limit 50 offset p_offset
 ) x;
 select count(*) into v_course_total from academy.courses c where c.tenant_id=t and (p_course_id is null or c.id=p_course_id) and (p_role='manager' or exists(select 1 from academy.enrollments e where e.tenant_id=t and e.course_id=c.id and ((p_role='instructor' and private_app.training_is_instructor_v1(t,e.course_run_id)) or (p_role='learner' and private_app.training_is_learner_v1(t,e.id)))));
 select count(*) into v_total from academy.enrollments e where e.tenant_id=t and (p_enrollment_id is null or e.id=p_enrollment_id) and (p_course_id is null or e.course_id=p_course_id) and (p_role='manager' or (p_role='instructor' and private_app.training_is_instructor_v1(t,e.course_run_id)) or (p_role='learner' and private_app.training_is_learner_v1(t,e.id)));
 select coalesce(jsonb_agg(x.row),'[]') into v_enrollments from (
 select jsonb_build_object('id',e.id,'studentId',e.student_id,'studentName',st.full_name,'studentEmail',st.email,'courseId',e.course_id,'courseTitle',coalesce(v.title,c.title_ar),'runId',e.course_run_id,'runTitle',coalesce(r.title,r.run_code),'status',e.status,'deferred',coalesce((e.metadata->>'trainingJourneyDeferred')::boolean,false),'versionId',ev.version_id,'policy',v.policy,'learningMode',v.learning_mode,'financialAccess',f.access,'eligibility',case when ev.version_id is not null then private_app.training_learning_eligibility_v1(e.id)||jsonb_build_object('financialAccess',f.access) end,
 'progress',(select jsonb_build_object('completedUnits',count(*) filter(where p.completed_at is not null),'totalUnits',count(*),'percent',case when count(*)=0 then 0 else round(100.0*count(*) filter(where p.completed_at is not null)/count(*),0) end) from academy.training_units u left join academy.training_unit_progress p on p.tenant_id=t and p.enrollment_id=e.id and p.unit_id=u.id where u.tenant_id=t and u.version_id=ev.version_id and u.required),
 'units',coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'title',u.title,'kind',u.kind,'position',u.position,'required',u.required,'minimumSeconds',u.minimum_seconds,'maxAttempts',u.max_attempts,'passPercent',u.pass_percent,'completedAt',p.completed_at,'score',case when u.kind='quiz' then (select max(a.score) from academy.training_quiz_attempts a where a.tenant_id=t and a.enrollment_id=e.id and a.unit_id=u.id) else (select g.score from academy.training_submissions sub join academy.training_grades g on g.tenant_id=t and g.submission_id=sub.id where sub.tenant_id=t and sub.enrollment_id=e.id and sub.unit_id=u.id order by sub.attempt desc,g.graded_at desc,g.id desc limit 1) end,'attemptCount',case when u.kind='quiz' then (select count(*) from academy.training_quiz_attempts a where a.tenant_id=t and a.enrollment_id=e.id and a.unit_id=u.id) when u.kind='assignment' then (select count(*) from academy.training_submissions sub where sub.tenant_id=t and sub.enrollment_id=e.id and sub.unit_id=u.id) else 0 end) order by u.position) from academy.training_units u left join academy.training_unit_progress p on p.tenant_id=t and p.enrollment_id=e.id and p.unit_id=u.id where u.tenant_id=t and u.version_id=ev.version_id),'[]'),
 'sessions',coalesce((select jsonb_agg(sx.row order by sx.starts_at) from (select sess.starts_at,jsonb_build_object('id',sess.id,'title',sess.title,'startsAt',sess.starts_at,'endsAt',sess.ends_at,'status',sess.status,'joinUrl',case when p_role<>'learner' or coalesce((f.access->>'trainingAllowed')::boolean,false) then coalesce(sess.meeting_join_url,sess.venue_or_link) end,'attendance',(select ar.status from academy.attendance_records ar where ar.tenant_id=t and ar.enrollment_id=e.id and ar.session_id=sess.id)) row from academy.course_run_sessions sess where sess.tenant_id=t and sess.course_run_id=e.course_run_id order by sess.starts_at limit 100) sx),'[]'),
 'certificate',(select jsonb_build_object('id',cert.id,'number',cert.certificate_number,'verificationCode',cert.verification_code,'status',cert.status,'issuedAt',cert.issued_at) from academy.certificates cert where cert.tenant_id=t and cert.enrollment_id=e.id),
 'learnerLinked',exists(select 1 from academy.training_learner_accounts la where la.tenant_id=t and la.student_id=e.student_id and la.status='active')) row
 from academy.enrollments e join academy.students st on st.tenant_id=t and st.id=e.student_id join academy.courses c on c.tenant_id=t and c.id=e.course_id join academy.course_runs r on r.tenant_id=t and r.id=e.course_run_id left join academy.training_enrollment_versions ev on ev.tenant_id=t and ev.enrollment_id=e.id left join academy.training_course_versions v on v.tenant_id=t and v.id=ev.version_id cross join lateral(select private_app.training_financial_projection_v1(t,e.id,p_role) access)f
 where e.tenant_id=t and (p_enrollment_id is null or e.id=p_enrollment_id) and (p_course_id is null or e.course_id=p_course_id) and (p_role='manager' or (p_role='instructor' and private_app.training_is_instructor_v1(t,e.course_run_id)) or (p_role='learner' and private_app.training_is_learner_v1(t,e.id))) order by e.enrolled_at desc,e.id limit 50 offset p_offset
 ) x;
 select coalesce(jsonb_agg(x.row),'[]') into v_submissions from (
 select jsonb_build_object('id',sub.id,'enrollmentId',sub.enrollment_id,'studentName',st.full_name,'unitId',sub.unit_id,'unitTitle',u.title,'body',sub.body,'attempt',sub.attempt,'submittedAt',sub.submitted_at,'grade',(select jsonb_build_object('score',g.score,'feedback',g.feedback,'gradedAt',g.graded_at) from academy.training_grades g where g.tenant_id=t and g.submission_id=sub.id order by g.graded_at desc,g.id desc limit 1)) row from academy.training_submissions sub join academy.enrollments e on e.tenant_id=t and e.id=sub.enrollment_id join academy.students st on st.tenant_id=t and st.id=e.student_id join academy.training_units u on u.tenant_id=t and u.id=sub.unit_id where sub.tenant_id=t and (p_enrollment_id is null or e.id=p_enrollment_id) and (p_course_id is null or e.course_id=p_course_id) and (p_role='manager' or (p_role='instructor' and private_app.training_is_instructor_v1(t,e.course_run_id)) or (p_role='learner' and private_app.training_is_learner_v1(t,e.id))) order by sub.submitted_at desc,sub.id limit 100
 )x;
 if p_role in ('manager','instructor') then
  select coalesce(jsonb_agg(x.row),'[]') into v_instructors from (select jsonb_build_object('runId',i.run_id,'subjectId',i.subject_id,'name',a.full_name,'active',i.active) row from academy.training_run_instructors i join access_control.subjects a on a.id=i.subject_id where i.tenant_id=t and (p_role='manager' or i.subject_id=s) order by i.assigned_at desc limit 100)x;
 end if;
 if p_role='manager' then
  select coalesce(jsonb_agg(x.row),'[]') into v_candidates from (select distinct jsonb_build_object('subjectId',a.id,'name',a.full_name) row from access_control.subjects a join access_control.memberships m on m.subject_id=a.id and m.tenant_id=t and m.status='active' and m.scope='tenant' where a.status='active' limit 100)x;
 end if;
 if p_role='learner' then
  select coalesce(jsonb_agg(x.row),'[]') into v_available_runs from (select jsonb_build_object('id',r.id,'courseId',r.course_id,'title',coalesce(r.title,r.run_code),'status',r.status,'startsAt',r.starts_at,'endsAt',r.ends_at) row from academy.course_runs r where r.tenant_id=t and r.status='open' and coalesce(r.metadata->>'hiddenDeliveryRun','false')<>'true' and exists(select 1 from academy.enrollments e where e.tenant_id=t and e.course_id=r.course_id and private_app.training_is_learner_v1(t,e.id)) order by r.starts_at nulls last,r.id limit 100)x;
 end if;
 select coalesce(jsonb_agg(x.row),'[]') into v_requests from (select jsonb_build_object('id',req.id,'enrollmentId',req.enrollment_id,'kind',req.kind,'status',req.status,'reason',req.reason,'dueAt',req.due_at,'decisionReason',req.decision_reason) row from academy.training_journey_requests req join academy.enrollments e on e.tenant_id=t and e.id=req.enrollment_id where req.tenant_id=t and (p_enrollment_id is null or e.id=p_enrollment_id) and (p_role='manager' or (p_role='learner' and private_app.training_is_learner_v1(t,e.id))) order by req.created_at desc limit 100)x;
 return jsonb_build_object('role',p_role,'courses',v_courses,'enrollments',v_enrollments,'submissions',v_submissions,'instructors',v_instructors,'instructorCandidates',v_candidates,'requests',v_requests,'availableRuns',v_available_runs,'pagination',jsonb_build_object('offset',p_offset,'limit',50,'total',greatest(v_total,v_course_total),'enrollmentTotal',v_total,'courseTotal',v_course_total,'hasMore',p_offset+50<greatest(v_total,v_course_total)));
end $$;

-- Server-only activation claim. The raw invitation token/password never enter SQL.
create function public.v1_training_invitation_activation(p_token_hash text,p_claim_id uuid,p_action text default 'claim') returns jsonb language plpgsql security definer set search_path='' as $$
declare inv academy.training_invitations%rowtype;v_name text;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'training_service_role_required';end if;
 if p_claim_id is null or p_action not in ('claim','release') then raise exception 'training_activation_claim_invalid';end if;
 select * into inv from academy.training_invitations where token_hash=p_token_hash for update;
 if inv.id is null or inv.status<>'pending' or inv.expires_at<=now() or inv.tenant_id<>'3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid then raise exception 'training_invitation_invalid';end if;
 if not exists(select 1 from core.tenants t join academy.training_journey_settings c on c.tenant_id=t.id and c.enabled where t.id=inv.tenant_id and t.slug='marktone' and t.status in ('active','trial')) or not private_app.tenant_addon_enabled(inv.tenant_id,'lms') then raise exception 'training_journey_disabled';end if;
 if not exists(select 1 from academy.students st where st.tenant_id=inv.tenant_id and st.id=inv.student_id and st.status in ('active','graduated') and lower(trim(st.email))=inv.email) then raise exception 'training_invitation_invalid';end if;
 if p_action='release' then
  if inv.activation_claim_id is distinct from p_claim_id then raise exception 'training_activation_claim_invalid';end if;
  update academy.training_invitations set activation_claim_id=null,activation_claim_expires_at=null where id=inv.id;
  return jsonb_build_object('released',true);
 end if;
 if inv.activation_claim_id is not null and inv.activation_claim_expires_at>now() then raise exception 'training_activation_in_progress';end if;
 update academy.training_invitations set activation_claim_id=p_claim_id,activation_claim_expires_at=least(now()+interval '10 minutes',expires_at) where id=inv.id;
 select full_name into v_name from academy.students where tenant_id=inv.tenant_id and id=inv.student_id;
 return jsonb_build_object('email',inv.email,'fullName',v_name,'tenantSlug','marktone','expiresAt',inv.expires_at);
end $$;

create function private_app.training_learning_pin_latest_v1(p_tenant_id uuid,p_enrollment_id uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare e academy.enrollments%rowtype;v_version uuid;begin
 select * into e from academy.enrollments where tenant_id=p_tenant_id and id=p_enrollment_id for update;
 if e.id is null or not(private_app.has_tenant_permission(p_tenant_id,'tenant.admissions.write') or private_app.has_tenant_permission(p_tenant_id,'tenant.academy.write')) then raise exception 'training_permission_denied';end if;
 select version_id into v_version from academy.training_enrollment_versions where tenant_id=p_tenant_id and enrollment_id=e.id;
 if v_version is not null then return v_version;end if;
 select cv.id into v_version from academy.training_course_versions cv where cv.tenant_id=p_tenant_id and cv.course_id=e.course_id and cv.status='published' and (cv.learning_mode='self_paced' or not exists(select 1 from academy.course_runs r where r.tenant_id=p_tenant_id and r.id=e.course_run_id and r.metadata->>'trainingJourneySelfpaced'='true')) order by cv.version desc limit 1;
 if v_version is not null then
  insert into academy.training_enrollment_versions(tenant_id,enrollment_id,version_id,assigned_by_subject_id) values(p_tenant_id,e.id,v_version,private_app.current_subject_id());
  perform private_app.training_learning_event_v1(p_tenant_id,e.id,'version_assigned',jsonb_build_object('versionId',v_version,'source','admission_confirmation'));
 end if;
 return v_version;
end $$;

-- Transfer equivalence is intentionally exact: same canonical student, course and
-- immutable version. Evidence is copied with its original actor/time, plus lineage.
create function private_app.training_learning_transfer_v1(p_old_enrollment_id uuid,p_new_enrollment_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare old_e academy.enrollments%rowtype;new_e academy.enrollments%rowtype;v_version uuid;sub academy.training_submissions%rowtype;new_sub uuid;
begin
 select * into old_e from academy.enrollments where id=p_old_enrollment_id;
 select * into new_e from academy.enrollments where id=p_new_enrollment_id;
 if old_e.id is null or new_e.id is null or old_e.tenant_id<>new_e.tenant_id or old_e.student_id<>new_e.student_id or not private_app.has_tenant_permission(old_e.tenant_id,'tenant.academy.write') then raise exception 'training_transfer_not_authorized';end if;
 if old_e.course_id<>new_e.course_id then return;end if;
 select version_id into v_version from academy.training_enrollment_versions where tenant_id=old_e.tenant_id and enrollment_id=old_e.id;
 if v_version is null then return;end if;
 if exists(select 1 from academy.training_enrollment_versions where tenant_id=new_e.tenant_id and enrollment_id=new_e.id) then raise exception 'training_transfer_target_already_bound';end if;
 insert into academy.training_enrollment_versions(tenant_id,enrollment_id,version_id,assigned_by_subject_id) values(new_e.tenant_id,new_e.id,v_version,private_app.current_subject_id());
 insert into academy.training_unit_progress(tenant_id,enrollment_id,version_id,unit_id,opened_at,last_opened_at,completed_at,completed_by_subject_id) select tenant_id,new_e.id,version_id,unit_id,opened_at,last_opened_at,completed_at,completed_by_subject_id from academy.training_unit_progress where tenant_id=old_e.tenant_id and enrollment_id=old_e.id;
 insert into academy.training_quiz_attempts(tenant_id,enrollment_id,version_id,unit_id,attempt,answers,score,passed,submitted_by_subject_id,submitted_at) select tenant_id,new_e.id,version_id,unit_id,attempt,answers,score,passed,submitted_by_subject_id,submitted_at from academy.training_quiz_attempts where tenant_id=old_e.tenant_id and enrollment_id=old_e.id;
 for sub in select * from academy.training_submissions where tenant_id=old_e.tenant_id and enrollment_id=old_e.id order by unit_id,attempt loop
  insert into academy.training_submissions(tenant_id,enrollment_id,version_id,unit_id,attempt,body,submitted_by_subject_id,submitted_at) values(new_e.tenant_id,new_e.id,sub.version_id,sub.unit_id,sub.attempt,sub.body,sub.submitted_by_subject_id,sub.submitted_at) returning id into new_sub;
  insert into academy.training_grades(tenant_id,submission_id,score,feedback,graded_by_subject_id,graded_at) select tenant_id,new_sub,score,feedback,graded_by_subject_id,graded_at from academy.training_grades where tenant_id=old_e.tenant_id and submission_id=sub.id;
 end loop;
 perform private_app.training_reconcile_assessment_v1(new_e.tenant_id,new_e.id);
 perform private_app.training_learning_event_v1(new_e.tenant_id,new_e.id,'equivalent_progress_transferred',jsonb_build_object('sourceEnrollmentId',old_e.id,'versionId',v_version,'equivalence','same_course_and_version'));
end $$;

revoke all on function private_app.training_learning_pin_latest_v1(uuid,uuid),private_app.training_learning_owns_enrollment_v1(uuid,uuid),private_app.training_financial_projection_v1(uuid,uuid,text),private_app.training_version_immutable_v1(),private_app.training_unit_insert_guard_v1(),private_app.training_enrollment_version_guard_v1(),private_app.training_is_learner_v1(uuid,uuid),private_app.training_is_instructor_v1(uuid,uuid),private_app.training_learning_event_v1(uuid,uuid,text,jsonb),private_app.training_learning_eligibility_v1(uuid),private_app.training_eligibility_before_journey_v1(uuid),private_app.training_eligibility(uuid),private_app.training_certificate_guard_v1(),private_app.training_reconcile_assessment_v1(uuid,uuid),private_app.training_learning_transfer_v1(uuid,uuid) from public,anon,authenticated;
revoke all on function public.v1_training_learning_action(text,text,uuid,jsonb),public.v1_training_learning_snapshot(text,text,uuid,uuid,integer) from public,anon;
grant execute on function public.v1_training_learning_action(text,text,uuid,jsonb),public.v1_training_learning_snapshot(text,text,uuid,uuid,integer) to authenticated;
revoke all on function public.v1_training_invitation_activation(text,uuid,text) from public,anon,authenticated;
grant execute on function public.v1_training_invitation_activation(text,uuid,text) to service_role;
commit;
