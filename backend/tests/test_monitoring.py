from unittest.mock import patch

from services.monitoring_service import (
    AI_BUDGET_LIMIT,
    AI_BUDGET_WARNING,
    initialize_monitoring,
    scrub_sentry_event,
)


def test_sentry_scrubbing_removes_request_user_and_exception_details():
    event = {
        "request": {"url": "https://api.example.com/reset?token=secret", "data": "private text"},
        "user": {"email": "user@example.com"},
        "breadcrumbs": [{"message": "private request context"}],
        "extra": {"source_text": "private text"},
        "exception": {"values": [{"type": "ValueError", "value": "token=secret"}]},
        "message": "token=secret",
    }

    scrubbed = scrub_sentry_event(event, {})

    assert "request" not in scrubbed
    assert "user" not in scrubbed
    assert "breadcrumbs" not in scrubbed
    assert "extra" not in scrubbed
    assert "contexts" not in scrubbed
    assert "tags" not in scrubbed
    assert "transaction" not in scrubbed
    assert scrubbed["exception"]["values"][0]["value"] == "[redacted]"
    assert "message" not in scrubbed


def test_sentry_scrubbing_preserves_only_static_budget_alert_messages():
    for message in (AI_BUDGET_WARNING, AI_BUDGET_LIMIT):
        assert scrub_sentry_event({"message": message}, {})["message"] == message


def test_sentry_monitoring_never_includes_request_local_variables():
    with patch("services.monitoring_service.Config.SENTRY_DSN", "https://sentry.example/123"), patch(
        "services.monitoring_service.Config.ENV", "production"
    ), patch("services.monitoring_service.sentry_sdk.init") as init:
        initialize_monitoring()

    options = init.call_args.kwargs
    assert options["send_default_pii"] is False
    assert options["include_local_variables"] is False
    assert options["traces_sample_rate"] == 0.0
