"""Sentry initialization with request and user data removed from events."""
import sentry_sdk
from sentry_sdk.integrations.flask import FlaskIntegration

from config import Config

AI_BUDGET_WARNING = "ai_monthly_budget_80_percent"
AI_BUDGET_LIMIT = "ai_monthly_budget_cap_blocked"


def scrub_sentry_event(event, hint):
    event.pop("request", None)
    event.pop("user", None)
    event.pop("breadcrumbs", None)
    event.pop("extra", None)
    event.pop("logentry", None)
    event.pop("contexts", None)
    event.pop("tags", None)
    event.pop("transaction", None)

    message = event.get("message")
    if not isinstance(message, str) or message not in {AI_BUDGET_WARNING, AI_BUDGET_LIMIT}:
        event.pop("message", None)

    exception = event.get("exception")
    if isinstance(exception, dict):
        values = exception.get("values")
        if isinstance(values, list):
            for value in values:
                if isinstance(value, dict):
                    value["value"] = "[redacted]"

    return event


def initialize_monitoring() -> None:
    if not Config.SENTRY_DSN:
        return
    sentry_sdk.init(
        dsn=Config.SENTRY_DSN,
        environment=Config.ENV,
        integrations=[FlaskIntegration()],
        send_default_pii=False,
        include_local_variables=False,
        traces_sample_rate=0.0,
        before_send=scrub_sentry_event,
    )


def capture_exception(error: Exception) -> None:
    if Config.SENTRY_DSN:
        sentry_sdk.capture_exception(error)


def capture_message(message: str) -> None:
    if Config.SENTRY_DSN:
        sentry_sdk.capture_message(message, level="warning")
