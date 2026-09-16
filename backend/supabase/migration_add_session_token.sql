-- Run this once if your Supabase `users` table already exists.
-- Safe to re-run because it uses IF NOT EXISTS and guards existing constraints.

alter table users add column if not exists tier text not null default 'free';
alter table users add column if not exists requests_used integer not null default 0;
alter table users add column if not exists period_reset_at timestamptz not null default (now() + interval '30 days');
alter table users add column if not exists session_token text unique;

alter table users drop constraint if exists valid_tier;
alter table users add constraint valid_tier check (tier in ('free', 'pro', 'enterprise'));

create index if not exists idx_users_session_token on users(session_token);
