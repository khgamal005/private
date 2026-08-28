begin;

-- The registration Edge Function has completed its v4 rollout. Remove the
-- temporary service-role compatibility grants so every external submit must
-- pass the versioned legal-consent wrapper and its atomic receipt ledger.
revoke execute on function public.v2_public_submit_registration_request(
  jsonb,text,text
) from service_role;

revoke execute on function public.v3_public_submit_registration_request(
  jsonb,text,text,text,boolean
) from service_role;

-- v4 is SECURITY DEFINER and all three functions share the postgres owner, so
-- its internal v2/v3 calls remain available while direct service-role calls do
-- not. Reassert the sole supported Edge entry point explicitly.
revoke all on function public.v4_public_submit_registration_request(
  jsonb,text,text,text,boolean
) from public,anon,authenticated,service_role;
grant execute on function public.v4_public_submit_registration_request(
  jsonb,text,text,text,boolean
) to service_role;

comment on function public.v4_public_submit_registration_request(
  jsonb,text,text,text,boolean
) is
  'Sole service-role registration submit entry point; atomically records the versioned legal-consent receipt.';

commit;
