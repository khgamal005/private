CREATE OR REPLACE FUNCTION private_app.campaign_cash_v1(p_tenant uuid)
 RETURNS TABLE(event_key text, contact_id uuid, opportunity_id uuid, occurred_at timestamp with time zone, amount_minor bigint, currency text, kind text, handoff_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
 select 'handoff:'||h.id,h.contact_id,h.opportunity_id,h.payment_verified_at,h.payment_amount_minor,
  coalesce(nullif(h.metadata->>'currency',''),'SAR'),'collection',h.id
 from academy.registration_handoffs h where h.tenant_id=p_tenant and h.payment_status='verified' and h.payment_verified_at is not null
  and h.payment_amount_minor>0 and not exists(select 1 from accounting_core.payments p
   where p.tenant_id=p_tenant and p.source_type='registration_handoff' and p.source_id=h.id::text and p.status in ('verified','refunded'))
 union all
 select 'payment:'||p.id,a.contact_id,h.opportunity_id,coalesce(h.payment_verified_at,p.verified_at),p.amount_minor,p.currency,'collection',h.id
 from accounting_core.payments p join accounting_core.customer_accounts a on a.tenant_id=p_tenant and a.id=p.customer_account_id
 left join academy.registration_handoffs h on h.tenant_id=p_tenant and p.source_type='registration_handoff' and p.source_id=h.id::text
 where p.tenant_id=p_tenant and p.status in ('verified','refunded') and p.verified_at is not null
  and (p.source_type is distinct from 'registration_handoff' or (h.payment_status='verified' and h.payment_verified_at is not null))
 union all
 select 'refund:'||r.id,a.contact_id,h.opportunity_id,r.completed_at,-r.amount_minor,p.currency,'refund',h.id
 from accounting_core.refunds r join accounting_core.payments p on p.tenant_id=p_tenant and p.id=r.payment_id
 join accounting_core.customer_accounts a on a.tenant_id=p_tenant and a.id=p.customer_account_id
 left join academy.registration_handoffs h on h.tenant_id=p_tenant and p.source_type='registration_handoff' and p.source_id=h.id::text
 where r.tenant_id=p_tenant and r.status='completed' and r.completed_at is not null;
$function$
;
CREATE OR REPLACE FUNCTION public.v1_tenant_accounting_snapshot(p_slug text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant core.tenants%rowtype;
  v_from date:=coalesce(p_from,date_trunc('month',current_date)::date);
  v_to date:=coalesce(p_to,current_date);
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if v_from>v_to or v_to-v_from>1095 then raise exception 'invalid_date_range'; end if;
  select * into v_tenant from core.tenants
  where slug=p_slug and status in ('trial','active') limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.read') then
    raise exception 'forbidden' using errcode='42501';
  end if;

  return jsonb_build_object(
    'schemaVersion',1,'generatedAt',now(),'tenantId',v_tenant.id,
    'period',jsonb_build_object('from',v_from,'to',v_to),
    'viewer',jsonb_build_object(
      'canRead',true,
      'canManageCustomers',private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.customers.write'),
      'canWriteQuotes',private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.quotes.write'),
      'canWriteInvoices',private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.invoices.write'),
      'canIssueInvoices',private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.invoices.issue'),
      'canRecordPayments',private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.payments.record'),
      'canApprovePayments',private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.payments.approve'),
      'canRequestRefunds',private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.refunds.request'),
      'canApproveRefunds',private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.refunds.approve'),
      'canReadReports',private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.reports.read'),
      'canManageSettings',private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.settings.manage')
    ),
    'profile',coalesce((
      select jsonb_strip_nulls(jsonb_build_object(
        'legalNameAr',profile.legal_name_ar,
        'commercialRegistrationNumber',profile.commercial_registration_number,
        'vatNumber',profile.vat_number,'taxRegistered',profile.tax_registered,
        'baseCurrency',profile.base_currency,'timezone',profile.timezone,
        'defaultPaymentTermsDays',profile.default_payment_terms_days,
        'defaultTaxRateBps',profile.default_tax_rate_bps,
        'quotePrefix',profile.quote_prefix,'invoicePrefix',profile.invoice_prefix,
        'creditNotePrefix',profile.credit_note_prefix,
        'debitNotePrefix',profile.debit_note_prefix,
        'receiptPrefix',profile.receipt_prefix,
        'autoImportVerifiedAdmissions',profile.auto_import_verified_admissions
      )) from accounting_core.tenant_profiles profile
      where profile.tenant_id=v_tenant.id
    ),jsonb_build_object(
      'legalNameAr',coalesce(v_tenant.legal_name,v_tenant.name),
      'taxRegistered',false,'baseCurrency','SAR','timezone',v_tenant.timezone,
      'defaultPaymentTermsDays',0,'defaultTaxRateBps',1500,
      'quotePrefix','Q','invoicePrefix','INV','creditNotePrefix','CN',
      'debitNotePrefix','DN','receiptPrefix','REC',
      'autoImportVerifiedAdmissions',false
    )),
    'summary',(
      with document_totals as(
        select
          coalesce(sum(case when document_type in ('invoice','debit_note') then total_minor when document_type='credit_note' then -total_minor else 0 end),0)::bigint net_invoiced,
          coalesce(sum(case when document_type in ('invoice','debit_note') then tax_minor when document_type='credit_note' then -tax_minor else 0 end),0)::bigint tax_invoiced
        from accounting_core.sales_documents
        where tenant_id=v_tenant.id and status='issued'
          and issue_date between v_from and v_to
      ), payment_totals as(
        select coalesce(sum(amount_minor),0)::bigint collected
        from accounting_core.payments
        where tenant_id=v_tenant.id and status in ('verified','refunded')
          and received_at::date between v_from and v_to
      ), refund_totals as(
        select coalesce(sum(amount_minor),0)::bigint refunded
        from accounting_core.refunds
        where tenant_id=v_tenant.id and status='completed'
          and completed_at::date between v_from and v_to
      ), invoice_balances as(
        select document.id,document.due_date,
          greatest(document.total_minor-coalesce(sum(allocation.amount_minor),0),0)::bigint outstanding
        from accounting_core.sales_documents document
        left join accounting_core.payment_allocations allocation
          on allocation.tenant_id=document.tenant_id and allocation.invoice_id=document.id
        where document.tenant_id=v_tenant.id and document.status='issued'
          and document.document_type in ('invoice','debit_note')
        group by document.id,document.due_date,document.total_minor
      )
      select jsonb_build_object(
        'netInvoicedMinor',document_totals.net_invoiced,
        'taxInvoicedMinor',document_totals.tax_invoiced,
        'collectedMinor',payment_totals.collected-refund_totals.refunded,
        'refundedMinor',refund_totals.refunded,
        'outstandingMinor',coalesce(sum(invoice_balances.outstanding),0)::bigint,
        'overdueMinor',coalesce(sum(invoice_balances.outstanding) filter(where invoice_balances.due_date<current_date),0)::bigint,
        'pendingPayments',(
          select count(*) from accounting_core.payments
          where tenant_id=v_tenant.id and status='pending_verification'
        ),
        'pendingRefunds',(
          select count(*) from accounting_core.refunds
          where tenant_id=v_tenant.id and status in ('requested','approved')
        ),
        'dueIncentivesMinor',(
          select coalesce(round(sum(incentive_amount)*100),0)::bigint
          from incentives_core.events
          where tenant_id=v_tenant.id and state in ('due','approved')
        )
      )
      from document_totals,payment_totals,refund_totals
      left join invoice_balances on true
      group by document_totals.net_invoiced,document_totals.tax_invoiced,
        payment_totals.collected,refund_totals.refunded
    ),
    'aging',(
      with balances as(
        select document.due_date,
          greatest(document.total_minor-coalesce(sum(allocation.amount_minor),0),0)::bigint amount
        from accounting_core.sales_documents document
        left join accounting_core.payment_allocations allocation
          on allocation.tenant_id=document.tenant_id and allocation.invoice_id=document.id
        where document.tenant_id=v_tenant.id and document.status='issued'
          and document.document_type in ('invoice','debit_note')
        group by document.id,document.due_date,document.total_minor
      ) select jsonb_build_object(
        'current',coalesce(sum(amount) filter(where due_date>=current_date),0)::bigint,
        'days1to30',coalesce(sum(amount) filter(where current_date-due_date between 1 and 30),0)::bigint,
        'days31to60',coalesce(sum(amount) filter(where current_date-due_date between 31 and 60),0)::bigint,
        'days61to90',coalesce(sum(amount) filter(where current_date-due_date between 61 and 90),0)::bigint,
        'over90',coalesce(sum(amount) filter(where current_date-due_date>90),0)::bigint
      ) from balances
    ),
    'accounts',coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id',account.id,'accountNumber',account.account_number,
        'contactId',account.contact_id,'displayName',account.display_name,
        'organizationName',account.organization_name,'billingEmail',account.billing_email,
        'billingPhone',account.billing_phone,'taxNumber',account.tax_number,
        'billingAddress',account.billing_address,'paymentTermsDays',account.payment_terms_days,
        'creditLimitMinor',account.credit_limit_minor,'status',account.status,
        'invoicedMinor',coalesce(balance.invoiced,0),
        'creditNotesMinor',coalesce(balance.credits,0),
        'collectedMinor',coalesce(balance.allocated,0),
        'refundedMinor',coalesce(balance.refunded,0),
        'balanceMinor',coalesce(balance.invoiced,0)-coalesce(balance.credits,0)-coalesce(balance.allocated,0)+coalesce(balance.refunded,0),
        'updatedAt',account.updated_at
      )) order by account.display_name)
      from accounting_core.customer_accounts account
      left join lateral(
        select
          coalesce(sum(document.total_minor) filter(where document.status='issued' and document.document_type in ('invoice','debit_note')),0)::bigint invoiced,
          coalesce(sum(document.total_minor) filter(where document.status='issued' and document.document_type='credit_note'),0)::bigint credits,
          (select coalesce(sum(allocation.amount_minor),0)::bigint
           from accounting_core.payment_allocations allocation
           join accounting_core.payments payment on payment.tenant_id=allocation.tenant_id and payment.id=allocation.payment_id
           where allocation.tenant_id=account.tenant_id and payment.customer_account_id=account.id) allocated,
          (select coalesce(sum(refund.amount_minor),0)::bigint
           from accounting_core.refunds refund
           where refund.tenant_id=account.tenant_id and refund.customer_account_id=account.id and refund.status='completed') refunded
        from accounting_core.sales_documents document
        where document.tenant_id=account.tenant_id and document.customer_account_id=account.id
      ) balance on true
      where account.tenant_id=v_tenant.id
    ),'[]'::jsonb),
    'customerCandidates',coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id',candidate.id,'name',candidate.full_name,
        'organizationName',candidate.organization_name,'phone',candidate.phone,
        'email',candidate.email
      )) order by candidate.full_name)
      from(
        select contact.* from sales_core.contacts contact
        where contact.tenant_id=v_tenant.id and contact.status='active'
          and not exists(
            select 1 from accounting_core.customer_accounts account
            where account.tenant_id=contact.tenant_id and account.contact_id=contact.id
          )
        order by contact.updated_at desc limit 200
      ) candidate
    ),'[]'::jsonb),
    'documents',coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id',document.id,'type',document.document_type,
        'number',document.document_number,'revisionNumber',document.revision_number,
        'status',document.status,'customerAccountId',document.customer_account_id,
        'customerName',document.customer_name_snapshot,'parentDocumentId',document.parent_document_id,
        'sourceType',document.source_type,'sourceId',document.source_id,
        'issueDate',document.issue_date,'validUntil',document.valid_until,'dueDate',document.due_date,
        'currency',document.currency,'subtotalMinor',document.subtotal_minor,
        'discountMinor',document.discount_minor,'taxMinor',document.tax_minor,
        'totalMinor',document.total_minor,'allocatedMinor',coalesce(document.allocated_minor,0),
        'outstandingMinor',case when document.document_type in ('invoice','debit_note')
          then greatest(document.total_minor-coalesce(document.allocated_minor,0),0) else 0 end,
        'paymentStatus',case
          when document.document_type not in ('invoice','debit_note') then null
          when document.total_minor<=coalesce(document.allocated_minor,0) then 'paid'
          when coalesce(document.allocated_minor,0)>0 then 'partially_paid'
          when document.status='issued' and document.due_date<current_date then 'overdue'
          else 'unpaid' end,
        'notes',document.notes,'terms',document.terms,
        'issuedAt',document.issued_at,'createdAt',document.created_at,
        'lines',document.lines
      )) order by document.created_at desc)
      from(
        select header.*,
          (select coalesce(sum(allocation.amount_minor),0)::bigint
           from accounting_core.payment_allocations allocation
           where allocation.tenant_id=header.tenant_id and allocation.invoice_id=header.id) allocated_minor,
          (select coalesce(jsonb_agg(jsonb_build_object(
            'id',line.id,'position',line.position,'itemType',line.item_type,
            'description',line.description,'quantity',line.quantity,
            'unitAmountMinor',line.unit_amount_minor,'subtotalMinor',line.subtotal_minor,
            'discountMinor',line.discount_minor,'taxCategory',line.tax_category,
            'taxRateBps',line.tax_rate_bps,'taxMinor',line.tax_minor,
            'totalMinor',line.total_minor
          ) order by line.position),'[]'::jsonb)
           from accounting_core.sales_document_lines line
           where line.tenant_id=header.tenant_id and line.document_id=header.id) lines
        from accounting_core.sales_documents header
        where header.tenant_id=v_tenant.id
        order by header.created_at desc limit 500
      ) document
    ),'[]'::jsonb),
    'payments',coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id',payment.id,'number',payment.payment_number,
        'customerAccountId',payment.customer_account_id,
        'customerName',account.display_name,'amountMinor',payment.amount_minor,
        'allocatedMinor',coalesce(allocation.amount,0),
        'unallocatedMinor',greatest(payment.amount_minor-coalesce(allocation.amount,0)-coalesce(refund.amount,0),0),
        'currency',payment.currency,'method',payment.method,'status',payment.status,
        'externalReference',payment.external_reference,'sourceType',payment.source_type,
        'sourceId',payment.source_id,'receivedAt',payment.received_at,
        'verifiedAt',payment.verified_at,'rejectionReason',payment.rejection_reason,
        'receipt',case when receipt.id is null then null else jsonb_build_object(
          'id',receipt.id,'number',receipt.receipt_number,'issuedAt',receipt.issued_at
        ) end
      )) order by payment.received_at desc)
      from accounting_core.payments payment
      join accounting_core.customer_accounts account
        on account.tenant_id=payment.tenant_id and account.id=payment.customer_account_id
      left join lateral(
        select coalesce(sum(amount_minor),0)::bigint amount
        from accounting_core.payment_allocations
        where tenant_id=payment.tenant_id and payment_id=payment.id
      ) allocation on true
      left join lateral(
        select coalesce(sum(amount_minor),0)::bigint amount
        from accounting_core.refunds
        where tenant_id=payment.tenant_id and payment_id=payment.id and status='completed'
      ) refund on true
      left join accounting_core.receipts receipt
        on receipt.tenant_id=payment.tenant_id and receipt.payment_id=payment.id
      where payment.tenant_id=v_tenant.id
    ),'[]'::jsonb),
    'paymentSchedules',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',schedule.id,'invoiceId',schedule.invoice_id,
        'installmentNumber',schedule.installment_number,
        'dueDate',schedule.due_date,'amountMinor',schedule.amount_minor,
        'label',schedule.label
      ) order by schedule.due_date,schedule.installment_number)
      from accounting_core.payment_schedules schedule
      where schedule.tenant_id=v_tenant.id
    ),'[]'::jsonb),
    'collections',coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id',action.id,'customerAccountId',action.customer_account_id,
        'invoiceId',action.invoice_id,'type',action.action_type,
        'summary',action.summary,'promisedDate',action.promised_date,
        'promisedAmountMinor',action.promised_amount_minor,
        'nextActionAt',action.next_action_at,'createdAt',action.created_at
      )) order by action.created_at desc)
      from(
        select * from accounting_core.collection_actions
        where tenant_id=v_tenant.id order by created_at desc limit 200
      ) action
    ),'[]'::jsonb),
    'refunds',coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id',refund.id,'customerAccountId',refund.customer_account_id,
        'paymentId',refund.payment_id,'invoiceId',refund.invoice_id,
        'creditNoteId',refund.credit_note_id,'amountMinor',refund.amount_minor,
        'reason',refund.reason,'status',refund.status,
        'externalReference',refund.external_reference,
        'approvedAt',refund.approved_at,'completedAt',refund.completed_at,
        'createdAt',refund.created_at
      )) order by refund.created_at desc)
      from accounting_core.refunds refund where refund.tenant_id=v_tenant.id
    ),'[]'::jsonb),
    'incentives',(
      select jsonb_build_object(
        'source','incentives_core.events','currency','SAR','sourceAmountUnit','major',
        'expectedMinor',coalesce(round(sum(incentive_amount) filter(where state='expected')*100),0)::bigint,
        'pendingMinor',coalesce(round(sum(incentive_amount) filter(where state='pending')*100),0)::bigint,
        'dueMinor',coalesce(round(sum(incentive_amount) filter(where state='due')*100),0)::bigint,
        'approvedMinor',coalesce(round(sum(incentive_amount) filter(where state='approved')*100),0)::bigint,
        'paidMinor',coalesce(round(sum(incentive_amount) filter(where state='paid')*100),0)::bigint,
        'refundedMinor',coalesce(round(sum(incentive_amount) filter(where state='refunded')*100),0)::bigint,
        'counts',jsonb_build_object(
          'expected',count(*) filter(where state='expected'),
          'pending',count(*) filter(where state='pending'),
          'due',count(*) filter(where state='due'),
          'approved',count(*) filter(where state='approved'),
          'paid',count(*) filter(where state='paid')
        )
      ) from incentives_core.events where tenant_id=v_tenant.id
    ),
    'admissionPaymentInbox',coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id',handoff.id,'contactId',handoff.contact_id,
        'amountMinor',handoff.payment_amount_minor,
        'reference',handoff.payment_reference,'status',handoff.payment_status,
        'reportedAt',handoff.payment_reported_at,
        'verifiedAt',handoff.payment_verified_at,
        'canImport',handoff.payment_status='verified'
          and handoff.payment_verified_at is not null
          and handoff.payment_amount_minor>0
      )) order by handoff.payment_reported_at desc)
      from(
        select item.* from academy.registration_handoffs item
        where item.tenant_id=v_tenant.id
          and item.payment_status in ('pending_verification','verified')
          and not exists(
            select 1 from accounting_core.payments payment
            where payment.tenant_id=item.tenant_id
              and payment.source_type='registration_handoff'
              and payment.source_id=item.id::text
          )
        order by item.payment_reported_at desc limit 100
      ) handoff
    ),'[]'::jsonb)
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.v2_tenant_admissions_snapshot(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant core.tenants%rowtype;
begin
  select *
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.admissions.read'
  ) then raise exception 'forbidden'; end if;

  return jsonb_build_object(
    'generatedAt',
    now(),
    'viewer',
    jsonb_build_object(
      'staffId',
      private_app.current_staff_id(v_tenant.id),
      'canManage',
      private_app.has_tenant_permission(
        v_tenant.id,
        'tenant.admissions.write'
      )
    ),
    'summary',
    jsonb_build_object(
      'pendingVerification',
      (
        select count(*)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.payment_status = 'pending_verification'
          and handoff.status not in ('completed', 'cancelled')
      ),
      'inReview',
      (
        select count(*)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.status = 'in_review'
      ),
      'accepted',
      (
        select count(*)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.status = 'accepted'
      ),
      'completed',
      (
        select count(*)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.status = 'completed'
      ),
      'documentsPending',
      (
        select count(*)
        from academy.registration_documents document
        join academy.registration_handoffs handoff
          on handoff.id = document.handoff_id
        where document.tenant_id = v_tenant.id
          and document.is_required
          and document.status not in ('approved', 'not_required')
          and handoff.status not in ('completed', 'cancelled', 'rejected')
      )
    ),
    'cases',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',
        handoff.id,
        'contactId',
        handoff.contact_id,
        'contactName',
        contact.full_name,
        'phone',
        contact.phone,
        'whatsapp',
        contact.whatsapp,
        'email',
        contact.email,
        'source',
        contact.source,
        'campaignName',
        contact.campaign_name,
        'salesOwnerName',
        owner.full_name,
        'courseId',
        handoff.course_id,
        'courseName',
        course.title_ar,
        'courseRunId',
        handoff.course_run_id,
        'courseRunName',
        coalesce(run.title, run.run_code),
        'runStartsAt',
        run.starts_at,
        'preferredStartDate',
        handoff.preferred_start_date,
        'status',
        handoff.status,
        'paymentStatus',
        handoff.payment_status,
        'paymentReportedAt',
        handoff.payment_reported_at,
        'paymentVerifiedAt',
        handoff.payment_verified_at,
        'paymentAmountMinor',
        handoff.payment_amount_minor,
        'paymentReference',
        handoff.payment_reference,
        'paymentRejectionReason',
        handoff.payment_rejection_reason,
        'notes',
        handoff.notes,
        'assignedStaffId',
        handoff.assigned_staff_id,
        'assignedStaffName',
        assignee.full_name,
        'acceptedAt',
        handoff.accepted_at,
        'completedAt',
        handoff.completed_at,
        'demo',
        coalesce((handoff.metadata ->> 'demo')::boolean, false),
        'documents',
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id',
            document.id,
            'type',
            document.document_type,
            'required',
            document.is_required,
            'status',
            document.status,
            'fileName',
            document.file_name,
            'notes',
            document.notes,
            'reviewedAt',
            document.reviewed_at
          ) order by document.is_required desc, document.document_type)
          from academy.registration_documents document
          where document.handoff_id = handoff.id
        ), '[]'::jsonb),
        'enrollment',
        (
          select jsonb_build_object(
            'id',
            enrollment.id,
            'studentId',
            student.id,
            'studentNumber',
            student.student_number,
            'status',
            enrollment.status,
            'enrolledAt',
            enrollment.enrolled_at
          )
          from academy.enrollments enrollment
          join academy.students student on student.id = enrollment.student_id
          where enrollment.handoff_id = handoff.id
          limit 1
        )
      ) order by
        case handoff.payment_status
          when 'pending_verification' then 0
          when 'verified' then 1
          when 'rejected' then 2
          else 3
        end,
        handoff.payment_reported_at desc
      )
      from academy.registration_handoffs handoff
      join sales_core.contacts contact on contact.id = handoff.contact_id
      join academy.courses course on course.id = handoff.course_id
      left join academy.course_runs run on run.id = handoff.course_run_id
      left join people.staff_profiles owner
        on owner.id = contact.owner_staff_id
      left join people.staff_profiles assignee
        on assignee.id = handoff.assigned_staff_id
      where handoff.tenant_id = v_tenant.id
    ), '[]'::jsonb),
    'staff',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',
        staff.id,
        'name',
        staff.full_name,
        'roleKey',
        staff.role_key,
        'department',
        department.name_ar
      ) order by staff.full_name)
      from people.staff_profiles staff
      left join people.departments department
        on department.id = staff.department_id
      where staff.tenant_id = v_tenant.id
        and staff.employment_status = 'active'
        and (
          department.department_key = 'admissions'
          or staff.role_key in (
            'customer_service',
            'tenant_admin',
            'executive_manager'
          )
        )
    ), '[]'::jsonb),
    'courses',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',
        course.id,
        'courseCode',
        course.course_code,
        'nameAr',
        course.title_ar,
        'status',
        course.status
      ) order by course.title_ar)
      from academy.courses course
      where course.tenant_id = v_tenant.id
        and course.status = 'active'
    ), '[]'::jsonb),
    'courseRuns',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',
        run.id,
        'courseId',
        run.course_id,
        'runCode',
        run.run_code,
        'title',
        coalesce(run.title, course.title_ar),
        'startsAt',
        run.starts_at,
        'endsAt',
        run.ends_at,
        'capacity',
        run.capacity,
        'enrolledCount',
        run.enrolled_count,
        'status',
        run.status
      ) order by run.starts_at nulls last, run.created_at)
      from academy.course_runs run
      join academy.courses course on course.id = run.course_id
      where run.tenant_id = v_tenant.id
        and run.status in ('planning', 'open', 'in_progress')
    ), '[]'::jsonb)
  );
end;
$function$
;
