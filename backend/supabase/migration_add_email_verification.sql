-- Run once in Supabase SQL Editor to support verified free-account signup.

create table if not exists pending_signups (
  email text primary key,
  password_hash text not null,
  verification_token_hash text unique not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table pending_signups enable row level security;