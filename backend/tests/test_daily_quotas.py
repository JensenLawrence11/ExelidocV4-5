from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

from config import Config
from services import user_service


NOW = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)


class FixedDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW if tz else NOW.replace(tzinfo=None)


def _run_quota_check(tier, requests_used, reset_at):
    supabase = Mock()
    user = {
        "id": "user-1",
        "tier": tier,
        "requests_used": requests_used,
        "period_reset_at": reset_at.isoformat(),
    }
    with patch("services.user_service.get_supabase", return_value=supabase), patch(
        "services.user_service.datetime", FixedDateTime
    ):
        result = user_service.check_and_consume_quota(user)
    return result, supabase


def test_daily_tier_limits_are_five_twenty_and_fifty():
    assert Config.TIER_LIMITS == {"free": 5, "pro": 20, "enterprise": 50}
    assert user_service.PERIOD_LENGTH == timedelta(days=1)


def test_request_at_daily_limit_is_denied_for_each_tier():
    for tier, limit in Config.TIER_LIMITS.items():
        result, supabase = _run_quota_check(tier, limit, NOW + timedelta(hours=1))
        assert result == (False, 0)
        supabase.table.return_value.update.assert_not_called()


def test_final_allowed_request_consumes_slot_and_reports_zero_remaining():
    result, supabase = _run_quota_check("free", 4, NOW + timedelta(hours=1))

    assert result == (True, 0)
    supabase.table.return_value.update.assert_called_once_with({"requests_used": 5})


def test_expired_window_resets_usage_and_starts_a_fresh_day():
    result, supabase = _run_quota_check("free", 5, NOW - timedelta(seconds=1))
    update = supabase.table.return_value.update

    assert result == (True, 4)
    assert update.call_count == 2
    reset_values = update.call_args_list[0].args[0]
    assert reset_values["requests_used"] == 0
    assert datetime.fromisoformat(reset_values["period_reset_at"]) == NOW + timedelta(days=1)
    assert update.call_args_list[1].args[0] == {"requests_used": 1}