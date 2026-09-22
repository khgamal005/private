-- Publish stored content from the page list; site publication is explicit.
-- No tenant records are activated or published by this migration.
create function public.v3_cms_publication_action(
 p_site_key text,p_tenant_slug text,p_action text,p_payload jsonb default '{}'
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 s website.sites%rowtype; actor uuid; page website.pages%rowtype;
 doc website.content_documents%rowtype; result jsonb;
begin
 s:=private_app.cms_resolve_site(p_site_key,p_tenant_slug,'publish',false);
 actor:=private_app.cms_access_subject(s.id,'publish');
 if p_action='publish-site' then
  select * into s from website.sites where id=s.id for update;
  if s.status is distinct from p_payload->>'expectedStatus' then
   raise exception 'cms_publication_conflict';
  end if;
  select * into page from website.pages
   where site_id=s.id and is_home and status='published'
    and visibility in ('public','unlisted') for update;
  if page.id is null then raise exception 'cms_home_publish_required';end if;
  if not exists(select 1 from website.content_documents d
    where d.site_id=s.id and d.entity_type='page' and d.entity_id=page.id
     and d.published_document->>'schemaVersion'='1')
    and page.content->>'schemaVersion' is distinct from '1' then
   raise exception 'cms_home_publish_required';
  end if;
  update website.sites set status='published',published_at=coalesce(published_at,now()) where id=s.id;
  result:=jsonb_build_object('siteId',s.id,'status','published');
 elsif p_action='publish-saved-page' then
  select * into page from website.pages
   where site_id=s.id and id=(p_payload->>'id')::uuid and status<>'archived' for update;
  if page.id is null then raise exception 'cms_entity_not_found';end if;
  select * into doc from website.content_documents
   where site_id=s.id and entity_type='page' and entity_id=page.id for update;
  if doc.id is null then raise exception 'cms_saved_draft_required';end if;
  if nullif(p_payload->>'expectedDraftUpdatedAt','') is null
   or doc.draft_updated_at is distinct from (p_payload->>'expectedDraftUpdatedAt')::timestamptz then
   raise exception 'cms_publication_conflict';
  end if;
  result:=public.v3_cms_builder_action(p_site_key,p_tenant_slug,'page',page.id,'publish',
   jsonb_build_object('document',doc.draft_document));
 else raise exception 'cms_action_invalid';end if;
 perform private_app.write_audit('cms.'||replace(p_action,'-','.'),'cms',
  coalesce(page.id,s.id)::text,s.tenant_id,jsonb_build_object('siteId',s.id,'action',p_action));
 return jsonb_build_object('success',true,'result',result);
end $$;
revoke all on function public.v3_cms_publication_action(text,text,text,jsonb) from public,anon;
grant execute on function public.v3_cms_publication_action(text,text,text,jsonb) to authenticated;

-- The settings form must enforce the same publication permission as the new
-- explicit control. Preserve the existing function body and all other actions.
do $$
declare definition text; needle text := E'  if v_action=''save-site'' then\n';
begin
 definition:=pg_get_functiondef('public.v3_cms_action(text,text,text,jsonb)'::regprocedure);
 if position(needle in definition)=0 then raise exception 'cms_action_definition_drift';end if;
 definition:=replace(definition,needle,needle||E'    if v_payload ? ''status'' and v_payload->>''status'' is distinct from v_site.status and not v_publish_permission then\n      raise exception ''publish_forbidden'';\n    end if;\n');
 execute definition;
end $$;
