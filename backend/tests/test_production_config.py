from contextlib import ExitStack
from unittest.mock import patch

import pytest

from app import create_app
from config import Config


PRODUCTION_SETTINGS = {
    "SUPABASE_URL": "https://example.supabase.co",
    "SUPABASE_SERVICE_KEY": "service-key",
    "GEMINI_API_KEY": "provider-key",
    "RESEND_API_KEY": "resend-api-key",
    "EMAIL_FROM_ADDRESS": "support@example.com",
    "STRIPE_MODE": "live",
    "STRIPE_SECRET_KEY": "rk_live_example",
    "STRIPE_WEBHOOK_SECRET": "stripe-webhook",
    "STRIPE_PRICE_ID_MONTHLY": "price_monthly",
    "STRIPE_PRICE_ID_PRO": "price_pro",
    "STRIPE_PRICE_ID_ENTERPRISE": "price_enterprise",
    "BILLING_RETURN_URL": "https://example.com/index.html#plans",
    "SENTRY_DSN": "https://public@example.ingest.sentry.io/123",
    "TRUSTED_PROXY_HOPS": 1,
    "API_PUBLIC_URL": "https://api.example.com",
    "SECRET_KEY": "random-production-secret",
    "FRONTEND_ORIGINS": [
        "https://example.com",
        "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef",
    ],
    "APP_PUBLIC_URL": "https://example.com",
}


def _validate_with_settings(settings):
    with ExitStack() as stack:
        stack.enter_context(patch.object(Config, "ENV", "production"))
        for name, value in settings.items():
            stack.enter_context(patch.object(Config, name, value))
        Config.validate_for_production()


def test_complete_production_configuration_passes_validation():
    _validate_with_settings(PRODUCTION_SETTINGS)


def test_production_configuration_accepts_smtp_when_resend_is_unset():
    settings = {
        **PRODUCTION_SETTINGS,
        "RESEND_API_KEY": None,
        "EMAIL_SMTP_HOST": "smtp.example.com",
    }

    _validate_with_settings(settings)


def test_production_configuration_requires_an_email_transport():
    settings = {
        **PRODUCTION_SETTINGS,
        "RESEND_API_KEY": None,
        "EMAIL_SMTP_HOST": None,
    }

    with pytest.raises(RuntimeError, match="EMAIL_DELIVERY"):
        _validate_with_settings(settings)


def test_production_configuration_requires_gemini_api_key():
    settings = {**PRODUCTION_SETTINGS, "GEMINI_API_KEY": None}

    with pytest.raises(RuntimeError, match="GEMINI_API_KEY"):
        _validate_with_settings(settings)


@pytest.mark.parametrize(
    ("name", "value", "expected_error"),
    [
        ("SECRET_KEY", "dev-only-insecure-key", "FLASK_SECRET_KEY"),
        ("STRIPE_MODE", "test", "STRIPE_MODE"),
        ("STRIPE_SECRET_KEY", "sk_test_example", "STRIPE_SECRET_KEY"),
        ("FRONTEND_ORIGINS", ["*"], "FRONTEND_ORIGINS"),
        ("STRIPE_WEBHOOK_SECRET", None, "STRIPE_WEBHOOK_SECRET"),
        ("STRIPE_PRICE_ID_MONTHLY", None, "STRIPE_PRICE_ID_MONTHLY"),
        ("APP_PUBLIC_URL", "http://example.com", "APP_PUBLIC_URL"),
        ("API_PUBLIC_URL", "https://api.example.com/api", "API_PUBLIC_URL"),
        ("BILLING_RETURN_URL", "https://", "BILLING_RETURN_URL"),
        ("SENTRY_DSN", None, "SENTRY_DSN"),
        ("SENTRY_DSN", "not-a-dsn", "SENTRY_DSN"),
        ("TRUSTED_PROXY_HOPS", 0, "TRUSTED_PROXY_HOPS"),
    ],
)
def test_insecure_or_incomplete_production_settings_are_rejected(name, value, expected_error):
    settings = {**PRODUCTION_SETTINGS, name: value}

    with pytest.raises(RuntimeError, match=expected_error):
        _validate_with_settings(settings)


def test_production_app_startup_runs_configuration_validation():
    with patch.object(Config, "ENV", "production"), patch.object(
        Config, "validate_for_production", side_effect=RuntimeError("configuration rejected")
    ) as validate:
        with pytest.raises(RuntimeError, match="configuration rejected"):
            create_app()

    validate.assert_called_once_with()
