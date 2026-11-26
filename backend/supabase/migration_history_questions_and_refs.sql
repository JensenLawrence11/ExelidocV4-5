-- Store user-authored questions and source references, never source text or AI replies.
-- Run after migration_history_metadata_only.sql.

alter table public.ai_conversation_history
  add column if not exists source_refs jsonb not null default '[]'::jsonb;

alter table public.ai_conversation_history
  drop constraint if exists ai_history_metadata_only;

alter table public.ai_conversation_history
  drop constraint if exists ai_history_question_and_refs;

alter table public.ai_conversation_history
  add constraint ai_history_question_and_refs
  check (
    prompt is not null
    and char_length(prompt) <= 10000
    and response = '{}'::jsonb
    and jsonb_typeof(source_refs) = 'array'
  );
