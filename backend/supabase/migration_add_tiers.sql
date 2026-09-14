-- Run this ONCE if you already ran the original schema.sql and have an
-- existing `users` table. Safe to re-run (uses IF NOT EXISTS / OR REPLACE
-- throughout). Adds tiers and monthly usage limits.

alter table users add column if not exists tier text not null default 'free';
alter table users add column if not exists requests_used integer not null default 0;
alter table users add column if not exists period_reset_at timestamptz not null default (now() + interval '30 days');

alter table users drop constraint if exists valid_tier;
alter table users add constraint valid_tier check (tier in ('free', 'pro', 'enterprise'));
