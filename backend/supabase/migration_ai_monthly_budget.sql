-- Run in Supabase before deploying the Gemini-backed application.
-- Reservations are shared across all backend instances and reset by UTC month.

create table if not exists public.ai_monthly_budget (
  month_start date primary key,
  spent_nanodollars bigint not null default 0 check (spent_nanodollars >= 0),
  reserved_nanodollars bigint not null default 0 check (reserved_nanodollars >= 0),
  updated_at timestamptz not null default now(),
  check (extract(day from month_start) = 1)
);

alter table public.ai_monthly_budget enable row level security;
revoke all on table public.ai_monthly_budget from public, anon, authenticated;
grant all on table public.ai_monthly_budget to service_role;

create or replace function public.reserve_ai_monthly_budget(
  p_month_start date,
  p_reservation_nanodollars bigint,
  p_monthly_limit_nanodollars bigint
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_month_start is null
     or extract(day from p_month_start) <> 1
     or p_reservation_nanodollars <= 0
     or p_monthly_limit_nanodollars <= 0 then
    raise exception 'Invalid AI budget reservation';
  end if;

  insert into public.ai_monthly_budget (month_start)
  values (p_month_start)
  on conflict (month_start) do nothing;

  update public.ai_monthly_budget
  set reserved_nanodollars = reserved_nanodollars + p_reservation_nanodollars,
      updated_at = now()
  where month_start = p_month_start
    and spent_nanodollars + reserved_nanodollars + p_reservation_nanodollars
        <= p_monthly_limit_nanodollars;

  return found;
end;
$$;

create or replace function public.settle_ai_monthly_budget(
  p_month_start date,
  p_reservation_nanodollars bigint,
  p_actual_nanodollars bigint,
  p_monthly_limit_nanodollars bigint
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_reservation_nanodollars <= 0
     or p_actual_nanodollars < 0
     or p_monthly_limit_nanodollars <= 0 then
    raise exception 'Invalid AI budget settlement';
  end if;

  update public.ai_monthly_budget
  set spent_nanodollars = case
        when p_actual_nanodollars > p_reservation_nanodollars
          or spent_nanodollars + p_actual_nanodollars
             + reserved_nanodollars - p_reservation_nanodollars
             > p_monthly_limit_nanodollars
        then p_monthly_limit_nanodollars
        else spent_nanodollars + p_actual_nanodollars
      end,
      reserved_nanodollars = reserved_nanodollars - p_reservation_nanodollars,
      updated_at = now()
  where month_start = p_month_start
    and reserved_nanodollars >= p_reservation_nanodollars;

  if not found then
    raise exception 'AI budget reservation could not be settled';
  end if;
end;
$$;

create or replace function public.release_ai_monthly_budget(
  p_month_start date,
  p_reservation_nanodollars bigint
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_reservation_nanodollars <= 0 then
    raise exception 'Invalid AI budget release';
  end if;

  update public.ai_monthly_budget
  set reserved_nanodollars = reserved_nanodollars - p_reservation_nanodollars,
      updated_at = now()
  where month_start = p_month_start
    and reserved_nanodollars >= p_reservation_nanodollars;

  if not found then
    raise exception 'AI budget reservation could not be released';
  end if;
end;
$$;

revoke all on function public.reserve_ai_monthly_budget(date, bigint, bigint)
  from public, anon, authenticated;
revoke all on function public.settle_ai_monthly_budget(date, bigint, bigint, bigint)
  from public, anon, authenticated;
revoke all on function public.release_ai_monthly_budget(date, bigint)
  from public, anon, authenticated;
grant execute on function public.reserve_ai_monthly_budget(date, bigint, bigint)
  to service_role;
grant execute on function public.settle_ai_monthly_budget(date, bigint, bigint, bigint)
  to service_role;
grant execute on function public.release_ai_monthly_budget(date, bigint)
  to service_role;
