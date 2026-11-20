-- Run once in Supabase SQL Editor to enable single-use password recovery.

create table if not exists password_resets (
  user_id uuid primary key references users(id) on delete cascade,
  token_hash text unique not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table password_resets enable row level security;

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

revoke all on function complete_password_reset(text, text, text) from public, anon, authenticated;
revoke all on function issue_password_reset(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function issue_password_reset(uuid, text, timestamptz) to service_role;
grant execute on function complete_password_reset(text, text, text) to service_role;
