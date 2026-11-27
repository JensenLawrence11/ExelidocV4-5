-- Apply once before deploying shared authentication rate limits.
-- Only keyed hashes are stored; raw email addresses and client IPs are not.

create table if not exists public.api_rate_limits (
  action text not null,
  key_hash text not null check (key_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null,
  request_count bigint not null check (request_count > 0),
  expires_at timestamptz not null,
  primary key (action, key_hash)
);

create index if not exists idx_api_rate_limits_expires_at
  on public.api_rate_limits(expires_at);

alter table public.api_rate_limits enable row level security;
revoke all on table public.api_rate_limits from public, anon, authenticated;
grant all on table public.api_rate_limits to service_role;

create or replace function public.consume_api_rate_limit(
  p_action text,
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_count bigint;
  v_expires_at timestamptz;
begin
  if p_action is null
     or char_length(p_action) < 1
     or char_length(p_action) > 64
     or p_key_hash is null
     or p_key_hash !~ '^[a-f0-9]{64}$'
     or p_limit is null
     or p_limit < 1
     or p_window_seconds is null
     or p_window_seconds < 1 then
    raise exception 'Invalid API rate-limit request';
  end if;

  insert into public.api_rate_limits (
    action, key_hash, window_started_at, request_count, expires_at
  )
  values (
    p_action, p_key_hash, v_now, 1, v_now + p_window_seconds * interval '1 second'
  )
  on conflict (action, key_hash) do update
  set window_started_at = case
        when api_rate_limits.expires_at <= v_now then v_now
        else api_rate_limits.window_started_at
      end,
      request_count = case
        when api_rate_limits.expires_at <= v_now then 1
        else api_rate_limits.request_count + 1
      end,
      expires_at = case
        when api_rate_limits.expires_at <= v_now
          then v_now + p_window_seconds * interval '1 second'
        else api_rate_limits.expires_at
      end
  returning api_rate_limits.request_count, api_rate_limits.expires_at
    into v_count, v_expires_at;

  delete from public.api_rate_limits
  where ctid in (
    select ctid
    from public.api_rate_limits
    where expires_at < v_now - interval '24 hours'
    limit 100
  );

  return query
  select
    v_count <= p_limit,
    case
      when v_count > p_limit
        then greatest(1, ceil(extract(epoch from v_expires_at - v_now))::integer)
      else 0
    end;
end;
$$;

revoke all on function public.consume_api_rate_limit(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(text, text, integer, integer)
  to service_role;
