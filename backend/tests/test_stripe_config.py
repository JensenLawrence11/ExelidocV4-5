import importlib
import os
from unittest.mock import patch

import config
import services.stripe_service as stripe_service
from app import create_app


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


def test_paid_checkout_requires_extension_account():
    app = create_app()

    with app.test_client() as client:
        with patch("routes.stripe_routes.get_user_by_email", return_value=None), patch(
            "routes.stripe_routes.create_checkout_session"
        ) as create_checkout:
            response = client.post(
                "/api/stripe/create-checkout-session",
                json={"customer_email": "new@example.com", "tier": "pro"},
            )

    assert response.status_code == 409
    assert "extension" in response.get_json()["error"]
    create_checkout.assert_not_called()


def test_paid_checkout_does_not_create_duplicate_active_subscription():
    app = create_app()
    paid_user = {
        "email": "paid@example.com",
        "tier": "pro",
        "subscription_status": "active",
    }

    with app.test_client() as client:
        with patch("routes.stripe_routes.get_user_by_email", return_value=paid_user), patch(
            "routes.stripe_routes.create_checkout_session"
        ) as create_checkout:
            response = client.post(
                "/api/stripe/create-checkout-session",
                json={"customer_email": "paid@example.com", "tier": "pro"},
            )

    assert response.status_code == 409
    assert "active paid plan" in response.get_json()["error"]
    create_checkout.assert_not_called()


def test_paid_checkout_normalizes_account_email():
    app = create_app()
    free_user = {"email": "user@example.com", "tier": "free"}

    with app.test_client() as client:
        with patch("routes.stripe_routes.get_user_by_email", return_value=free_user) as find_user, patch(
            "routes.stripe_routes.create_checkout_session",
            return_value=type("CheckoutSession", (), {"url": "https://checkout.example/session"})(),
        ) as create_checkout:
            response = client.post(
                "/api/stripe/create-checkout-session",
                json={"customer_email": "  USER@Example.com  ", "tier": "pro"},
            )

    assert response.status_code == 200
    assert response.get_json()["url"] == "https://checkout.example/session"
    find_user.assert_called_once_with("user@example.com")
    create_checkout.assert_called_once_with(customer_email="user@example.com", tier="pro")


def test_checkout_rejects_product_id_before_calling_stripe():
    with patch.dict(stripe_service.TIER_PRICE_IDS, {"pro": "prod_product_id"}), patch(
        "services.stripe_service.stripe.checkout.Session.create"
    ) as create_session:
        try:
            stripe_service.create_checkout_session("user@example.com", "pro")
        except ValueError as error:
            assert "recurring Price ID" in str(error)
        else:
            raise AssertionError("A Stripe Product ID must be rejected")

    create_session.assert_not_called()


def test_checkout_reports_bad_price_configuration_to_website():
    app = create_app()
    free_user = {"email": "user@example.com", "tier": "free"}

    with app.test_client() as client:
        with patch("routes.stripe_routes.get_user_by_email", return_value=free_user), patch(
            "routes.stripe_routes.create_checkout_session",
            side_effect=ValueError("Stripe pro must use a recurring Price ID beginning with 'price_'."),
        ):
            response = client.post(
                "/api/stripe/create-checkout-session",
                json={"customer_email": "user@example.com", "tier": "pro"},
            )

    assert response.status_code == 503
    assert "recurring Price ID" in response.get_json()["error"]
