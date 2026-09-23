begin;
create function zoom_core.source_certificate_review() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into work_core.tasks(tenant_id,task_key,title,description,priority,assigned_staff_id,due_at,metadata)
 select new.tenant_id,'zoom:certificate-source:'||c.id,'مراجعة شهادة بعد تحديث مصدر الحضور','تغيرت مدة أو جودة دليل زووم عن الحضور المعتمد لشهادة صادرة. راجع السبب والسياسة؛ الشهادة والقرار اليدوي محفوظان.','high',staff.id,now()+interval '1 day',jsonb_build_object('source','zoom_certificate_source_changed','certificateId',c.id,'enrollmentId',c.enrollment_id)
 from academy.certificates c join academy.attendance_records a on a.tenant_id=c.tenant_id and a.enrollment_id=c.enrollment_id and a.session_id=(select session_id from zoom_core.links where tenant_id=new.tenant_id and id=new.link_id)
 join zoom_core.settings cfg on cfg.tenant_id=c.tenant_id left join people.staff_profiles staff on staff.tenant_id=cfg.tenant_id and staff.id=cfg.owner_staff_id and staff.employment_status='active'
 cross join lateral(select zoom_core.attendance(new.tenant_id,new.link_id,c.enrollment_id) summary)x
 where c.tenant_id=new.tenant_id and c.status='issued' and (x.summary->>'attendedSeconds' is distinct from a.metadata->'zoom'->>'attendedSeconds' or x.summary->>'quality' is distinct from a.metadata->'zoom'->>'quality')
 on conflict(tenant_id,task_key) do nothing;return new;
end $$;
create trigger zoom_source_certificate_review after update of evidence_state on zoom_core.instances for each row execute function zoom_core.source_certificate_review();
create index zoom_recent_report_intervals on zoom_core.intervals(joined_at,tenant_id,enrollment_id) where source='report' and left_at is not null;
alter function public.v1_zoom_operational_tasks() rename to v1_zoom_operational_tasks_before_overlap;
create function public.v1_zoom_operational_tasks() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;n int;
begin
 perform zoom_core.service_only();result:=public.v1_zoom_operational_tasks_before_overlap();
 insert into work_core.tasks(tenant_id,task_key,title,description,priority,assigned_staff_id,due_at,metadata)
 select pairs.tenant_id,'zoom:learner-overlap:'||pairs.student_id||':'||pairs.first_link||':'||pairs.second_link,'مراجعة حضور متدرب في محاضرتين متداخلتين','ظهر تقاطع في فترات التعليم المعتمدة من أدلة نهائية لمحاضرتين. افحص الهوية والأدلة دون تعديل حضور أو استحقاق تلقائي.','normal',staff.id,now()+interval '1 day',jsonb_build_object('source','zoom_learner_overlap','studentId',pairs.student_id,'firstLink',pairs.first_link,'secondLink',pairs.second_link)
 from (
  select distinct e1.tenant_id,e1.student_id,i1.link_id first_link,i2.link_id second_link
  from zoom_core.intervals v1 join academy.enrollments e1 on e1.tenant_id=v1.tenant_id and e1.id=v1.enrollment_id
  join zoom_core.instances i1 on i1.tenant_id=v1.tenant_id and i1.id=v1.instance_id and i1.evidence_state='complete'
  join zoom_core.teaching_windows w1 on w1.tenant_id=i1.tenant_id and w1.link_id=i1.link_id
  join academy.enrollments e2 on e2.tenant_id=e1.tenant_id and e2.student_id=e1.student_id
  join zoom_core.intervals v2 on v2.tenant_id=e2.tenant_id and v2.enrollment_id=e2.id and v2.source='report' and v2.kind='meeting' and v2.quality in ('matched','manual') and v2.left_at>v2.joined_at
  join zoom_core.instances i2 on i2.tenant_id=v2.tenant_id and i2.id=v2.instance_id and i2.link_id>i1.link_id and i2.evidence_state='complete'
  join zoom_core.teaching_windows w2 on w2.tenant_id=i2.tenant_id and w2.link_id=i2.link_id
  where v1.source='report' and v1.kind='meeting' and v1.quality in ('matched','manual') and v1.left_at>v1.joined_at and v1.joined_at>now()-interval '7 days'
  and ((tstzmultirange(tstzrange(v1.joined_at,v1.left_at,'[)'))*tstzmultirange(w1.approved_range))-w1.breaks)&&((tstzmultirange(tstzrange(v2.joined_at,v2.left_at,'[)'))*tstzmultirange(w2.approved_range))-w2.breaks)
 )pairs join zoom_core.settings cfg on cfg.tenant_id=pairs.tenant_id and cfg.enabled left join people.staff_profiles staff on staff.tenant_id=cfg.tenant_id and staff.id=cfg.owner_staff_id and staff.employment_status='active'
 where not exists(select 1 from work_core.tasks task where task.tenant_id=pairs.tenant_id and task.task_key='zoom:learner-overlap:'||pairs.student_id||':'||pairs.first_link||':'||pairs.second_link) limit 100
 on conflict(tenant_id,task_key) do nothing;get diagnostics n=row_count;return result||jsonb_build_object('learnerOverlapTasks',n);
end $$;
revoke all on function zoom_core.source_certificate_review(),public.v1_zoom_operational_tasks_before_overlap(),public.v1_zoom_operational_tasks() from public,anon,authenticated,service_role;
grant execute on function public.v1_zoom_operational_tasks() to service_role;
commit;
