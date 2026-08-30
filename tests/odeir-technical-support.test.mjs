import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const migrationPath='supabase/migrations/20260829164239_odeir_technical_support_v1.sql';

const sourcePaths={
  migration:migrationPath,
  attachmentGateMigration:
    'supabase/migrations/20260829175001_support_attachment_scanner_fail_closed_v1.sql',
  supportIndexMigration:
    'supabase/migrations/20260829181000_odeir_support_fk_indexes_v1.sql',
  shell:'components/workspace-shell.js',
  desk:'components/odeir-support-desk.js',
  supportApi:'lib/support-api.js',
  generalApi:'lib/api.js',
  serverAuth:'lib/server-auth.js',
  loginDestination:'lib/login-destination.mjs',
  tenantLayout:'app/tenant/[slug]/layout.js',
  controlLayout:'app/control/layout.js',
  notificationCenter:'components/notification-center.js',
  tenantPage:'app/tenant/[slug]/support/page.js',
  platformPage:'app/control/support/page.js',
  sharedRoute:'app/api/support/_shared.js',
  tenantRoute:'app/api/support/tenant/[action]/route.js',
  platformRoute:'app/api/support/platform/[action]/route.js',
  attachmentTicketRoute:'app/api/support/attachments/route.js',
  attachmentFinalizeRoute:'app/api/support/attachments/finalize/route.js',
  attachmentDownloadRoute:'app/api/support/attachments/[attachmentId]/route.js',
  cleanupWorker:'supabase/functions/support-attachment-cleanup/index.ts',
  supabaseConfig:'supabase/config.toml'
};

let sourcesPromise;
function sources(){
  sourcesPromise??=Promise.all(Object.entries(sourcePaths).map(async([key,path])=>[
    key,
    await readFile(new URL(path,root),'utf8')
  ])).then(Object.fromEntries);
  return sourcesPromise;
}

function compact(value){
  return value
    .replace(/--[^\n]*/g,' ')
    .replace(/\s+/g,' ')
    .trim()
    .toLowerCase();
}

function escapeRegExp(value){
  return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
}

function routine(sql,name){
  const startPattern=new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${escapeRegExp(name)}\\s*\\(`,
    'i'
  );
  const start=sql.search(startPattern);
  assert.notEqual(start,-1,`${name} must exist`);
  const tail=sql.slice(start);
  const bodyMarker=/\bas\s+\$\$/i.exec(tail);
  assert.ok(bodyMarker,`${name} must have a dollar-quoted body`);
  const end=tail.indexOf('$$;',bodyMarker.index+bodyMarker[0].length);
  assert.notEqual(end,-1,`${name} must have a complete body`);
  return tail.slice(0,end+3);
}

function tableDefinition(sql,name){
  const pattern=new RegExp(`create\\s+table\\s+${escapeRegExp(name)}\\s*\\(`,'i');
  const start=sql.search(pattern);
  assert.notEqual(start,-1,`${name} must exist`);
  const end=sql.indexOf('\n);',start);
  assert.notEqual(end,-1,`${name} must have a complete definition`);
  return sql.slice(start,end+3);
}

function callsTo(source,qualifiedName){
  const calls=[];
  let cursor=0;
  while(true){
    const start=source.indexOf(qualifiedName,cursor);
    if(start<0)break;
    const open=source.indexOf('(',start+qualifiedName.length);
    if(open<0)break;
    let depth=0;
    let quoted=false;
    let end=-1;
    for(let index=open;index<source.length;index+=1){
      const character=source[index];
      if(character==="'"){
        if(quoted&&source[index+1]==="'"){
          index+=1;
          continue;
        }
        quoted=!quoted;
        continue;
      }
      if(quoted)continue;
      if(character==='(')depth+=1;
      if(character===')'){
        depth-=1;
        if(depth===0){end=index+1;break;}
      }
    }
    assert.notEqual(end,-1,`${qualifiedName} call must be balanced`);
    calls.push(source.slice(start,end));
    cursor=end;
  }
  return calls;
}

test('technical support schema is additive, tenant-scoped, and conversation based',async()=>{
  const {migration}=await sources();
  const normalized=compact(migration);
  assert.match(normalized,/^begin;/);
  assert.match(normalized,/commit;$/);

  for(const field of [
    'ticket_number','workflow_version','version','idempotency_key',
    'requester_staff_id','requester_job_title_snapshot','module_key','impact',
    'diagnostics','assigned_to_platform_subject_id','first_response_due_at',
    'resolution_due_at','waiting_total_seconds','reopen_count','last_message_at'
  ]){
    assert.match(normalized,new RegExp(`add column if not exists ${field}\\b`),`${field} is required`);
  }

  const messages=compact(tableDefinition(migration,'core.support_messages'));
  const events=compact(tableDefinition(migration,'core.support_events'));
  const attachments=compact(tableDefinition(migration,'core.support_attachments'));
  const readStates=compact(tableDefinition(migration,'core.support_read_states'));
  assert.match(messages,/foreign key \(tenant_id,ticket_id\) references core\.support_requests\(tenant_id,id\)/);
  assert.match(events,/foreign key \(tenant_id,ticket_id\) references core\.support_requests\(tenant_id,id\)/);
  assert.match(attachments,/foreign key \(tenant_id,ticket_id,message_id\) references core\.support_messages\(tenant_id,ticket_id,id\)/);
  assert.match(readStates,/primary key \(tenant_id,ticket_id,subject_id\)/);
  assert.match(readStates,/foreign key \(tenant_id,ticket_id\) references core\.support_requests\(tenant_id,id\)/);
  assert.doesNotMatch(events,/\bcontent\s+text\b|\bdescription\s+text\b/);

  for(const indexName of [
    'core_support_requests_tenant_activity_idx',
    'core_support_requests_requester_activity_idx',
    'core_support_messages_ticket_time_idx',
    'core_support_events_ticket_time_idx',
    'core_support_attachments_message_idx',
    'core_support_read_states_subject_idx'
  ])assert.match(normalized,new RegExp(`create (?:unique )?index(?: if not exists)? ${indexName}\\b`));
});

test('support FK indexes target the canonical ticket table on clean databases',async()=>{
  const {supportIndexMigration}=await sources();
  const normalized=compact(supportIndexMigration);
  assert.match(
    normalized,
    /on core\.support_requests\(requested_by_subject_id\)/
  );
  assert.doesNotMatch(
    normalized,
    /on platform\.support_requests\(/,
    'a non-existent platform ticket table would abort the migration transaction'
  );
});

test('every active tenant member can create, while reads remain own-ticket by default',async()=>{
  const {migration}=await sources();
  const member=compact(routine(migration,'private_app.support_is_active_tenant_member'));
  assert.match(member,/membership\.scope='tenant'/);
  assert.match(member,/membership\.status='active'/);
  assert.match(member,/membership\.tenant_id=p_tenant_id/);
  assert.match(member,/subject\.status='active'/);
  assert.doesNotMatch(member,/role_key|role_permissions|permission_key|job_title/);

  const tenantAction=compact(routine(migration,'public.v3_tenant_support_action'));
  assert.match(tenantAction,/not private_app\.support_is_active_tenant_member\(v_tenant\.id\)[^;]+raise exception 'forbidden'/);
  assert.match(tenantAction,/if v_action='create_ticket' then/);
  assert.doesNotMatch(tenantAction,/tenant\.support\.create/);

  const canRead=compact(routine(migration,'private_app.support_tenant_can_read_ticket'));
  assert.match(canRead,/private_app\.support_is_active_tenant_member\(p_tenant_id\)/);
  assert.match(canRead,/ticket\.requested_by_subject_id=private_app\.current_subject_id\(\)/);
  assert.match(canRead,/or private_app\.support_tenant_can_read_all\(p_tenant_id\)/);
  const canReadAll=compact(routine(migration,'private_app.support_tenant_can_read_all'));
  assert.match(canReadAll,/membership\.scope='tenant'/);
  assert.match(canReadAll,/membership\.status='active'/);
  assert.match(canReadAll,/membership\.tenant_id=p_tenant_id/);
  assert.match(canReadAll,/role\.scope='tenant'/);
  assert.match(canReadAll,/role_permission\.permission_key='tenant\.support\.read_all'/);
  assert.match(canReadAll,/subject\.auth_user_id=auth\.uid\(\)/);
  assert.doesNotMatch(
    canReadAll,
    /has_tenant_permission|platform\.control\.read|support_platform_can_read/,
    'a hybrid platform and tenant identity must earn read-all from its tenant role only'
  );

  const snapshot=compact(routine(migration,'public.v3_tenant_support_snapshot'));
  assert.match(snapshot,/v_scope not in \('mine','all'\)/);
  assert.match(snapshot,/v_scope='all' and not v_can_read_all[^;]+raise exception 'forbidden'/);
  assert.match(snapshot,/v_scope='all' or ticket\.requested_by_subject_id=v_subject_id/);
});

test('Marktone support uses dedicated read, reply, and manage permissions',async()=>{
  const {migration,platformPage}=await sources();
  const normalized=compact(migration);
  for(const permission of [
    'platform.support.read','platform.support.reply','platform.support.manage'
  ])assert.match(normalized,new RegExp(`'${escapeRegExp(permission)}'`));
  for(const role of [
    'platform_support_agent','platform_support_manager',
    'platform_owner','platform_operations_manager'
  ])assert.match(normalized,new RegExp(`'${role}'`));

  assert.match(normalized,/role\.role_key='platform_support_agent' and permission\.permission_key in \( 'platform\.support\.read','platform\.support\.reply' \)/);
  assert.match(normalized,/role\.role_key in \( 'platform_support_manager','platform_owner', 'platform_operations_manager' \)[^;]+platform\.support\.manage/);

  const action=compact(routine(migration,'public.v3_platform_support_action'));
  assert.match(action,/private_app\.support_platform_can_read\(\)/);
  assert.match(action,/private_app\.support_platform_can_reply\(\)/);
  assert.match(action,/v_action='assign_ticket'[^;]+platform\.support\.manage/);
  assert.match(platformPage,/requireAnyPlatformPermission\(SUPPORT_PERMISSIONS\)/);
  assert.match(platformPage,/mode="platform"/);
});

test('RLS and v3 serializers keep internal notes out of every tenant view',async()=>{
  const {migration}=await sources();
  const normalized=compact(migration);
  for(const table of [
    'core.support_messages','core.support_events',
    'core.support_attachments','core.support_read_states'
  ]){
    assert.match(normalized,new RegExp(`alter table ${escapeRegExp(table)} enable row level security`));
    assert.match(normalized,new RegExp(`revoke all on table ${escapeRegExp(table)} from public,anon,authenticated,service_role`));
  }
  assert.match(normalized,/create policy support_requests_v3_read on core\.support_requests for select to authenticated using \([^;]+support_can_read_ticket/);
  assert.match(normalized,/create policy support_messages_v3_read[^;]+support_tenant_can_read_ticket\(tenant_id,ticket_id\) and not is_internal[^;]+support_platform_can_read\(\)/);
  assert.match(normalized,/create policy support_events_v3_read[^;]+visibility='tenant'[^;]+support_platform_can_read\(\)/);
  assert.match(normalized,/create policy support_attachments_v3_read[^;]+not message\.is_internal[^;]+support_platform_can_read\(\)/);

  const document=compact(routine(migration,'private_app.support_ticket_document'));
  assert.ok((document.match(/p_include_internal or not message\.is_internal/g)||[]).length>=3);
  assert.match(document,/p_include_internal or event\.visibility='tenant'/);
  const tenantSnapshot=compact(routine(migration,'public.v3_tenant_support_snapshot'));
  const platformSnapshot=compact(routine(migration,'public.v3_platform_support_snapshot'));
  assert.match(tenantSnapshot,/support_ticket_document\([^)]*false,v_subject_id\s*\)/);
  assert.match(platformSnapshot,/support_ticket_document\([^)]*true,v_subject_id\s*\)/);

  const platformAction=compact(routine(migration,'public.v3_platform_support_action'));
  assert.match(platformAction,/v_action in \('add_message','add_internal_note'\)/);
  assert.match(platformAction,/v_is_internal:=v_action='add_internal_note'/);
  assert.match(platformAction,/if v_is_internal then insert into core\.support_events[^;]+'note\.created'[^;]+'platform'/);
  assert.match(platformAction,/else update core\.support_requests/);
  assert.match(platformAction,/insert into core\.support_events[^;]+'message\.created'[^;]+'tenant'/);
});

test('v3 snapshots and actions use bounded cursor queues and explicit grants',async()=>{
  const {migration,supportApi,tenantPage,platformPage,tenantRoute,platformRoute}=await sources();
  const normalized=compact(migration);
  for(const rpc of [
    'v3_tenant_support_snapshot','v3_platform_support_snapshot',
    'v3_tenant_support_action','v3_platform_support_action'
  ]){
    assert.match(normalized,new RegExp(`create or replace function public\\.${rpc}\\s*\\(`));
    assert.match(normalized,new RegExp(`grant execute on function public\\.${rpc}\\s*\\(`));
  }
  for(const action of [
    'create_ticket','add_message','mark_read','reopen_ticket','close_ticket',
    'add_internal_note','assign_ticket','update_ticket'
  ])assert.match(normalized,new RegExp(`'${action}'`));

  for(const snapshotName of [
    'public.v3_tenant_support_snapshot','public.v3_platform_support_snapshot'
  ]){
    const snapshot=compact(routine(migration,snapshotName));
    assert.match(snapshot,/p_cursor_updated_at/);
    assert.match(snapshot,/p_cursor_id/);
    assert.match(snapshot,/\(ticket\.updated_at,ticket\.id\)<\( p_cursor_updated_at,p_cursor_id \)/);
    assert.match(snapshot,/'nextcursor',v_next_cursor/);
    assert.match(snapshot,/'hasmore',v_has_more/);
  }
  for(const queue of [
    'all','new','unassigned','mine','urgent','at_risk','breached','waiting_tenant'
  ]){
    assert.match(platformPage,new RegExp(`'${queue}'`));
    assert.match(migration,new RegExp(`'${queue}'`));
  }
  assert.match(supportApi,/p_cursor_updated_at:nullableText\(options\.cursorUpdatedAt/);
  assert.match(supportApi,/p_cursor_id:nullableText\(options\.cursorId/);
  assert.match(tenantPage,/cursorUpdatedAt/);
  assert.match(platformPage,/cursorUpdatedAt/);
  assert.match(tenantRoute,/v3_tenant_support_action/);
  assert.match(platformRoute,/v3_platform_support_action/);
});

test('mutations are versioned, idempotent, and audited without message bodies',async()=>{
  const {migration}=await sources();
  const normalized=compact(migration);
  const tenantAction=compact(routine(migration,'public.v3_tenant_support_action'));
  const platformAction=compact(routine(migration,'public.v3_platform_support_action'));
  for(const action of [tenantAction,platformAction]){
    assert.match(action,/v_expected_version/);
    assert.match(action,/for update/);
    assert.match(action,/ticket\.version=v_expected_version/);
    assert.match(action,/if not found then raise exception 'support_ticket_conflict'/);
    assert.match(action,/support_idempotency_conflict/);
    assert.match(action,/request_hash/);
  }
  assert.match(normalized,/core_support_requests_tenant_idempotency_uidx/);
  assert.match(normalized,/core_support_events_client_request_uidx/);
  assert.match(normalized,/support_messages_client_request_key unique \(tenant_id,ticket_id,client_request_id\)/);
  assert.match(tenantAction,/pg_advisory_xact_lock/);
  assert.match(tenantAction,/v_diagnostics:=jsonb_strip_nulls\(jsonb_build_object\(/);
  for(const diagnosticKey of [
    'reproductionsteps','expectedresult','actualresult','sourceurl','browsercontext'
  ])assert.match(tenantAction,new RegExp(`'${diagnosticKey}'`));
  assert.match(tenantAction,/regexp_replace/);
  assert.ok(tenantAction.includes("'[?#].*$'"),'diagnostic URLs must lose query strings and fragments');

  const auditCalls=callsTo(migration,'private_app.write_audit');
  assert.ok(auditCalls.length>=5,'ticket, reply, assignment, and attachment actions must be audited');
  for(const auditCall of auditCalls){
    assert.doesNotMatch(
      auditCall,
      /\b(?:v_content|v_description|v_note|v_diagnostics)\b|['"](?:content|description|note|diagnostics)['"]/i,
      'audit metadata must never contain ticket or message bodies'
    );
  }
  assert.doesNotMatch(tableDefinition(migration,'core.support_events'),/\b(?:content|description|diagnostics)\s+(?:text|jsonb)\b/i);
});

test('attachments use a private 10MB allowlist and database-issued non-overwritable paths',async()=>{
  const {migration}=await sources();
  const normalized=compact(migration);
  assert.match(normalized,/support-attachments','support-attachments',false,10485760/);
  for(const mime of [
    'image/png','image/jpeg','image/webp','image/gif','application/pdf','text/plain'
  ])assert.match(normalized,new RegExp(`'${escapeRegExp(mime)}'`));

  assert.match(normalized,/create policy support_attachments_insert on storage\.objects for insert to authenticated/);
  assert.match(normalized,/support_attachments_insert[^;]+bucket_id='support-attachments'[^;]+v3_support_storage_can_upload\(name\)/);
  assert.match(normalized,/create policy support_attachments_select on storage\.objects for select to authenticated/);
  assert.match(normalized,/drop policy if exists support_attachments_update on storage\.objects/);
  assert.match(normalized,/drop policy if exists support_attachments_delete on storage\.objects/);

  const upload=compact(routine(migration,'public.v3_support_attachment_upload_ticket'));
  assert.match(upload,/p_size_bytes is null or p_size_bytes not between 1 and 10485760/);
  assert.match(upload,/v_object_path:=v_ticket\.tenant_id::text\|\|'\/'\|\|v_ticket\.id::text\|\|'\/' \|\|v_message\.id::text\|\|'\/'\|\|v_attachment_id::text\|\|v_extension/);
  assert.match(upload,/v_message\.author_subject_id is distinct from v_subject_id/);
  assert.match(upload,
    /if v_attachment\.state='ready' then[\s\S]+?'state','ready'/,
    'a finalized idempotent replay must be returned as ready');
  assert.match(upload,
    /from storage\.objects object[\s\S]+?if v_object_exists then[\s\S]+?'state','uploaded'/,
    'an object uploaded before a lost response must be finalized without another PUT');
  assert.match(upload,
    /if v_attachment\.state='pending' and v_attachment\.expires_at>now\(\) then[\s\S]+?'state','pending'[\s\S]+?raise exception 'support_attachment_upload_expired'/,
    'only a live pending registration may issue another signed upload');
  const finalize=compact(routine(migration,'public.v3_support_attachment_finalize'));
  assert.match(finalize,/from storage\.objects object/);
  assert.match(finalize,/v_actual_size is distinct from v_attachment\.declared_size_bytes/);
  assert.match(finalize,/v_actual_mime is distinct from v_attachment\.mime_type/);
  assert.match(normalized,/create trigger support_attachment_delete_guard before delete on core\.support_attachments/);
});

test('support attachments fail closed at the database until a scanner pipeline exists',async()=>{
  const {migration,attachmentGateMigration}=await sources();
  const normalized=compact(attachmentGateMigration);
  assert.match(normalized,/^begin;/);
  assert.match(normalized,/commit;$/);
  assert.match(
    normalized,
    /update storage\.buckets bucket set public=false where bucket\.id='support-attachments'/
  );

  const base=compact(migration);
  assert.match(base,/^begin; set local lock_timeout = '10s'; set local statement_timeout = '120s';/);
  const baseCommit=base.lastIndexOf('commit;');
  const baseDeny=base.lastIndexOf(
    'create policy support_attachments_scanner_fail_closed'
  );
  const baseUploadGrant=base.lastIndexOf(
    'grant execute on function public.v3_support_attachment_upload_ticket'
  );
  const baseUploadRevoke=base.lastIndexOf(
    'revoke all on function public.v3_support_attachment_upload_ticket'
  );
  const baseScannerGuard=base.lastIndexOf(
    "raise exception 'support_attachments_scanner_unavailable'"
  );
  assert.ok(baseDeny>baseUploadGrant&&baseUploadRevoke>baseUploadGrant,
    'the base migration must close Storage and RPC access before it can commit');
  assert.ok(baseScannerGuard>baseUploadGrant&&baseCommit>baseScannerGuard,
    'the base migration must replace attachment RPCs with scanner guards');
  assert.ok(baseCommit>baseDeny&&baseCommit>baseUploadRevoke,
    'the fail-closed boundary must be in the base transaction');

  for(const policy of [
    'support_attachments_insert','support_attachments_select',
    'support_attachments_update','support_attachments_delete'
  ]){
    assert.match(
      normalized,
      new RegExp(`drop policy if exists ${policy} on storage\\.objects`)
    );
  }
  assert.match(
    normalized,
    /create policy support_attachments_scanner_fail_closed on storage\.objects as restrictive for all to public/
  );
  assert.match(normalized,/using \(bucket_id<>'support-attachments'\)/);
  assert.match(normalized,/with check \(bucket_id<>'support-attachments'\)/);
  assert.match(
    normalized,
    /comment on policy support_attachments_scanner_fail_closed on storage\.objects/
  );

  for(const helperName of [
    'public.v3_support_storage_can_upload',
    'public.v3_support_storage_can_read'
  ]){
    const helper=compact(routine(attachmentGateMigration,helperName));
    assert.match(helper,/immutable security definer set search_path='' as \$\$ select false \$\$;/);
  }
  for(const rpcName of [
    'public.v3_support_attachment_upload_ticket',
    'public.v3_support_attachment_finalize',
    'public.v3_support_attachment_resolve'
  ]){
    const guard=compact(routine(attachmentGateMigration,rpcName));
    assert.match(guard,/raise exception 'support_attachments_scanner_unavailable'/);
  }

  for(const signature of [
    'v3_support_storage_can_upload\\(text\\)',
    'v3_support_storage_can_read\\(text\\)',
    'v3_support_attachment_upload_ticket\\( uuid,uuid,text,text,bigint,text \\)',
    'v3_support_attachment_finalize\\(uuid,bigint\\)',
    'v3_support_attachment_resolve\\(uuid\\)'
  ]){
    assert.match(
      normalized,
      new RegExp(
        `revoke all on function public\\.${signature} from public,anon,authenticated,service_role`
      )
    );
    assert.doesNotMatch(
      normalized,
      new RegExp(`grant execute on function public\\.${signature}`)
    );
  }

  for(const cleanupSignature of [
    'v3_support_attachment_cleanup_snapshot\\(integer\\)',
    'v3_support_attachment_cleanup_finalize\\(uuid\\)'
  ]){
    assert.match(
      normalized,
      new RegExp(
        `grant execute on function public\\.${cleanupSignature} to service_role`
      )
    );
  }
  assert.doesNotMatch(
    normalized,
    /v3_(?:tenant|platform)_support_(?:snapshot|action)/,
    'the scanner gate must not disable tickets, messages, or support desks'
  );
  assert.doesNotMatch(normalized,/\b(?:delete|truncate|drop table|update)\s+core\./);
});

test('attachment HTTP flow signs direct upload, finalizes, and signs authorized downloads',async()=>{
  const {
    desk,sharedRoute,attachmentTicketRoute,attachmentFinalizeRoute,
    attachmentDownloadRoute,tenantRoute,platformRoute
  }=await sources();
  assert.match(sharedRoute,/SUPPORT_ATTACHMENT_LIMIT=10\*1024\*1024/);
  assert.match(attachmentTicketRoute,/sameOrigin\(request\)/);
  assert.match(attachmentTicketRoute,/sessionToken\(\)/);
  assert.match(attachmentTicketRoute,/v3_support_attachment_upload_ticket/);
  assert.match(attachmentTicketRoute,/\/storage\/v1\/object\/upload\/sign\//);
  assert.match(attachmentTicketRoute,/cache:'no-store'/);
  assert.match(desk,/fetch\(registered\.uploadUrl,\{/);
  assert.match(desk,/method:'PUT'/);
  assert.match(desk,/'x-upsert':'false'/);
  assert.match(desk,/supportAttachmentJson\('\/api\/support\/attachments\/finalize'/);

  assert.match(attachmentFinalizeRoute,/sameOrigin\(request\)/);
  assert.match(attachmentFinalizeRoute,/v3_support_attachment_finalize/);
  assert.match(attachmentDownloadRoute,/v3_support_attachment_resolve/);
  assert.match(attachmentDownloadRoute,/storageUrl\('sign',resolved\.bucket,resolved\.objectPath\)/);
  assert.match(attachmentDownloadRoute,/JSON\.stringify\(\{expiresIn:60\}\)/);
  assert.match(attachmentDownloadRoute,/status:307/);
  assert.match(attachmentDownloadRoute,/cache-control':'private, no-store, max-age=0/);

  const runtime=[
    sharedRoute,attachmentTicketRoute,attachmentFinalizeRoute,
    attachmentDownloadRoute,tenantRoute,platformRoute,desk
  ].join('\n');
  assert.doesNotMatch(runtime,/service[_-]?role|supabase_service/i);
  assert.doesNotMatch(`${tenantRoute}\n${platformRoute}`,/requestedBy|requesterSubjectId|requester_staff|tenantId/);
});

test('attachment retries preserve identity and recover without overwriting objects',async()=>{
  const {desk,attachmentTicketRoute}=await sources();
  const readyBranch=attachmentTicketRoute.indexOf("if(state==='ready')");
  const uploadedBranch=attachmentTicketRoute.indexOf("if(state==='uploaded')");
  const signingCall=attachmentTicketRoute.indexOf('/storage/v1/object/upload/sign/');
  assert.ok(readyBranch>=0&&readyBranch<signingCall,
    'a ready replay must return before signing another upload');
  assert.ok(uploadedBranch>=0&&uploadedBranch<signingCall,
    'an already-uploaded replay must finalize without signing another upload');
  assert.match(attachmentTicketRoute,
    /if\(state==='ready'\)[\s\S]+?uploadRequired:false,[\s\S]+?finalizeRequired:false/);
  assert.match(attachmentTicketRoute,
    /if\(state==='uploaded'\)[\s\S]+?uploadRequired:false,[\s\S]+?finalizeRequired:true/);
  assert.match(attachmentTicketRoute,
    /state,[\s\S]+?uploadUrl:[\s\S]+?uploadRequired:true,[\s\S]+?finalizeRequired:true/);

  assert.match(desk,/attachmentRequestIds=useRef\(new WeakMap\(\)\)/);
  assert.match(desk,/crypto\?\.randomUUID[\s\S]+?new Uint8Array\(16\)[\s\S]+?getRandomValues/,
    'the fallback id must remain a valid random UUID accepted by the API');
  assert.doesNotMatch(desk,/`support-\$\{Date\.now\(\)\}/,
    'attachment request ids must never fall back to a non-UUID value');
  assert.match(desk,/requestIds\.get\(contextKey\)[\s\S]+?requestIds\.set\(contextKey,requestId\)/);
  assert.match(desk,/clientRequestId:payload\.clientRequestId/,
    'every registration retry must reuse the selected file request id');
  const readyReplay=desk.indexOf("if(registered.state==='ready')");
  const uploadedReplay=desk.indexOf("if(registered.state==='uploaded')");
  const objectPut=desk.indexOf('fetch(registered.uploadUrl');
  assert.ok(readyReplay>=0&&readyReplay<objectPut,
    'ready registrations must skip PUT and finalize');
  assert.ok(uploadedReplay>=0&&uploadedReplay<objectPut,
    'uploaded registrations must skip PUT and go directly to finalize');
  assert.match(desk,/for\(let attempt=0;attempt<2;attempt\+=1\)/);
  assert.match(desk,/headers:\{'Content-Type':file\.type,'x-upsert':'false'\}/);
  assert.match(desk,
    /finalizeSupportAttachment\([\s\S]+?\{allowMissing:true\}[\s\S]+?if\(recovered\)return/,
    'an uncertain PUT must try idempotent finalize before retrying');
});

test('orphan attachment cleanup is service-only, bounded, idempotent, and Storage-API driven',async()=>{
  const {migration,cleanupWorker,supabaseConfig}=await sources();
  const normalized=compact(migration);
  const snapshot=compact(routine(
    migration,'public.v3_support_attachment_cleanup_snapshot'
  ));
  const finalize=compact(routine(
    migration,'public.v3_support_attachment_cleanup_finalize'
  ));
  assert.match(
    normalized,
    /constraint support_attachments_cleanup_after_check check \(cleanup_after>=expires_at\+interval '2 hours'\)/
  );
  assert.match(snapshot,/attachment\.state='pending'/);
  assert.match(snapshot,/attachment\.cleanup_after<=now\(\)-interval '5 minutes'/);
  assert.match(snapshot,/least\(greatest\(coalesce\(p_limit,100\),1\),500\)/);
  assert.match(snapshot,/'attachmentid',page\.id/);
  assert.match(snapshot,/'objectpath',page\.object_path/);
  assert.match(snapshot,/'hasmore'/);
  assert.match(finalize,/for update/);
  assert.match(finalize,/v_attachment\.cleanup_after>now\(\)-interval '5 minutes'/);
  assert.match(finalize,/from storage\.objects object/);
  assert.match(finalize,/support_attachment_storage_cleanup_required/);
  assert.match(finalize,/delete from core\.support_attachments attachment/);
  assert.match(finalize,/'success',true,'idempotent',true/);
  assert.doesNotMatch(normalized,/delete from storage\.objects/);
  for(const rpc of [
    'v3_support_attachment_cleanup_snapshot\\(integer\\)',
    'v3_support_attachment_cleanup_finalize\\(uuid\\)'
  ]){
    assert.match(normalized,new RegExp(`revoke all on function public\\.${rpc} from public,anon,authenticated,service_role`));
    assert.match(normalized,new RegExp(`grant execute on function public\\.${rpc} to service_role`));
    assert.doesNotMatch(normalized,new RegExp(`grant execute on function public\\.${rpc} to (?:anon|authenticated)`));
  }

  assert.match(cleanupWorker,/request\.method!=='POST'/);
  assert.match(cleanupWorker,/json\(405,[^\n]+\{allow:'POST'\}\)/);
  assert.match(cleanupWorker,/ODEIR_SUPPORT_ATTACHMENT_CLEANUP_SECRET/);
  assert.match(cleanupWorker,/x-odeir-support-cleanup-secret/);
  assert.match(cleanupWorker,/constantTimeEqual\(suppliedSecret,cronSecret\)/);
  assert.match(cleanupWorker,/crypto\.subtle\.digest\('SHA-256'/);
  assert.match(cleanupWorker,/difference\|=/);
  assert.match(cleanupWorker,/Deno\.env\.get\('SUPABASE_SERVICE_ROLE_KEY'\)/);
  assert.match(cleanupWorker,/v3_support_attachment_cleanup_snapshot/);
  assert.match(cleanupWorker,/v3_support_attachment_cleanup_finalize/);
  assert.match(cleanupWorker,/MAX_ITEMS_PER_RUN=BATCH_SIZE\*MAX_BATCHES/);
  assert.match(cleanupWorker,/chunk\(snapshot\.items,BATCH_SIZE\)\.slice\(0,MAX_BATCHES\)/);
  assert.match(cleanupWorker,/FINALIZE_CONCURRENCY/);
  assert.match(cleanupWorker,/\/storage\/v1\/object\/\$\{encodeURIComponent\(SUPPORT_BUCKET\)\}/);
  assert.match(cleanupWorker,/method:'DELETE'/);
  assert.match(cleanupWorker,/JSON\.stringify\(\{prefixes:items\.map\(item=>item\.objectPath\)\}\)/);
  assert.match(cleanupWorker,/response\.status!==404/);
  assert.match(cleanupWorker,/AbortSignal\.timeout/);
  assert.match(cleanupWorker,/OPERATION_TIMEOUT_MS=25_000/);
  assert.match(cleanupWorker,/'cache-control':'no-store, max-age=0'/);
  assert.doesNotMatch(cleanupWorker,/\/rest\/v1\/(?!rpc\/)/);
  for(const logCall of [
    ...callsTo(cleanupWorker,'console.info'),
    ...callsTo(cleanupWorker,'console.error')
  ]){
    assert.doesNotMatch(
      logCall,
      /objectPath|serviceRoleKey|cronSecret|suppliedSecret|authorization/i,
      'cleanup logs must contain counts and controlled codes only'
    );
  }
  assert.match(
    supabaseConfig,
    /\[functions\.support-attachment-cleanup\][\s\S]*?verify_jwt\s*=\s*false/
  );
});

test('support is the final navigation item and support-only staff land in its control desk',async()=>{
  const {shell,serverAuth,tenantPage,platformPage,generalApi,migration}=await sources();
  const tenantItems=shell.slice(
    shell.indexOf('function tenantItems('),
    shell.indexOf('function platformItems(')
  );
  const platformItems=shell.slice(
    shell.indexOf('function platformItems('),
    shell.indexOf('function isActive(')
  );
  assert.match(tenantItems,/\{key:'support',label:'الدعم الفني',href:`\$\{base\}\/support`,always:true,[\s\S]+\}\s*\];/);
  assert.match(platformItems,/\{key:'support',label:'الدعم الفني',href:'\/control\/support',permission:\[[\s\S]+platform\.support\.read[\s\S]+\][\s\S]+\}\s*\];/);
  assert.match(serverAuth,/hasPlatformPermission\(context,'platform\.support\.read'\)/);
  assert.match(tenantPage,/requireTenant\(slug\)/);
  assert.match(platformPage,/requireAnyPlatformPermission\(SUPPORT_PERMISSIONS\)/);

  const {canAccessPlatformControl,resolvePostLoginPath}=await import(
    new URL('../lib/login-destination.mjs',import.meta.url)
  );
  const supportOnly={platformPermissions:['platform.support.read']};
  assert.equal(canAccessPlatformControl(supportOnly),true);
  assert.equal(canAccessPlatformControl({
    platformPermissions:['platform.support.reply']
  }),true);
  assert.equal(canAccessPlatformControl({
    platformPermissions:['platform.support.manage']
  }),true);
  assert.equal(resolvePostLoginPath({context:supportOnly}),'/control/support');
  assert.equal(resolvePostLoginPath({
    context:supportOnly,
    requestedNext:'/control/tenants'
  }),'/control/support');
  assert.equal(resolvePostLoginPath({
    context:supportOnly,
    requestedNext:'/control/support?queue=mine'
  }),'/control/support?queue=mine');

  assert.match(generalApi,/v[23]_tenant_workspace_snapshot/);
  assert.match(generalApi,/v[23]_platform_control_snapshot/);
  const workspaceWrapper=compact(routine(migration,'public.v3_tenant_workspace_snapshot'));
  const platformWrapper=compact(routine(migration,'public.v2_platform_control_snapshot_v2'));
  assert.match(workspaceWrapper,/jsonb_set\(v_result,'\{supportrequests\}','\[\]'::jsonb,true\)/);
  assert.match(platformWrapper,/jsonb_set\(v_result,'\{supportrequests\}','\[\]'::jsonb,true\)/);
  assert.match(compact(migration),/revoke all on function public\.v2_tenant_workspace_snapshot\(text\) from public,anon,authenticated,service_role/);
});

test('shell support alerts use bounded optional summaries without exposing tickets',async()=>{
  const {tenantLayout,controlLayout,shell}=await sources();

  assert.match(tenantLayout,/optionalServerRead\([\s\S]*'tenant-shell-support-summary'[\s\S]*getTenantSupport\(slug,\{limit:1\}\)/);
  assert.match(tenantLayout,/supportSummary=\{tenantSupport\?\.summary\|\|null\}/);
  assert.doesNotMatch(tenantLayout,/supportSummary=\{tenantSupport\}/);

  for(const permission of [
    'platform.support.read','platform.support.reply','platform.support.manage'
  ])assert.match(controlLayout,new RegExp(permission.replaceAll('.','\\.')));
  assert.match(controlLayout,/canReadSupport[\s\S]*getPlatformSupport\(\{limit:1\}\)/);
  assert.match(controlLayout,/optionalServerRead\([\s\S]*'platform-shell-support-summary'/);
  assert.match(controlLayout,/supportSummary=\{platformSupport\?\.summary\|\|null\}/);
  assert.doesNotMatch(controlLayout,/supportSummary=\{platformSupport\}/);

  assert.match(shell,/tenantSupportAttentionCount\(summary\)[\s\S]*summary\?\.unread[\s\S]*summary\?\.waitingTenant/);
  assert.match(shell,/platformSupportAttentionCount\(summary\)[\s\S]*summary\?\.unassigned[\s\S]*summary\?\.overdue/);
  assert.match(shell,/tenantSupportNotificationItems\(supportSummary,slug\)/);
  assert.match(shell,
    /canReadPlatformSupport[\s\S]*(?:href="\/control\/support"|footerHref=\{canReadPlatformSupport\?'\/control\/support')/);
  assert.match(shell,/platformSupportAttentionCount\(supportSummary\)/);
});

test('support code cannot use service-role credentials or mutate Reef tenant data',async()=>{
  const {
    migration,sharedRoute,tenantRoute,platformRoute,
    attachmentTicketRoute,attachmentFinalizeRoute,attachmentDownloadRoute
  }=await sources();
  const runtime=[
    sharedRoute,tenantRoute,platformRoute,attachmentTicketRoute,
    attachmentFinalizeRoute,attachmentDownloadRoute
  ].join('\n');
  assert.doesNotMatch(runtime,/service[_-]?role|supabase_service/i);
  assert.match(migration,/from public,anon,authenticated,service_role/);
  assert.doesNotMatch(migration,/\breef\b|ريف/i);
  assert.doesNotMatch(
    compact(migration),
    /\b(?:update|delete from|insert into)\s+(?:core\.tenants|people\.staff_profiles)\b/
  );
  assert.doesNotMatch(compact(migration),/\bdelete from\s+core\.support_(?:requests|messages|events|read_states)\b/);
});
