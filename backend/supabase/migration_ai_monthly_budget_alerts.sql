-- Apply once to support one-time monthly spend warning and cap alerts.

create table if not exists public.ai_monthly_budget_alerts (
  month_start date not null references public.ai_monthly_budget(month_start) on delete cascade,
  alert_code text not null check (alert_code in ('warning_80_percent', 'cap_blocked')),
  created_at timestamptz not null default now(),
  primary key (month_start, alert_code)
);

alter table public.ai_monthly_budget_alerts enable row level security;
revoke all on table public.ai_monthly_budget_alerts from public, anon, authenticated;
grant all on table public.ai_monthly_budget_alerts to service_role;

create or replace function public.claim_ai_monthly_budget_alert(
  p_month_start date,
  p_alert_code text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claimed boolean := false;
begin
  if p_month_start is null
     or extract(day from p_month_start) <> 1
     or p_alert_code is null
     or p_alert_code not in ('warning_80_percent', 'cap_blocked') then
    raise exception 'Invalid AI budget alert';
  end if;

  if p_alert_code = 'warning_80_percent' then
    insert into public.ai_monthly_budget_alerts (month_start, alert_code)
    select p_month_start, p_alert_code
    from public.ai_monthly_budget
    where month_start = p_month_start
      and spent_nanodollars + reserved_nanodollars >= 8000000000
    on conflict (month_start, alert_code) do nothing
    returning true into v_claimed;
  else
    insert into public.ai_monthly_budget_alerts (month_start, alert_code)
    values (p_month_start, p_alert_code)
    on conflict (month_start, alert_code) do nothing
    returning true into v_claimed;
  end if;

  return coalesce(v_claimed, false);
end;
$$;

revoke all on function public.claim_ai_monthly_budget_alert(date, text)
  from public, anon, authenticated;
grant execute on function public.claim_ai_monthly_budget_alert(date, text)
  to service_role;
