from contextlib import ExitStack
from unittest.mock import patch

import pytest

from app import create_app
from config import Config


PRODUCTION_SETTINGS = {
    "SUPABASE_URL": "https://example.supabase.co",
    "SUPABASE_SERVICE_KEY": "service-key",
    "OPENROUTER_API_KEY": "provider-key",
    "EMAIL_SMTP_HOST": "smtp.example.com",
    "EMAIL_FROM_ADDRESS": "support@example.com",
    "STRIPE_SECRET_KEY": "stripe-secret",
    "STRIPE_WEBHOOK_SECRET": "stripe-webhook",
    "STRIPE_PRICE_ID_PRO": "price_pro",
    "STRIPE_PRICE_ID_ENTERPRISE": "price_enterprise",
    "BILLING_RETURN_URL": "https://example.com/index.html#plans",
    "SECRET_KEY": "random-production-secret",
    "FRONTEND_ORIGINS": [
        "https://example.com",
        "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef",
    ],
    "APP_PUBLIC_URL": "https://example.com",
}


def _validate_with_settings(settings):
    with ExitStack() as stack:
        for name, value in settings.items():
            stack.enter_context(patch.object(Config, name, value))
        Config.validate_for_production()


def test_complete_production_configuration_passes_validation():
    _validate_with_settings(PRODUCTION_SETTINGS)


@pytest.mark.parametrize(
    ("name", "value", "expected_error"),
    [
        ("SECRET_KEY", "dev-only-insecure-key", "FLASK_SECRET_KEY"),
        ("FRONTEND_ORIGINS", ["*"], "FRONTEND_ORIGINS"),
        ("STRIPE_WEBHOOK_SECRET", None, "STRIPE_WEBHOOK_SECRET"),
        ("APP_PUBLIC_URL", "http://example.com", "APP_PUBLIC_URL"),
        ("BILLING_RETURN_URL", "https://", "BILLING_RETURN_URL"),
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
