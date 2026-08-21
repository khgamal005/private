import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_APP_ORIGIN,
  normalizeRecoveryEmail,
  recoveryRedirectUrl,
  validateRecoveryPassword
} from '../lib/password-recovery.mjs';

test('recovery email is normalized without accepting malformed values',()=>{
  assert.equal(
    normalizeRecoveryEmail('  Employee@Example.com  '),
    'employee@example.com'
  );
  assert.equal(normalizeRecoveryEmail('not-an-email'),null);
  assert.equal(normalizeRecoveryEmail(null),null);
});

test('recovery redirects stay on an explicitly trusted HTTPS origin',()=>{
  assert.equal(
    recoveryRedirectUrl('https://demo.odeir.com/somewhere'),
    'https://demo.odeir.com/reset-password'
  );
  assert.equal(
    recoveryRedirectUrl('javascript:alert(1)'),
    `${DEFAULT_APP_ORIGIN}/reset-password`
  );
  assert.equal(
    recoveryRedirectUrl('http://attacker.example'),
    `${DEFAULT_APP_ORIGIN}/reset-password`
  );
});

test('new recovery password must match and contain at least 12 characters',()=>{
  assert.match(validateRecoveryPassword('short','short'),/12/);
  assert.match(
    validateRecoveryPassword('long-enough-password','different-password'),
    /غير متطابقتين/
  );
  assert.equal(
    validateRecoveryPassword('long-enough-password','long-enough-password'),
    null
  );
});
