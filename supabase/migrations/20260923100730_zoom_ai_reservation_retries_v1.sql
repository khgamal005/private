begin;
-- Metadata only: source bytes inform the existing Odeiry reservation before any
-- provider call. The transcript still requires the current authorized run.
alter function public.v1_zoom_ai_prepare(text,uuid,jsonb) rename to v1_zoom_ai_prepare_before_source_budget;
revoke all on function public.v1_zoom_ai_prepare_before_source_budget(text,uuid,jsonb) from public,anon,authenticated,service_role;
create function public.v1_zoom_ai_prepare(p_slug text,p_command_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;source_bytes int;t uuid:=zoom_core.tenant(p_slug);
begin
 result:=public.v1_zoom_ai_prepare_before_source_budget(p_slug,p_command_id,p_payload);
 select octet_length(r.transcript) into source_bytes from zoom_core.ai_drafts d join zoom_core.recordings r on r.tenant_id=d.tenant_id and r.id=d.recording_id
 where d.tenant_id=t and d.id=(result->>'draftId')::uuid and r.transcript_revision=d.source_revision;
 if source_bytes is null or source_bytes not between 1 and 720000 then raise exception 'zoom_source_budget_unavailable';end if;
 return result||jsonb_build_object('sourceBytes',source_bytes);
end $$;

-- The original apply checked draft state before the canonical authoring command
-- receipt, so retrying a successful request failed after the draft was applied.
alter function public.v1_zoom_ai_apply(text,uuid,jsonb) rename to v1_zoom_ai_apply_before_command_receipt;
revoke all on function public.v1_zoom_ai_apply_before_command_receipt(text,uuid,jsonb) from public,anon,authenticated,service_role;
create function public.v1_zoom_ai_apply(p_slug text,p_command_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);v_result jsonb;
begin
 if not zoom_core.allowed(t,'ai.generate') or not private_app.academy_has_permission_v1(t,'manageLearning') or not private_app.academy_has_permission_v1(t,'manageCourses') then raise exception 'zoom_forbidden';end if;
 v_result:=zoom_core.command(t,p_command_id,'ai_apply',p_payload);if v_result is not null then return v_result;end if;
 v_result:=public.v1_zoom_ai_apply_before_command_receipt(p_slug,p_command_id,p_payload);
 update zoom_core.commands c set result=v_result where c.tenant_id=t and c.id=p_command_id;
 return v_result;
end $$;
revoke all on function public.v1_zoom_ai_prepare(text,uuid,jsonb),public.v1_zoom_ai_apply(text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v1_zoom_ai_prepare(text,uuid,jsonb),public.v1_zoom_ai_apply(text,uuid,jsonb) to authenticated;
commit;
