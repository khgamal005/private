begin;
-- Status is derived from the very same authority used by join/start. It is
-- advisory UI data only: every subsequent sensitive action checks again.
create function zoom_core.portal_access(t uuid,item jsonb,role_value text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare operation text:=case when role_value='instructor' then 'start' else 'join' end;code text;label_value text;
begin
 begin
  perform zoom_core.access_check(t,(item->>'linkId')::uuid,(item->>'enrollmentId')::uuid,operation);
  return jsonb_build_object('available',true,'state','available','label',case when operation='start' then 'بدء عبر زووم' else 'الانضمام عبر زووم' end);
 exception when others then
  code:=sqlerrm;
  if code !~ '^zoom_[a-z_]+$' then raise;end if;
 end;
 label_value:=case
 when code='zoom_outside_join_window' and now()<(item->>'startsAt')::timestamptz then 'لم يحن موعد الدخول'
 when code='zoom_outside_join_window' then 'انتهت المحاضرة'
 when code='zoom_not_entitled' then 'التسجيل غير مستحق للدخول حاليًا'
 when code='zoom_forbidden' and operation='start' then 'يحتاج تفويض المدرب إلى تحقق'
 when code='zoom_forbidden' then 'غير متاح لهذا التسجيل'
 when code='zoom_not_enabled' then 'الاتصال غير متاح حاليًا'
 when item->>'state'='cancelled' or item->>'academicStatus'='cancelled' then 'المحاضرة ملغاة'
 when item->>'state' in ('queued','updating') then 'جارٍ تجهيز الاجتماع'
 when item->>'state'='drift' then 'الموعد يحتاج مراجعة المسؤول'
 else 'الاجتماع غير جاهز للدخول' end;
 return jsonb_build_object('available',false,'state',code,'label',label_value);
end $$;
alter function public.v1_zoom_snapshot(text,text,jsonb) rename to v1_zoom_snapshot_before_portal_status;
create function public.v1_zoom_snapshot(p_slug text,p_view text default 'sessions',p_options jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;t uuid;items jsonb;
begin
 result:=public.v1_zoom_snapshot_before_portal_status(p_slug,p_view,p_options);
 if p_view not in ('learner','instructor') then return result;end if;
 t:=zoom_core.tenant(p_slug,false);
 select coalesce(jsonb_agg(item||jsonb_build_object('access',zoom_core.portal_access(t,item,p_view)) order by n),'[]') into items from jsonb_array_elements(result->'sessions') with ordinality x(item,n);
 return result||jsonb_build_object('sessions',items);
end $$;
alter function public.v1_zoom_sweep(integer) rename to v1_zoom_sweep_before_future;
create function public.v1_zoom_sweep(p_limit integer default 50) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;l zoom_core.links%rowtype;n int:=0;
begin
 perform zoom_core.service_only();result:=public.v1_zoom_sweep_before_future(p_limit);
 for l in select x.* from zoom_core.links x join zoom_core.settings cfg on cfg.tenant_id=x.tenant_id and cfg.enabled join zoom_core.connections c on c.tenant_id=x.tenant_id and c.id=x.connection_id and c.status in ('connected','paused')
 where x.meeting_id is not null and x.state in ('ready','imported','drift') and (x.desired->>'startsAt')::timestamptz between now() and now()+interval '72 hours'
 and private_app.tenant_addon_enabled(x.tenant_id,'addon.integration.zoom') and not exists(select 1 from zoom_core.operations o where o.tenant_id=x.tenant_id and o.link_id=x.id and (o.state in ('pending','retry','processing') or (o.payload->>'checkSchedule'='true' and o.created_at>now()-interval '12 hours')))
 order by x.last_synced_at nulls first,x.id limit p_limit for update of x skip locked loop
  insert into zoom_core.operations(tenant_id,connection_id,link_id,revision,kind,command_id,payload) values(l.tenant_id,l.connection_id,l.id,l.revision,'reconcile',gen_random_uuid(),'{"checkSchedule":true}');n:=n+1;
 end loop;
 return result||jsonb_build_object('futureChecksQueued',n);
end $$;
revoke all on function zoom_core.portal_access(uuid,jsonb,text),public.v1_zoom_snapshot_before_portal_status(text,text,jsonb),public.v1_zoom_snapshot(text,text,jsonb),public.v1_zoom_sweep_before_future(integer),public.v1_zoom_sweep(integer) from public,anon,authenticated,service_role;
grant execute on function public.v1_zoom_snapshot(text,text,jsonb) to authenticated;
grant execute on function public.v1_zoom_sweep(integer) to service_role;
commit;
