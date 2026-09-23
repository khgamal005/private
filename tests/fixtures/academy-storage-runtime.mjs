import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
export const STORAGE_TEST_SECRET='academy-storage-disposable-ci-only-2026-never-production';
export function storageTestConfiguration(env=process.env){
 const database=new URL(env.ACADEMY_STORAGE_TEST_DATABASE_URL);
 const endpoint=new URL(env.ACADEMY_STORAGE_TEST_URL);
 assert.equal(database.protocol,'postgres:');assert.equal(database.hostname,'127.0.0.1');assert.equal(database.pathname,'/academy_storage');
 assert.equal(database.search,'');assert.equal(database.hash,'');
 assert.equal(endpoint.href,'http://127.0.0.1:5050/','Only the dedicated loopback Storage test service is permitted');
 return {databaseUrl:database.href,endpoint:endpoint.origin};
}
export function storageTestJwt(role='authenticated',sub){
 const now=Math.floor(Date.now()/1000),encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const data=`${encode({alg:'HS256',typ:'JWT'})}.${encode({role,sub,aud:role,iat:now,exp:now+3600})}`;
 return `${data}.${createHmac('sha256',STORAGE_TEST_SECRET).update(data).digest('base64url')}`;
}
