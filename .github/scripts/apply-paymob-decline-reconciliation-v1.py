from __future__ import annotations

from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one target, found {count}")
    return text.replace(old, new, 1)


def patch_reconciler() -> None:
    path = Path("supabase/functions/paymob-reconcile/index.ts")
    text = path.read_text(encoding="utf-8")

    text = replace_once(
        text,
        """    const authorized = await authorizeDispatcher(
      request,
      supabaseUrl,
      anonKey,
    );""",
        """    const authorized = await authorizeDispatcher(
      request,
      supabaseUrl,
      anonKey,
      serviceRoleKey,
    );""",
        "dispatcher call",
    )

    text = replace_once(
        text,
        """async function authorizeDispatcher(
  request: Request,
  supabaseUrl: string,
  anonKey: string,
): Promise<boolean> {""",
        """async function authorizeDispatcher(
  request: Request,
  supabaseUrl: string,
  anonKey: string,
  serviceRoleKey: string,
): Promise<boolean> {""",
        "dispatcher signature",
    )

    old_auth = """  const configuredSecret = Deno.env.get(
    \"PAYMOB_RECONCILE_DISPATCHER_SECRET\",
  )?.trim() ?? \"\";
  const suppliedSecret = request.headers.get(
    \"x-odeir-paymob-reconcile-secret\",
  )?.trim() ?? \"\";

  if (
    configuredSecret.length >= 32 &&
    configuredSecret.length <= 1024 &&
    suppliedSecret.length >= 32 &&
    suppliedSecret.length <= 1024 &&
    await secretEqual(configuredSecret, suppliedSecret)
  ) return true;
"""
    new_auth = """  const configuredSecret = Deno.env.get(
    \"PAYMOB_RECONCILE_DISPATCHER_SECRET\",
  )?.trim() ?? \"\";
  const suppliedSecret = request.headers.get(
    \"x-odeir-paymob-reconcile-secret\",
  )?.trim() ?? \"\";

  if (suppliedSecret.length >= 32 && suppliedSecret.length <= 1024) {
    if (
      configuredSecret.length >= 32 &&
      configuredSecret.length <= 1024 &&
      await secretEqual(configuredSecret, suppliedSecret)
    ) return true;

    // The scheduler keeps its random dispatcher secret in Vault. Fetch it
    // only for a syntactically valid scheduled call, compare it timing-safely
    // in request-scoped memory, and never log or return it to the caller.
    try {
      const stored = await serviceRpc(
        supabaseUrl,
        serviceRoleKey,
        \"v1_service_paymob_reconcile_dispatch_secret\",
        {},
      );
      const allowedKeys = new Set([\"schemaVersion\", \"dispatcherSecret\"]);
      if (
        stored.schemaVersion === 1 &&
        Object.keys(stored).every((key) => allowedKeys.has(key))
      ) {
        const vaultSecret = requiredText(
          stored.dispatcherSecret,
          \"dispatcher_secret\",
          1024,
        );
        if (
          vaultSecret.length >= 32 &&
          await secretEqual(vaultSecret, suppliedSecret)
        ) return true;
      }
    } catch {
      // Continue to the independently authorized administrator path.
    }
  }
"""
    text = replace_once(text, old_auth, new_auth, "dispatcher auth")
    path.write_text(text, encoding="utf-8")


def patch_status_route() -> None:
    path = Path("app/api/payments/paymob/status/route.js")
    text = path.read_text(encoding="utf-8")

    text = replace_once(
        text,
        "const PAYMENT_STATUSES=new Set(['pending','paid','failed','refunded','waived']);\n",
        """const PAYMENT_STATUSES=new Set(['pending','paid','failed','refunded','waived']);
const RESULT_CODES=new Set([
  'paid','review_required','issuer_declined_retry_available',
  'payment_expired','payment_failed','payment_cancelled'
]);
""",
        "status result-code allowlist",
    )

    old = """    const terminal=result.terminal===true;
    return json({
      attemptId:safeUuid(result.attemptId)||attemptId,
      orderId:safeUuid(result.orderId),
      orderNumber:safeString(result.orderNumber,80),
      orderKind:['addon','service'].includes(result.orderKind)?result.orderKind:null,
      attemptStatus,
      orderStatus,
      paymentStatus,
      terminal,
      refreshAfterMs:terminal?null:safeRefresh(result.refreshAfterMs)
    });"""
    new = """    const terminal=result.terminal===true;
    const resultCode=safeEnum(result.resultCode,RESULT_CODES,null);
    const retryAllowed=resultCode==='issuer_declined_retry_available'
      &&result.retryAllowed===true;
    return json({
      attemptId:safeUuid(result.attemptId)||attemptId,
      orderId:safeUuid(result.orderId),
      orderNumber:safeString(result.orderNumber,80),
      orderKind:['addon','service'].includes(result.orderKind)?result.orderKind:null,
      attemptStatus,
      orderStatus,
      paymentStatus,
      terminal,
      resultCode,
      retryAllowed,
      refreshAfterMs:terminal||resultCode==='issuer_declined_retry_available'
        ?null
        :safeRefresh(result.refreshAfterMs)
    });"""
    text = replace_once(text, old, new, "status response")
    path.write_text(text, encoding="utf-8")


def patch_return_ui() -> None:
    path = Path("components/paymob-return-status.js")
    text = path.read_text(encoding="utf-8")

    text = replace_once(
        text,
        """        if(result.paymentStatus==='paid'){
          setPhase('paid');
          return;
        }
        if(result.attemptStatus==='quarantined'){""",
        """        if(result.paymentStatus==='paid'){
          setPhase('paid');
          return;
        }
        if(result.resultCode==='issuer_declined_retry_available'){
          setPhase('declined');
          return;
        }
        if(result.attemptStatus==='quarantined'){""",
        "decline phase transition",
    )

    text = replace_once(
        text,
        """        {phase==='paused'&&<button type=\"button\" onClick={()=>setRetryCycle(value=>value+1)}>تحقق مرة أخرى</button>}""",
        """        {['paused','declined'].includes(phase)&&<button type=\"button\" onClick={()=>setRetryCycle(value=>value+1)}>{phase==='declined'?'تحقق بعد إعادة المحاولة':'تحقق مرة أخرى'}</button>}""",
        "decline recheck button",
    )

    text = replace_once(
        text,
        """function paymentResultContent(phase,snapshot,message){
  if(phase==='paid')return {""",
        """function paymentResultContent(phase,snapshot,message){
  if(phase==='declined')return {
    tone:'failed',icon:'×',title:'رفض البنك عملية الدفع',
    description:snapshot?.retryAllowed
      ?'لم يعتمد أودير أي دفعة ناجحة. ارجع إلى الطلب واضغط «استكمال الدفع» لتجربة بطاقة أخرى داخل صفحة Paymob الآمنة؛ لا تحتاج إلى إنشاء طلب جديد.'
      :'لم يعتمد أودير أي دفعة ناجحة. انتهت صلاحية هذه المحاولة، ويمكنك العودة إلى الطلب وبدء محاولة آمنة جديدة.'
  };
  if(phase==='paid')return {""",
        "decline content",
    )
    path.write_text(text, encoding="utf-8")


def write_tests() -> None:
    path = Path("tests/paymob-decline-reconciliation-v1.test.mjs")
    path.write_text(
        r"""import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const migration=readFileSync(
  'supabase/migrations/20260905213000_paymob_decline_reconciliation_v1.sql',
  'utf8'
);
const reconciler=readFileSync('supabase/functions/paymob-reconcile/index.ts','utf8');
const statusRoute=readFileSync('app/api/payments/paymob/status/route.js','utf8');
const returnUi=readFileSync('components/paymob-return-status.js','utf8');

test('every durable QuickLink receives one bounded read-only inquiry job',()=>{
  assert.match(migration,/after insert or update of status,provider_order_id/i);
  assert.match(migration,/new\.checkout_flow <> 'quicklink'/i);
  assert.match(migration,/new\.status <> 'intention_created'/i);
  assert.match(migration,/reconciliation_type[\s\S]*?'transaction_inquiry'/i);
  assert.match(migration,/now\(\) \+ interval '30 seconds'/i);
  assert.match(migration,/max_attempts[\s\S]*?10/i);
  assert.match(migration,/on conflict \(attempt_id,reconciliation_type\) do update/i);
  const triggerBody=migration.slice(
    migration.indexOf('create or replace function private_app.paymob_queue_quicklink_reconciliation_v1'),
    migration.indexOf('drop trigger if exists paymob_queue_quicklink_reconciliation_v1')
  );
  assert.doesNotMatch(triggerBody,/update\s+marketplace\.orders/i);
});

test('scheduler secret stays Vault-backed and cron dispatch is minute-bounded',()=>{
  assert.match(migration,/vault\.create_secret/i);
  assert.match(migration,/paymob_reconcile_dispatcher_v1/);
  assert.match(migration,/v1_service_paymob_reconcile_dispatch_secret/);
  assert.match(migration,/coalesce\(auth\.jwt\(\) ->> 'role',''\) <> 'service_role'/i);
  assert.match(migration,/net\.http_post/i);
  assert.match(migration,/x-odeir-paymob-reconcile-secret/i);
  assert.match(migration,/cron\.schedule[\s\S]*?'\* \* \* \* \*'/i);
  assert.doesNotMatch(migration,/PAYMOB_RECONCILE_DISPATCHER_SECRET\s*=/i);
});

test('reconciler validates the Vault secret timing-safely and keeps admin fallback',()=>{
  assert.match(reconciler,/v1_service_paymob_reconcile_dispatch_secret/);
  assert.match(reconciler,/serviceRoleKey/);
  assert.match(reconciler,/allowedKeys = new Set\(\["schemaVersion", "dispatcherSecret"\]\)/);
  assert.match(reconciler,/secretEqual\(vaultSecret, suppliedSecret\)/);
  assert.match(reconciler,/v3_platform_payment_provider_admin_snapshot/);
  assert.doesNotMatch(reconciler,/console\.(?:log|info|debug)[^\n]*dispatcherSecret/i);
});

test('browser receives only a safe decline classification and no provider text',()=>{
  assert.match(statusRoute,/RESULT_CODES/);
  assert.match(statusRoute,/issuer_declined_retry_available/);
  assert.match(statusRoute,/retryAllowed/);
  assert.doesNotMatch(statusRoute,/lastErrorCode\s*:/);
  assert.doesNotMatch(statusRoute,/providerResponse|do not honour/i);
});

test('return page stops noisy polling and gives one simple recovery path',()=>{
  assert.match(returnUi,/setPhase\('declined'\)/);
  assert.match(returnUi,/رفض البنك عملية الدفع/);
  assert.match(returnUi,/استكمال الدفع/);
  assert.match(returnUi,/لا تحتاج إلى إنشاء طلب جديد/);
  assert.match(returnUi,/\['paused','declined'\]\.includes\(phase\)/);
  assert.doesNotMatch(returnUi,/window\.location|fetch\('\/api\/payments\/paymob\/checkout/);
});
""",
        encoding="utf-8",
    )


patch_reconciler()
patch_status_route()
patch_return_ui()
write_tests()
