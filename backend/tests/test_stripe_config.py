import importlib
import os

import config
import services.stripe_service as stripe_service


def test_stripe_uses_public_url_and_monthly_alias(monkeypatch):
    monkeypatch.setenv("APP_PUBLIC_URL", "https://example.com")
    monkeypatch.setenv("STRIPE_PRICE_ID_PRO", "")
    monkeypatch.setenv("STRIPE_PRICE_ID_ENTERPRISE", "")
    monkeypatch.setenv("STRIPE_PRICE_ID_MONTHLY", "price_monthly_alias")

    importlib.reload(config)
    importlib.reload(stripe_service)

    assert config.Config.STRIPE_PRICE_ID_PRO == "price_monthly_alias"
    assert stripe_service.TIER_PRICE_IDS["pro"] == "price_monthly_alias"
    assert stripe_service._public_base_url() == "https://example.com"
    assert stripe_service._success_url().startswith("https://example.com/success.html?session_id=")
    assert stripe_service._cancel_url() == "https://example.com/download.html"
