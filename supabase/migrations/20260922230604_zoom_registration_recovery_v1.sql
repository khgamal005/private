begin;
-- Reconcile a lost registration response by a scoped provider read. Absence or
-- partial pagination never authorizes another registration request.
create function public.v1_zoom_registration_recover(p_grant_id uuid,p_lease uuid,p_action text default 'claim') returns jsonb language plpgsql security definer set search_path='' as $$
declare g zoom_core.access_grants%rowtype;l zoom_core.links%rowtype;r zoom_core.registrations%rowtype;email_value text;
begin
 perform zoom_core.service_only();g:=zoom_core.check_grant(p_grant_id);if g.action<>'join' then raise exception 'zoom_forbidden';end if;
 select * into l from zoom_core.links where tenant_id=g.tenant_id and id=g.link_id;
 select * into r from zoom_core.registrations where tenant_id=g.tenant_id and link_id=l.id and enrollment_id=g.enrollment_id for update;
 if p_action='release' then
  update zoom_core.registrations set state='uncertain',lease=null,lease_until=null where id=r.id and state='registering' and lease=p_lease;
  return '{"status":"uncertain"}';
 end if;
 if p_action<>'claim' or r.id is null or r.state<>'uncertain' or p_lease is null then raise exception 'zoom_registration_pending';end if;
 select lower(u.email) into email_value from auth.users u join academy.students s on s.tenant_id=g.tenant_id and s.id=r.student_id where u.id=g.auth_user_id and u.email_confirmed_at is not null and lower(s.email)=lower(u.email);
 if email_value is null or email_value is distinct from r.verified_email then raise exception 'zoom_verified_email_required';end if;
 update zoom_core.registrations set state='registering',lease=p_lease,lease_until=now()+interval '45 seconds' where id=r.id;
 perform private_app.write_audit('zoom.registration.reconcile','zoom_registration',r.id::text,g.tenant_id,jsonb_build_object('source','provider_read'));
 return jsonb_build_object('status','recover','connectionId',l.connection_id,'meetingId',l.meeting_id,'kind',l.kind,'occurrenceId',l.occurrence_id,'email',email_value);
end $$;
revoke all on function public.v1_zoom_registration_recover(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.v1_zoom_registration_recover(uuid,uuid,text) to service_role;
commit;
