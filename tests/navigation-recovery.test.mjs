import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {
  isRecoverableNavigationError,
  NAVIGATION_RECOVERY_WINDOW_MS,
  shouldAutoReloadNavigation
} from '../lib/navigation-recovery.mjs';

test('only known RSC and asset navigation failures trigger automatic recovery',()=>{
  const recoverable=[
    new Error('Minified React error #412; visit react.dev/errors/412'),
    new Error('Connection closed.'),
    new Error('Failed to fetch RSC payload'),
    Object.assign(new Error('Loading chunk 892 failed'),{name:'ChunkLoadError'}),
    new Error('Failed to fetch dynamically imported module')
  ];
  for(const error of recoverable){
    assert.equal(isRecoverableNavigationError(error),true,error.message);
  }
  assert.equal(isRecoverableNavigationError(new Error('Unauthorized: 401')),false);
  assert.equal(isRecoverableNavigationError(new Error('Invalid password')),false);
  assert.equal(isRecoverableNavigationError(new Error('Database constraint failed')),false);
});

test('automatic recovery is one-shot inside the safety window',()=>{
  const now=1_000_000;
  const error=new Error('Connection closed.');
  assert.equal(shouldAutoReloadNavigation({
    error,
    previousRecoveryAt:0,
    now
  }),true);
  assert.equal(shouldAutoReloadNavigation({
    error,
    previousRecoveryAt:now,
    now
  }),false);
  assert.equal(shouldAutoReloadNavigation({
    error,
    previousRecoveryAt:now-NAVIGATION_RECOVERY_WINDOW_MS,
    now
  }),true);
});

test('root, global, and tenant boundaries share guarded recovery',async()=>{
  const source=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
  const [root,global,runtime,tenant,hook]=await Promise.all([
    source('app/error.js'),
    source('app/global-error.js'),
    source('components/runtime-error-recovery.js'),
    source('components/tenant-error-state.js'),
    source('components/use-navigation-recovery.js')
  ]);
  assert.match(root,/RuntimeErrorRecovery/);
  assert.match(global,/<html[\s\S]*<body/);
  assert.match(runtime,/useNavigationRecovery/);
  assert.match(tenant,/useNavigationRecovery/);
  assert.match(tenant,/reloadDocument/);
  assert.match(hook,/sessionStorage/);
  assert.match(hook,/if\(!storage\|\|typeof storage\.setItem!==['"]function['"]\)return false/);
  assert.match(hook,/shouldAutoReloadNavigation/);
});
