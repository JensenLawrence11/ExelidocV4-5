"""Shared, atomic monthly AI spend reservations backed by Supabase."""
from datetime import date, datetime, timezone

from services.supabase_client import get_supabase

MONTHLY_AI_BUDGET_NANODOLLARS = 10_000_000_000


def _month_start() -> date:
    return datetime.now(timezone.utc).date().replace(day=1)


def claim_monthly_ai_budget_alert(month_start: date | None, alert_code: str) -> bool:
    month = month_start or _month_start()
    result = get_supabase().rpc(
        "claim_ai_monthly_budget_alert",
        {
            "p_month_start": month.isoformat(),
            "p_alert_code": alert_code,
        },
    ).execute()
    if result.data is True or result.data == [True]:
        return True
    if result.data is False or result.data == [False]:
        return False
    raise RuntimeError("AI monthly budget alert RPC returned an invalid result")


def reserve_monthly_ai_budget(reservation_nanodollars: int) -> date | None:
    month_start = _month_start()
    result = get_supabase().rpc(
        "reserve_ai_monthly_budget",
        {
            "p_month_start": month_start.isoformat(),
            "p_reservation_nanodollars": reservation_nanodollars,
            "p_monthly_limit_nanodollars": MONTHLY_AI_BUDGET_NANODOLLARS,
        },
    ).execute()
    if result.data is True or result.data == [True]:
        return month_start
    if result.data is False or result.data == [False]:
        return None
    raise RuntimeError("AI monthly budget reservation returned an invalid result")


def settle_monthly_ai_budget(
    month_start: date,
    reservation_nanodollars: int,
    actual_nanodollars: int,
) -> None:
    get_supabase().rpc(
        "settle_ai_monthly_budget",
        {
            "p_month_start": month_start.isoformat(),
            "p_reservation_nanodollars": reservation_nanodollars,
            "p_actual_nanodollars": actual_nanodollars,
            "p_monthly_limit_nanodollars": MONTHLY_AI_BUDGET_NANODOLLARS,
        },
    ).execute()


def release_monthly_ai_budget(
    month_start: date,
    reservation_nanodollars: int,
) -> None:
    get_supabase().rpc(
        "release_ai_monthly_budget",
        {
            "p_month_start": month_start.isoformat(),
            "p_reservation_nanodollars": reservation_nanodollars,
        },
    ).execute()
