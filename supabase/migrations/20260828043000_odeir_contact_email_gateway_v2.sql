create or replace function public.v1_contact_submission_email_payload(p_reference text)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_row website.contact_submissions%rowtype;
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'') <> 'service_role' then raise exception 'unauthorized'; end if;
  select * into v_row from website.contact_submissions where reference_key=trim(coalesce(p_reference,'')) limit 1;
  if v_row.id is null then return null; end if;
  return jsonb_build_object('reference_key',v_row.reference_key,'name',v_row.name,'email',v_row.email,'phone',v_row.phone,'organization',v_row.organization,'message',v_row.message,'source_page',v_row.source_page,'created_at',v_row.created_at,'email_sent_at',v_row.email_sent_at);
end $$;
revoke all on function public.v1_contact_submission_email_payload(text) from public,anon,authenticated;
grant execute on function public.v1_contact_submission_email_payload(text) to service_role;

create or replace function public.v1_contact_submission_email_mark_sent(p_reference text,p_provider_id text)
returns boolean
language plpgsql
security definer
set search_path=''
as $$
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'') <> 'service_role' then raise exception 'unauthorized'; end if;
  update website.contact_submissions set email_sent_at=coalesce(email_sent_at,now()),email_provider_id=coalesce(email_provider_id,nullif(trim(coalesce(p_provider_id,'')),'')) where reference_key=trim(coalesce(p_reference,''));
  return found;
end $$;
revoke all on function public.v1_contact_submission_email_mark_sent(text,text) from public,anon,authenticated;
grant execute on function public.v1_contact_submission_email_mark_sent(text,text) to service_role;
