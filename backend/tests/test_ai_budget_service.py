from datetime import date
from unittest.mock import patch

from services.ai_budget_service import claim_monthly_ai_budget_alert


def test_monthly_ai_budget_alert_claim_is_shared_and_idempotent():
    month_start = date(2026, 11, 1)

    with patch("services.ai_budget_service.get_supabase") as get_supabase:
        get_supabase.return_value.rpc.return_value.execute.return_value.data = [True]

        assert claim_monthly_ai_budget_alert(month_start, "warning_80_percent") is True

    get_supabase.return_value.rpc.assert_called_once_with(
        "claim_ai_monthly_budget_alert",
        {
            "p_month_start": "2026-11-01",
            "p_alert_code": "warning_80_percent",
        },
    )
