// Runs only against the disposable loopback CI database; never accepts production URLs.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {Client} from 'pg';
import {checkoutSetup} from '../tests/fixtures/academy-concurrency-database.mjs';
import {storageTestConfiguration,storageTestJwt,STORAGE_TEST_SECRET} from '../tests/fixtures/academy-storage-runtime.mjs';
const config=storageTestConfiguration(),client=new Client({connectionString:config.databaseUrl});
await client.connect();
try{
 assert.equal((await client.query("select count(*)::int n from pg_namespace where nspname in ('academy','core','storage')")).rows[0].n,0,'Refusing an existing database');
 await checkoutSetup({database:{query:(...args)=>client.query(...args),exec:sql=>client.query(sql),close:async()=>{}}});
 // Replace the fixture-only Auth UID seam with the verified JWT claim shape
 // used by the real Storage service; canonical roles/permissions remain real SQL.
 await client.query(`create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub',nullif(current_setting('fixture.auth_user_id',true),''))::uuid $$;
  create or replace function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}')$$;
  grant usage on schema auth to anon,authenticated,service_role;
  drop function storage.foldername(text);`);
 await writeFile('/tmp/academy-storage-ci.env',[
  'SERVER_PORT=5050','IS_MULTITENANT=false',`DATABASE_URL=${config.databaseUrl}`,
  'DB_INSTALL_ROLES=true','DB_SUPER_USER=postgres','DB_MIGRATIONS_STRATEGY=on_request',
  `AUTH_JWT_SECRET=${STORAGE_TEST_SECRET}`,'AUTH_JWT_ALGORITHM=HS256',
  `ANON_KEY=${storageTestJwt('anon')}`,`SERVICE_KEY=${storageTestJwt('service_role')}`,
  'STORAGE_BACKEND=file','STORAGE_FILE_BACKEND_PATH=/tmp/academy-storage-files','STORAGE_S3_BUCKET=academy-storage-ci',
  'UPLOAD_FILE_SIZE_LIMIT=524288000','UPLOAD_FILE_SIZE_LIMIT_STANDARD=52428800',
  'UPLOAD_SIGNED_URL_EXPIRATION_TIME=600','TUS_URL_PATH=/upload/resumable',
  'TENANT_ID=academy-storage-ci','STORAGE_S3_REGION=local','IMAGE_TRANSFORMATION_ENABLED=false',
  'RESPONSE_S_MAXAGE=0','RESPONSE_STALE_WHILE_REVALIDATE=0','RESPONSE_STALE_IF_ERROR=0',
 ].join('\n')+'\n',{mode:0o600});
 console.log('Prepared synthetic academy and loopback Storage configuration.');
}finally{await client.end();}
