-- Add-on platform v3 follow-up: make all date-only catalog decisions use the
-- platform business timezone. A Cairo midnight is the previous UTC date during
-- daylight saving time and must not select the wrong annual price version.

begin;

alter function public.v3_platform_addon_center_action(text, jsonb)
  set timezone to 'Africa/Cairo';

comment on function public.v3_platform_addon_center_action(text, jsonb) is
  'Hardened v3 action gateway. Date-only pricing decisions use Africa/Cairo; grants require tenantId and never accept protected lifecycle overrides.';

commit;
