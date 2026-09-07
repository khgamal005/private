"""Exact two-file ODEIR release; preview rolls back every DDL/DML operation.
Only a fixed Supabase management endpoint receives the existing operator token.
No external payment, email, customer fixture or Reef mutation is issued.
"""
import json,os,re,sys,hashlib,urllib.request,urllib.error,pathlib
PROJECT='gswpbwdactcstkasddta'
FILES=['supabase/migrations/20260906232948_odeir_independent_commerce_v1.sql','supabase/migrations/20260907104357_odeir_core_transition_simplified_v1.sql']
mode=sys.argv[1] if len(sys.argv)>1 else 'preview'
if mode not in ('preview','apply'):raise SystemExit('invalid_release_mode')
if mode=='apply' and os.environ.get('ODEIR_RELEASE_CONFIRM')!='PUBLISH_APPROVED_PRICING_PRESERVE_REEF':raise SystemExit('release_confirmation_required')
token=os.environ.get('SUPABASE_ACCESS_TOKEN','')
if not token:raise SystemExit('production_credential_unavailable')
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
opener=urllib.request.build_opener(NoRedirect)
def api(path,data=None):
 url='https://api.supabase.com/v1/projects/'+PROJECT+path
 req=urllib.request.Request(url,data=None if data is None else json.dumps(data).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
 try:
  with opener.open(req,timeout=160) as r:return json.load(r)
 except urllib.error.HTTPError as e:
  body=e.read().decode(errors='replace')
  # SQL text is our reviewed source. Never print credentials or runtime rows.
  code=re.search(r'(?:ERROR:|message["\s:]+)([^\n]{1,450})',body)
  raise SystemExit(f'production_query_failed:{e.code}: '+(code.group(1) if code else 'see_management_request'))
project=api('')
if (project.get('id') or project.get('ref'))!=PROJECT or re.search('staging|sandbox|test|development',project.get('name',''),re.I):raise SystemExit('production_identity_mismatch')
pre=api('/database/query',{'query':"select to_regclass('catalog.independent_commercial_catalog_v1') is not null as installed;"})
if pre[0]['installed']:raise SystemExit('release_already_installed_reverify_do_not_reapply')
parts=[];hashes={}
for f in FILES:
 s=pathlib.Path(f).read_text();hashes[f]=hashlib.sha256(s.encode()).hexdigest()
 assert s.startswith('begin;') and s.rstrip().endswith('commit;')
 parts.append(s[len('begin;'):s.rfind('commit;')])
# All pre-existing Reef-scoped row content is fingerprinted in one repeatable
# snapshot, so concurrent normal production work cannot create false drift.
guard=r"""
create temp table reef_row_manifest_v1 on commit drop as
select n.nspname schema_name,c.relname table_name from pg_class c join pg_namespace n on n.oid=c.relnamespace
join pg_attribute a on a.attrelid=c.oid and a.attname='tenant_id' and a.atttypid='uuid'::regtype and not a.attisdropped
where c.relkind in ('r','p') and n.nspname not like 'pg_%' and n.nspname<>'information_schema';
create function pg_temp.reef_rows_fingerprint() returns jsonb language plpgsql set search_path='' as $$
declare r record;tid uuid;h text;n bigint;result jsonb:='{}';
begin
 select id into tid from core.tenants where slug='reef-skills';
 if tid is null then raise exception 'protected_reef_missing';end if;
 for r in select * from pg_temp.reef_row_manifest_v1 order by schema_name,table_name loop
 execute format('select count(*), md5(coalesce(string_agg(md5(to_jsonb(x)::text),'''' order by md5(to_jsonb(x)::text)),'''')) from %I.%I x where tenant_id=$1',r.schema_name,r.table_name) into n,h using tid;
 result:=result||jsonb_build_object(r.schema_name||'.'||r.table_name,jsonb_build_object('rows',n,'digest',h));
 end loop;return result;
end $$;
create temp table reef_all_rows_before on commit drop as select pg_temp.reef_rows_fingerprint() v;
"""
verify=r"""
do $$begin
 if (select before_state from independent_release_guard) is distinct from pg_temp.reef_commerce_fingerprint() then raise exception 'reef_contract_fingerprint_changed';end if;
 if (select v from reef_all_rows_before) is distinct from pg_temp.reef_rows_fingerprint() then raise exception 'reef_business_rows_changed';end if;
 if (select count(*) from catalog.independent_commercial_catalog_v1 where kind='core' and published)<>4 then raise exception 'core_catalog_not_four';end if;
 if exists(select 1 from catalog.independent_commercial_catalog_v1 where kind='core' and profile->'limits' ? 'newLeadsPerMonth') then raise exception 'deferred_limits_must_not_be_advertised';end if;
end $$;
"""
sql='begin isolation level repeatable read;\nset local statement_timeout=\'120s\';\n'+guard+'\n'.join(parts)+verify
if mode=='apply':
 for f in FILES:
  path=pathlib.Path(f);version,name=path.stem.split('_',1)
  # Exact canonical filenames generated with the Supabase CLI; one atomic
  # audited migration history entry per reviewed file.
  escaped=path.read_text().replace("'","''")
  sql+=f"\ninsert into supabase_migrations.schema_migrations(version,name,statements) values('{version}','{name}',array['{escaped}']);"
 sql+="\ncommit; select jsonb_build_object('publishedCore', (select count(*) from catalog.independent_commercial_catalog_v1 where kind='core' and published),'addonOffers',(select count(*) from catalog.independent_commercial_catalog_v1 where kind='addon'),'transitioned',(select count(*) from catalog.core_transition_v1),'reefProtected',exists(select 1 from catalog.subscriptions s join core.tenants t on t.id=s.tenant_id join catalog.plans p on p.id=s.plan_id where t.slug='reef-skills' and p.plan_key='full' and s.status='active' and s.period_end is null)) as evidence;"
else:
 sql+="\nrollback; select jsonb_build_object('rolledBack',true,'catalogAbsent',to_regclass('catalog.independent_commercial_catalog_v1') is null) as evidence;"
res=api('/database/query',{'query':sql})
if not isinstance(res,list) or len(res)!=1 or not isinstance(res[0].get('evidence'),dict):raise SystemExit('unexpected_verification_response')
ev=res[0]['evidence']
if mode=='preview' and not(ev.get('rolledBack') and ev.get('catalogAbsent')):raise SystemExit('preview_failed')
if mode=='apply' and not(ev.get('publishedCore')==4 and ev.get('addonOffers')==16 and ev.get('reefProtected')):raise SystemExit('post_apply_verification_failed')
output={'mode':mode,'fileSha256':hashes,'evidence':ev,'allPreexistingReefRowsVerifiedWithinTransaction':True,'noPaymentOrMessageIssued':True}
pathlib.Path('/tmp/pricing-evidence').mkdir(exist_ok=True)
pathlib.Path('/tmp/pricing-evidence/database-'+mode+'.json').write_text(json.dumps(output,indent=2))
print(json.dumps(output,indent=2))
