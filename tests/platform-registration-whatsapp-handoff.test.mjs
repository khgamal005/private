import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {
  buildRegistrationOwnerWhatsAppMessage,
  normalizeRegistrationInvitationUrl
} from '../lib/registration-owner-message.mjs';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('new owners receive a complete one-time activation WhatsApp message',()=>{
  const message=buildRegistrationOwnerWhatsAppMessage({
    mode:'invited',
    institutionName:'مركز مسار التثقيف للتدريب',
    ownerName:'فهد الحربي',
    ownerEmail:'owner@example.com',
    activationUrl:'https://odeir.com/accept-invite?token=one-time-token',
    loginUrl:'https://odeir.com/login'
  });

  assert.match(message,/مرحبًا أ\/ فهد الحربي/);
  assert.match(message,/مركز مسار التثقيف للتدريب/);
  assert.match(message,/تفعيل حساب مالك المنشأة وإنشاء كلمة المرور/);
  assert.match(message,/https:\/\/odeir\.com\/accept-invite\?token=one-time-token/);
  assert.match(message,/يُستخدم مرة واحدة/);
  assert.match(message,/لن نطلب منك كلمة المرور أو رمز التحقق عبر واتساب/);
  assert.doesNotMatch(message,/owner@example\.com/);
});

test('linked owners receive the login template without a fake activation link',()=>{
  const message=buildRegistrationOwnerWhatsAppMessage({
    mode:'linked',
    institutionName:'أكاديمية المثال',
    ownerName:'سارة أحمد',
    ownerEmail:'owner@example.com',
    activationUrl:'',
    loginUrl:'https://odeir.com/login'
  });

  assert.match(message,/حسابك مرتبط بالفعل/);
  assert.match(message,/https:\/\/odeir\.com\/login/);
  assert.match(message,/البريد المسجل: owner@example\.com/);
  assert.doesNotMatch(message,/accept-invite|يُستخدم مرة واحدة/);
});

test('handoff copy rejects unsafe URLs and removes control characters from labels',()=>{
  assert.equal(buildRegistrationOwnerWhatsAppMessage({
    mode:'invited',
    institutionName:'منشأة موثوقة',
    ownerName:'مالك المنشأة',
    activationUrl:'javascript:alert(1)',
    loginUrl:'https://odeir.com/login'
  }),'');

  const message=buildRegistrationOwnerWhatsAppMessage({
    mode:'invited',
    institutionName:'أكاديمية\nالمثال',
    ownerName:'أحمد\tمحمد',
    activationUrl:'https://odeir.com/accept-invite?token=safe',
    loginUrl:'https://odeir.com/login'
  });
  assert.match(message,/أحمد محمد/);
  assert.match(message,/أكاديمية المثال/);
  assert.doesNotMatch(message,/أكاديمية\nالمثال|أحمد\tمحمد/);
});

test('activation handoff accepts only the expected one-time invitation URL',()=>{
  const token='a'.repeat(64);
  const expected=`https://odeir.com/accept-invite?token=${token}`;

  assert.equal(
    normalizeRegistrationInvitationUrl(expected,'https://odeir.com'),
    expected
  );
  assert.equal(
    normalizeRegistrationInvitationUrl(expected,'https://www.odeir.com'),
    expected,
    'the canonical production hosts may hand off the same invitation'
  );
  assert.equal(
    normalizeRegistrationInvitationUrl(
      `http://localhost:3000/accept-invite?token=${token}`,
      'http://localhost:3000'
    ),
    `http://localhost:3000/accept-invite?token=${token}`
  );

  for(const unsafe of [
    `https://evil.example/accept-invite?token=${token}`,
    `http://odeir.com/accept-invite?token=${token}`,
    `https://odeir.com/accept-invite?token=short`,
    `https://odeir.com/accept-invite?token=${token}&source=whatsapp`,
    `https://odeir.com/accept-invite?token=${token}#copy`,
    `https://odeir.com/login?token=${token}`
  ])assert.equal(
    normalizeRegistrationInvitationUrl(unsafe,'https://odeir.com'),
    '',
    unsafe
  );
});

test('activation UI presents a secure copy handoff without persisting the token',async()=>{
  const component=await read('components/platform-registration-requests.js');

  assert.match(component,/buildRegistrationOwnerWhatsAppMessage/);
  assert.match(component,/نسخ رسالة واتساب/);
  assert.match(component,/نسخ رابط التفعيل فقط/);
  assert.match(component,/فتح المنشأة في نافذة جديدة/);
  assert.match(component,/target="_blank"/);
  assert.match(component,/rel="noopener noreferrer"/);
  assert.match(component,/تم، العودة لطلبات التسجيل/);
  assert.match(component,/inert=\{blockingOverlay\}/);
  assert.doesNotMatch(component,/wa\.me|localStorage|sessionStorage/);
});

test('registration API strips raw tokens and disables caching of invitation responses',async()=>{
  const route=await read('app/api/platform/registration-requests/route.js');

  assert.match(route,/delete safeOwner\.invitationToken/);
  assert.match(route,/\^\[0-9a-f\]\{64\}\$/i);
  assert.match(route,/private, no-store, no-cache, max-age=0, must-revalidate/);
  assert.match(route,/Vercel-CDN-Cache-Control','no-store/);
  assert.match(route,/Referrer-Policy','no-referrer/);
});
