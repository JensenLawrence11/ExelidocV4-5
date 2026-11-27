import pytest
from datetime import date
from unittest.mock import Mock, patch

from app import create_app
from services.ai_service import (
    AIMonthlyBudgetExceeded,
    AIServiceError,
    _call_gemini,
    _emit_budget_alert,
    analyze_text,
)
from services.monitoring_service import AI_BUDGET_WARNING


USER = {"id": "user-1", "email": "user@example.com", "tier": "free"}


def test_gemini_request_uses_configured_model_and_records_actual_usage():
    response = Mock()
    response.json.return_value = {
        "candidates": [{"content": {"parts": [{"text": "{\"corrected\":\"ok\"}"}]}}],
        "usageMetadata": {
            "promptTokenCount": 10,
            "candidatesTokenCount": 20,
            "thoughtsTokenCount": 3,
        },
    }
    month_start = date(2026, 11, 1)

    with patch("services.ai_service.Config.GEMINI_API_KEY", "test-key"), patch(
        "services.ai_service.Config.GEMINI_MODEL", "gemini-4-hydrogen"
    ), patch(
        "services.ai_service.reserve_monthly_ai_budget", return_value=month_start
    ) as reserve, patch(
        "services.ai_service.settle_monthly_ai_budget"
    ) as settle, patch(
        "services.ai_service.requests.post", return_value=response
    ) as post:
        assert _call_gemini("system prompt", "user prompt") == '{"corrected":"ok"}'

    assert post.call_args.args[0].endswith("/gemini-4-hydrogen:generateContent")
    assert post.call_args.kwargs["headers"]["x-goog-api-key"] == "test-key"
    assert post.call_args.kwargs["json"]["generationConfig"]["responseMimeType"] == "application/json"
    reservation = reserve.call_args.args[0]
    settle.assert_called_once_with(month_start, reservation, 187_500)


def test_monthly_budget_exhaustion_stops_before_generation():
    with patch("services.ai_service.Config.GEMINI_API_KEY", "test-key"), patch(
        "services.ai_service.reserve_monthly_ai_budget", return_value=None
    ), patch("services.ai_service.requests.post") as post:
        with pytest.raises(AIMonthlyBudgetExceeded):
            analyze_text("Original text", "Rewrite this")

    post.assert_not_called()


def test_monthly_budget_warning_is_reported_once_after_shared_claim():
    month_start = date(2026, 11, 1)

    with patch("services.ai_service.Config.SENTRY_DSN", "https://sentry.example/123"), patch(
        "services.ai_service.claim_monthly_ai_budget_alert", return_value=True
    ) as claim, patch("services.ai_service.capture_message") as capture:
        _emit_budget_alert(month_start, "warning_80_percent")

    claim.assert_called_once_with(month_start, "warning_80_percent")
    capture.assert_called_once_with(AI_BUDGET_WARNING)


def test_missing_provider_configuration_raises_instead_of_returning_original_text():
    with patch("services.ai_service.Config.GEMINI_API_KEY", None):
        with pytest.raises(AIServiceError, match="not configured"):
            analyze_text("Original text", "Rewrite this")


def test_ai_route_reports_provider_failure_and_does_not_save_history():
    app = create_app()

    with app.test_client() as client, patch(
        "utils.auth_decorator.get_user_by_session_token", return_value=USER
    ), patch("utils.auth_decorator.has_access", return_value=True), patch(
        "utils.auth_decorator.check_and_consume_quota", return_value=(True, 4)
    ), patch(
        "routes.ai.analyze_text",
        side_effect=AIServiceError("The AI provider could not complete this request."),
    ), patch("routes.ai.save_conversation") as save_history:
        response = client.post(
            "/api/ai/analyze-text",
            json={"text": "Original text", "instruction": "Rewrite this"},
            headers={"X-Session-Token": "session-1"},
        )

    assert response.status_code == 502
    assert "AI provider could not complete" in response.get_json()["error"]
    save_history.assert_not_called()


def test_ai_route_reports_monthly_budget_exhaustion_as_rate_limited():
    app = create_app()

    with app.test_client() as client, patch(
        "utils.auth_decorator.get_user_by_session_token", return_value=USER
    ), patch("utils.auth_decorator.has_access", return_value=True), patch(
        "utils.auth_decorator.check_and_consume_quota", return_value=(True, 4)
    ), patch(
        "routes.ai.analyze_text", side_effect=AIMonthlyBudgetExceeded()
    ):
        response = client.post(
            "/api/ai/analyze-text",
            json={"text": "Original text", "instruction": "Rewrite this"},
            headers={"X-Session-Token": "session-1"},
        )

    assert response.status_code == 429
    assert "monthly AI spending limit" in response.get_json()["error"]
