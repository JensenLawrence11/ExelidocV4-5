import pytest
from unittest.mock import patch

from app import create_app
from services.ai_service import AIServiceError, analyze_text


USER = {"id": "user-1", "email": "user@example.com", "tier": "free"}


def test_missing_provider_configuration_raises_instead_of_returning_original_text():
    with patch("services.ai_service.Config.OPENROUTER_API_KEY", None):
        with pytest.raises(AIServiceError, match="not configured"):
            analyze_text("Original text", "Rewrite this")


def test_ai_route_reports_provider_failure_and_does_not_save_history():
    app = create_app()

    with app.test_client() as client, patch(
        "utils.auth_decorator.get_user_by_session_token", return_value=USER
    ), patch("utils.auth_decorator.has_access", return_value=True), patch(
        "utils.auth_decorator.check_and_consume_quota", return_value=(True, 4)
    ), patch("routes.ai.build_selected_context", return_value=""), patch(
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
