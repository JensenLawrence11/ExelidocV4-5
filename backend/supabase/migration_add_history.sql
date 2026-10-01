-- Run once in Supabase SQL Editor to enable shared Chrome / Office history.

create table if not exists ai_conversation_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  client text not null default 'unknown',
  action text not null,
  prompt text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  constraint valid_history_client check (client in ('chrome', 'office', 'unknown'))
);

create index if not exists idx_history_user_created
  on ai_conversation_history(user_id, created_at desc);

alter table ai_conversation_history enable row level security;
