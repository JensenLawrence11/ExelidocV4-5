-- Remove previously retained prompt and response content, then enforce
-- metadata-only records going forward. Run before deploying the matching code.

alter table public.ai_conversation_history
  add column if not exists source_url text,
  add column if not exists source_urls jsonb not null default '[]'::jsonb;

update public.ai_conversation_history
set prompt = '',
    response = '{}'::jsonb
where prompt <> '' or response <> '{}'::jsonb;

alter table public.ai_conversation_history
  drop constraint if exists ai_history_metadata_only;

alter table public.ai_conversation_history
  add constraint ai_history_metadata_only
  check (prompt = '' and response = '{}'::jsonb);
