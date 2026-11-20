-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- If you already ran the old version of this file, see migration.sql instead
-- (adds the new columns without dropping your existing data).

create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text,
  api_key text unique not null default encode(gen_random_bytes(24), 'hex'),
  session_token text unique,
  stripe_customer_id text unique,
  stripe_subscription_id text,
  -- one of: inactive, trialing, active, past_due, canceled
  -- (free tier users stay 'inactive' here -- they never touch Stripe)
  subscription_status text not null default 'inactive',
  -- one of: free, pro, enterprise
  tier text not null default 'free',
  -- requests used in the current 24-hour period; reset to 0 when period_reset_at passes
  requests_used integer not null default 0,
  period_reset_at timestamptz not null default (now() + interval '1 day'),
  created_at timestamptz not null default now(),
  constraint valid_tier check (tier in ('free', 'pro', 'enterprise'))
);

create table if not exists ai_usage_logs (
  id bigint generated always as identity primary key,
  user_id uuid not null references users(id) on delete cascade,
  endpoint text not null,
  created_at timestamptz not null default now()
);

create table if not exists pending_signups (
  email text primary key,
  password_hash text not null,
  verification_token_hash text unique not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists password_resets (
  user_id uuid primary key references users(id) on delete cascade,
  token_hash text unique not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create or replace function issue_password_reset(
  p_user_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  issued_user_id uuid := null;
begin
  insert into password_resets (user_id, token_hash, expires_at, created_at)
    values (p_user_id, p_token_hash, p_expires_at, now())
    on conflict (user_id) do update
      set token_hash = excluded.token_hash,
          expires_at = excluded.expires_at,
          created_at = now()
      where password_resets.created_at <= now() - interval '1 minute'
    returning user_id into issued_user_id;

  return issued_user_id is not null;
end;
$$;

create or replace function complete_password_reset(
  p_token_hash text,
  p_password_hash text,
  p_session_token text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  reset_user_id uuid;
  updated_users integer;
begin
  select user_id
    into reset_user_id
    from password_resets
    where token_hash = p_token_hash
      and expires_at > now()
    for update;

  if reset_user_id is null then
    return false;
  end if;

  update users
    set password_hash = p_password_hash,
        session_token = p_session_token
    where id = reset_user_id;

  get diagnostics updated_users = row_count;
  if updated_users <> 1 then
    return false;
  end if;

  delete from password_resets where user_id = reset_user_id;
  return true;
end;
$$;

create index if not exists idx_users_api_key on users(api_key);
create index if not exists idx_users_session_token on users(session_token);
create index if not exists idx_users_stripe_customer on users(stripe_customer_id);
create index if not exists idx_usage_user_id on ai_usage_logs(user_id);

-- The backend uses the service_role key, which bypasses Row Level Security,
-- so RLS below is just a safety net in case anything ever calls Supabase
-- with the public anon key instead.
alter table users enable row level security;
alter table ai_usage_logs enable row level security;
alter table pending_signups enable row level security;
alter table password_resets enable row level security;
revoke all on function complete_password_reset(text, text, text) from public, anon, authenticated;
revoke all on function issue_password_reset(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function issue_password_reset(uuid, text, timestamptz) to service_role;
grant execute on function complete_password_reset(text, text, text) to service_role;
