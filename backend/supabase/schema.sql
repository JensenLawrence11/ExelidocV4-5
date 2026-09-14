-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- If you already ran the old version of this file, see migration.sql instead
-- (adds the new columns without dropping your existing data).

create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  api_key text unique not null default encode(gen_random_bytes(24), 'hex'),
  stripe_customer_id text unique,
  stripe_subscription_id text,
  -- one of: inactive, trialing, active, past_due, canceled
  -- (free tier users stay 'inactive' here -- they never touch Stripe)
  subscription_status text not null default 'inactive',
  -- one of: free, pro, enterprise
  tier text not null default 'free',
  -- requests used in the CURRENT period; reset to 0 when period_reset_at passes
  requests_used integer not null default 0,
  period_reset_at timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz not null default now(),
  constraint valid_tier check (tier in ('free', 'pro', 'enterprise'))
);

create table if not exists ai_usage_logs (
  id bigint generated always as identity primary key,
  user_id uuid not null references users(id) on delete cascade,
  endpoint text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_users_api_key on users(api_key);
create index if not exists idx_users_stripe_customer on users(stripe_customer_id);
create index if not exists idx_usage_user_id on ai_usage_logs(user_id);

-- The backend uses the service_role key, which bypasses Row Level Security,
-- so RLS below is just a safety net in case anything ever calls Supabase
-- with the public anon key instead.
alter table users enable row level security;
alter table ai_usage_logs enable row level security;
