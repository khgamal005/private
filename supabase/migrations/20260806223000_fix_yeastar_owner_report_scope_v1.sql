-- Keep tenant-wide Yeastar reports visible for owners without a staff profile.
begin;

CREATE OR REPLACE FUNCTION private_app.yeastar_reports_snapshot_core_v2(p_slug text, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_extension text DEFAULT NULL::text, p_call_type text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant core.tenants%rowtype;
  v_connection communication_hub.provider_connections%rowtype;
  v_from timestamptz := coalesce(p_from, date_trunc('day', now()) - interval '29 days');
  v_to timestamptz := coalesce(p_to, now());
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_current_staff_id uuid;
  v_role_key text;
  v_personal_only boolean := false;
  v_is_platform boolean := false;
  v_can_manage boolean := false;
  v_staff_extensions text[] := '{}'::text[];
begin
  select * into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not (
    private_app.has_tenant_permission(v_tenant.id, 'tenant.crm.read')
    or private_app.has_tenant_permission(
      v_tenant.id,
      'tenant.settings.manage'
    )
  ) then raise exception 'forbidden'; end if;
  if v_from >= v_to or v_to - v_from > interval '366 days' then
    raise exception 'invalid_report_period';
  end if;

  select * into v_connection
  from communication_hub.provider_connections connection
  where connection.tenant_id = v_tenant.id
    and connection.provider_key = 'yeastar_p550'
  limit 1;

  v_is_platform :=
    private_app.has_platform_permission('platform.tenants.read');
  v_can_manage := (
    private_app.has_tenant_permission(
      v_tenant.id,
      'tenant.settings.manage'
    )
    or v_is_platform
  );
  v_current_staff_id := private_app.current_staff_id(v_tenant.id);

  select staff.role_key
  into v_role_key
  from people.staff_profiles staff
  where staff.id = v_current_staff_id
    and staff.tenant_id = v_tenant.id
    and staff.employment_status = 'active'
  limit 1;

  v_personal_only := (
    not v_is_platform
    and coalesce(
      v_role_key in (
        'sales_user',
        'sales_supervisor',
        'data_officer',
        'data_analyst'
      ),
      false
    )
  );

  if v_personal_only then
    if v_current_staff_id is null then
      raise exception 'staff_profile_required';
    end if;

    select coalesce(array_agg(mapping.key order by mapping.key), '{}'::text[])
    into v_staff_extensions
    from jsonb_each_text(
      coalesce(
        v_connection.public_config -> 'extensionAssignments',
        '{}'::jsonb
      )
    ) mapping
    where mapping.value = v_current_staff_id::text;

    if p_extension is not null
       and not (p_extension = any(v_staff_extensions)) then
      raise exception 'forbidden';
    end if;
  end if;

  return jsonb_build_object(
    'generatedAt', now(),
    'period', jsonb_build_object('from', v_from, 'to', v_to),
    'viewer', jsonb_build_object(
      'staffId', v_current_staff_id,
      'roleKey', v_role_key,
      'personalOnly', v_personal_only,
      'canManage', v_can_manage,
      'extensions', to_jsonb(v_staff_extensions)
    ),
    'connection', jsonb_build_object(
      'configured', v_connection.id is not null,
      'status', coalesce(v_connection.status, 'disabled'),
      'displayName', coalesce(v_connection.display_name, 'Yeastar P550'),
      'extensions', case
        when v_personal_only
          then array_to_string(v_staff_extensions, ',')
        else coalesce(v_connection.public_config ->> 'extensions', '')
      end,
      'lastCheckedAt', v_connection.last_checked_at,
      'lastError', v_connection.last_error
    ),
    'summary', (
      select jsonb_build_object(
        'totalCalls', count(*),
        'answeredCalls', count(*) filter (where final_status = 'ANSWERED'),
        'missedCalls', count(*) filter (
          where final_status in ('NO ANSWER', 'ABANDONED', 'BUSY')
        ),
        'failedCalls', count(*) filter (where final_status = 'FAILED'),
        'inboundCalls', count(*) filter (where call_type = 'Inbound'),
        'outboundCalls', count(*) filter (where call_type = 'Outbound'),
        'internalCalls', count(*) filter (where call_type = 'Internal'),
        'recordedCalls', count(*) filter (where has_recording),
        'answerRate',
          round(
            100.0 * count(*) filter (where final_status = 'ANSWERED')
            / nullif(count(*), 0),
            1
          ),
        'totalTalkSeconds',
          coalesce(sum(handling_duration_seconds), 0),
        'averageTalkSeconds',
          coalesce(round(avg(handling_duration_seconds))::integer, 0),
        'averageRoutingSeconds',
          coalesce(round(avg(routing_duration_seconds))::integer, 0)
      )
      from telephony.call_records record
      where record.tenant_id = v_tenant.id
        and (
          not v_personal_only
          or record.involved_extensions && v_staff_extensions
        )
        and record.started_at >= v_from
        and record.started_at < v_to
        and (
          p_extension is null
          or p_extension = any(record.involved_extensions)
        )
        and (p_call_type is null or record.call_type = p_call_type)
        and (p_status is null or record.final_status = p_status)
    ),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', day,
        'total', total,
        'answered', answered,
        'missed', missed,
        'talkSeconds', talk_seconds
      ) order by day)
      from (
        select date_trunc('day', record.started_at)::date as day,
               count(*) as total,
               count(*) filter (
                 where record.final_status = 'ANSWERED'
               ) as answered,
               count(*) filter (
                 where record.final_status
                   in ('NO ANSWER', 'ABANDONED', 'BUSY')
               ) as missed,
               coalesce(sum(record.handling_duration_seconds), 0)
                 as talk_seconds
        from telephony.call_records record
        where record.tenant_id = v_tenant.id
        and (
          not v_personal_only
          or record.involved_extensions && v_staff_extensions
        )
          and record.started_at >= v_from
          and record.started_at < v_to
          and (
            p_extension is null
            or p_extension = any(record.involved_extensions)
          )
          and (p_call_type is null or record.call_type = p_call_type)
          and (p_status is null or record.final_status = p_status)
        group by 1
      ) days
    ), '[]'::jsonb),
    'hourly', coalesce((
      select jsonb_agg(jsonb_build_object(
        'hour', hour_of_day,
        'total', total,
        'answered', answered
      ) order by hour_of_day)
      from (
        select extract(hour from record.started_at)::integer as hour_of_day,
               count(*) as total,
               count(*) filter (
                 where record.final_status = 'ANSWERED'
               ) as answered
        from telephony.call_records record
        where record.tenant_id = v_tenant.id
        and (
          not v_personal_only
          or record.involved_extensions && v_staff_extensions
        )
          and record.started_at >= v_from
          and record.started_at < v_to
          and (
            p_extension is null
            or p_extension = any(record.involved_extensions)
          )
          and (p_call_type is null or record.call_type = p_call_type)
          and (p_status is null or record.final_status = p_status)
        group by 1
      ) hours
    ), '[]'::jsonb),
    'extensions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'extension', stats.extension,
        'totalCalls', stats.total_calls,
        'answeredCalls', stats.answered_calls,
        'missedCalls', stats.missed_calls,
        'inboundCalls', stats.inbound_calls,
        'outboundCalls', stats.outbound_calls,
        'talkSeconds', stats.talk_seconds,
        'answerRate',
          round(100.0 * stats.answered_calls / nullif(stats.total_calls, 0), 1)
      ) order by stats.total_calls desc, stats.extension)
      from (
        select extension,
               count(*) as total_calls,
               count(*) filter (
                 where record.final_status = 'ANSWERED'
               ) as answered_calls,
               count(*) filter (
                 where record.final_status
                   in ('NO ANSWER', 'ABANDONED', 'BUSY')
               ) as missed_calls,
               count(*) filter (
                 where record.call_type = 'Inbound'
               ) as inbound_calls,
               count(*) filter (
                 where record.call_type = 'Outbound'
               ) as outbound_calls,
               coalesce(sum(record.handling_duration_seconds), 0)
                 as talk_seconds
        from telephony.call_records record
        cross join lateral unnest(record.involved_extensions) extension
        where record.tenant_id = v_tenant.id
        and (
          not v_personal_only
          or record.involved_extensions && v_staff_extensions
        )
          and record.started_at >= v_from
          and record.started_at < v_to
          and (
            not v_personal_only
            or extension = any(v_staff_extensions)
          )
          and (p_extension is null or extension = p_extension)
          and (p_call_type is null or record.call_type = p_call_type)
          and (p_status is null or record.final_status = p_status)
        group by extension
      ) stats
    ), '[]'::jsonb),
    'totalRecords', (
      select count(*)
      from telephony.call_records record
      where record.tenant_id = v_tenant.id
        and (
          not v_personal_only
          or record.involved_extensions && v_staff_extensions
        )
        and record.started_at >= v_from
        and record.started_at < v_to
        and (
          p_extension is null
          or p_extension = any(record.involved_extensions)
        )
        and (p_call_type is null or record.call_type = p_call_type)
        and (p_status is null or record.final_status = p_status)
    ),
    'calls', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', filtered.id,
        'uid', filtered.cdr_uid,
        'startedAt', filtered.started_at,
        'callType', filtered.call_type,
        'finalStatus', filtered.final_status,
        'callerNumber', filtered.caller_number,
        'callerName', filtered.caller_name,
        'calleeNumber', filtered.callee_number,
        'calleeName', filtered.callee_name,
        'lastParticipantNumber', filtered.last_participant_number,
        'lastParticipantName', filtered.last_participant_name,
        'extensions', filtered.involved_extensions,
        'callDurationSeconds', filtered.call_duration_seconds,
        'routingDurationSeconds', filtered.routing_duration_seconds,
        'handlingDurationSeconds', filtered.handling_duration_seconds,
        'segments', filtered.segments,
        'queues', filtered.queue_names,
        'hasRecording', filtered.has_recording,
        'callNote', filtered.call_note,
        'returnedAfterMissed',
          case
            when filtered.call_type = 'Inbound'
              and filtered.final_status
                in ('NO ANSWER', 'ABANDONED', 'BUSY')
            then exists (
              select 1
              from telephony.call_records callback
              where callback.tenant_id = filtered.tenant_id
                and callback.call_type = 'Outbound'
                and callback.final_status = 'ANSWERED'
                and callback.callee_number = filtered.caller_number
                and callback.started_at > filtered.started_at
                and callback.started_at
                  <= filtered.started_at + interval '7 days'
            )
            else null
          end
      ) order by filtered.started_at desc)
      from (
        select record.*
        from telephony.call_records record
        where record.tenant_id = v_tenant.id
        and (
          not v_personal_only
          or record.involved_extensions && v_staff_extensions
        )
          and record.started_at >= v_from
          and record.started_at < v_to
          and (
            p_extension is null
            or p_extension = any(record.involved_extensions)
          )
          and (p_call_type is null or record.call_type = p_call_type)
          and (p_status is null or record.final_status = p_status)
        order by record.started_at desc
        limit v_limit offset v_offset
      ) filtered
    ), '[]'::jsonb),
    'lastSync', (
      select jsonb_build_object(
        'status', run.status,
        'startedAt', run.started_at,
        'finishedAt', run.finished_at,
        'fetchedCount', run.fetched_count,
        'insertedCount', run.inserted_count,
        'updatedCount', run.updated_count,
        'deviceModel', run.device_model,
        'firmwareVersion', run.firmware_version,
        'apiVersion', run.api_version,
        'errorDetail', run.error_detail
      )
      from telephony.sync_runs run
      where run.tenant_id = v_tenant.id
      order by run.started_at desc
      limit 1
    )
  );
end;
$function$
;

revoke all on function private_app.yeastar_reports_snapshot_core_v2(
  text,
  timestamptz,
  timestamptz,
  text,
  text,
  text,
  integer,
  integer
) from public, anon, authenticated;

comment on function private_app.yeastar_reports_snapshot_core_v2(
  text,
  timestamptz,
  timestamptz,
  text,
  text,
  text,
  integer,
  integer
) is
  'Builds tenant-isolated Yeastar reports; personal roles are extension-scoped while owners and managers retain tenant-wide visibility.';

notify pgrst, 'reload schema';

commit;
