import importlib
import os
from unittest.mock import patch

import config
import services.stripe_service as stripe_service
from app import create_app


FREE_USER = {"id": "user-1", "email": "user@example.com", "tier": "free"}


def _authenticated(user):
    return patch("utils.auth_decorator.get_user_by_session_token", return_value=user)


def test_stripe_uses_public_url_and_monthly_alias(monkeypatch):
    monkeypatch.setenv("APP_PUBLIC_URL", "https://example.com")
    monkeypatch.setenv("STRIPE_MODE", "live")
    monkeypatch.setenv("STRIPE_LIVE_SECRET_KEY", "rk_live_selected")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "rk_live_legacy")
    monkeypatch.setenv("STRIPE_LIVE_PRICE_ID_PRO", "")
    monkeypatch.setenv("STRIPE_LIVE_PRICE_ID_ENTERPRISE", "")
    monkeypatch.setenv("STRIPE_LIVE_PRICE_ID_MONTHLY", "")
    monkeypatch.setenv("STRIPE_PRICE_ID_PRO", "")
    monkeypatch.setenv("STRIPE_PRICE_ID_ENTERPRISE", "")
    monkeypatch.setenv("STRIPE_PRICE_ID_MONTHLY", "price_monthly_alias")

    importlib.reload(config)
    importlib.reload(stripe_service)

    assert config.Config.STRIPE_SECRET_KEY == "rk_live_selected"
    assert config.Config.STRIPE_PRICE_ID_PRO == "price_monthly_alias"
    assert stripe_service.TIER_PRICE_IDS["pro"] == "price_monthly_alias"
    assert stripe_service._public_base_url() == "https://example.com"
    assert stripe_service._success_url().startswith("https://example.com/success.html?session_id=")
    assert stripe_service._cancel_url() == "https://example.com/download.html"


def test_test_mode_uses_test_prefixed_stripe_values(monkeypatch):
    monkeypatch.setenv("STRIPE_MODE", "test")
    monkeypatch.setenv("STRIPE_TEST_SECRET_KEY", "sk_test_selected")
    monkeypatch.setenv("STRIPE_TEST_PUBLISHABLE_KEY", "pk_test_selected")
    monkeypatch.setenv("STRIPE_TEST_WEBHOOK_SECRET", "whsec_test_selected")
    monkeypatch.setenv("STRIPE_TEST_PRICE_ID_PRO", "price_test_pro")
    monkeypatch.setenv("STRIPE_TEST_PRICE_ID_ENTERPRISE", "price_test_enterprise")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "rk_live_legacy")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_live_legacy")
    monkeypatch.setenv("STRIPE_PRICE_ID_PRO", "price_live_pro")
    monkeypatch.setenv("STRIPE_PRICE_ID_ENTERPRISE", "price_live_enterprise")

    importlib.reload(config)
    importlib.reload(stripe_service)

    assert config.Config.STRIPE_MODE == "test"
    assert config.Config.STRIPE_SECRET_KEY == "sk_test_selected"
    assert config.Config.STRIPE_PUBLISHABLE_KEY == "pk_test_selected"
    assert config.Config.STRIPE_WEBHOOK_SECRET == "whsec_test_selected"
    assert config.Config.STRIPE_PRICE_ID_PRO == "price_test_pro"
    assert config.Config.STRIPE_PRICE_ID_ENTERPRISE == "price_test_enterprise"
    assert stripe_service.stripe.api_key == "sk_test_selected"


def test_test_mode_does_not_fall_back_to_live_secret():
    with patch.dict(
        os.environ,
        {
            "STRIPE_MODE": "test",
            "STRIPE_TEST_SECRET_KEY": "",
            "STRIPE_SECRET_KEY": "rk_live_legacy",
        },
    ):
        assert config._stripe_setting("SECRET_KEY") == ""


def test_customer_portal_returns_customer_to_configured_website():
    portal_session = type("PortalSession", (), {"url": "https://billing.stripe.com/session"})()

    with patch.object(stripe_service.Config, "BILLING_RETURN_URL", "https://example.com/index.html#plans"), patch(
        "services.stripe_service.stripe.billing_portal.Session.create",
        return_value=portal_session,
    ) as create_session:
        result = stripe_service.create_customer_portal_session("cus-123")

    assert result is portal_session
    create_session.assert_called_once_with(
        customer="cus-123",
        return_url="https://example.com/index.html#plans",
    )


def test_checkout_reuses_authenticated_users_existing_stripe_customer():
    with patch.object(stripe_service.Config, "STRIPE_SECRET_KEY", "sk_test"), patch.dict(
        stripe_service.TIER_PRICE_IDS, {"pro": "price_pro"}
    ), patch(
        "services.stripe_service.stripe.checkout.Session.create",
        return_value=type("CheckoutSession", (), {"url": "https://checkout.example/session"})(),
    ) as create_session:
        stripe_service.create_checkout_session(
            customer_email="user@example.com",
            tier="pro",
            customer_id="cus-existing",
        )

    assert create_session.call_args.kwargs["customer"] == "cus-existing"
    assert "customer_email" not in create_session.call_args.kwargs


def test_paid_checkout_requires_authenticated_session():
    app = create_app()

    with app.test_client() as client:
        with patch("routes.stripe_routes.create_checkout_session") as create_checkout:
            response = client.post(
                "/api/stripe/create-checkout-session",
                json={"customer_email": "known@example.com", "tier": "pro"},
            )

    assert response.status_code == 401
    create_checkout.assert_not_called()


def test_paid_checkout_does_not_create_duplicate_active_subscription():
    app = create_app()
    paid_user = {
        "id": "paid-user",
        "email": "paid@example.com",
        "tier": "pro",
        "subscription_status": "active",
    }

    with app.test_client() as client, _authenticated(paid_user):
        with patch(
            "routes.stripe_routes.create_checkout_session"
        ) as create_checkout:
            response = client.post(
                "/api/stripe/create-checkout-session",
                json={"tier": "pro"},
                headers={"X-Session-Token": "session-1"},
            )

    assert response.status_code == 409
    assert "active paid plan" in response.get_json()["error"]
    create_checkout.assert_not_called()


def test_checkout_uses_authenticated_account_not_request_email():
    app = create_app()
    free_user = {**FREE_USER, "stripe_customer_id": "cus-existing"}

    with app.test_client() as client, _authenticated(free_user):
        with patch(
            "routes.stripe_routes.create_checkout_session",
            return_value=type("CheckoutSession", (), {"url": "https://checkout.example/session"})(),
        ) as create_checkout:
            response = client.post(
                "/api/stripe/create-checkout-session",
                json={"customer_email": "attacker@example.com", "tier": "pro"},
                headers={"X-Session-Token": "session-1"},
            )

    assert response.status_code == 200
    assert response.get_json()["url"] == "https://checkout.example/session"
    create_checkout.assert_called_once_with(
        customer_email="user@example.com",
        tier="pro",
        customer_id="cus-existing",
    )


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
    with app.test_client() as client, _authenticated(FREE_USER):
        with patch(
            "routes.stripe_routes.create_checkout_session",
            side_effect=ValueError("Stripe pro must use a recurring Price ID beginning with 'price_'."),
        ):
            response = client.post(
                "/api/stripe/create-checkout-session",
                json={"tier": "pro"},
                headers={"X-Session-Token": "session-1"},
            )

    assert response.status_code == 503
    assert "recurring Price ID" in response.get_json()["error"]


def test_checkout_reports_stripe_price_not_found():
    app = create_app()
    stripe_error = stripe_service.stripe.error.InvalidRequestError("No such price", "line_items")
    stripe_error.code = "resource_missing"
    stripe_error.param = "line_items[0][price]"
    stripe_error.request_id = "req_test123"

    with app.test_client() as client, _authenticated(FREE_USER):
        with patch(
            "routes.stripe_routes.create_checkout_session",
            side_effect=stripe_error,
        ):
            response = client.post(
                "/api/stripe/create-checkout-session",
                json={"tier": "pro"},
                headers={"X-Session-Token": "session-1"},
            )

    assert response.status_code == 503
    data = response.get_json()
    assert "same Stripe account and test/live mode" in data["error"]
    assert data["stripe_code"] == "resource_missing"
    assert data["stripe_param"] == "line_items[0][price]"
    assert data["stripe_request_id"] == "req_test123"


def test_checkout_reports_missing_secret_key():
    app = create_app()
    with app.test_client() as client, _authenticated(FREE_USER), patch.object(
        stripe_service.Config, "STRIPE_SECRET_KEY", None
    ), patch.dict(
        stripe_service.TIER_PRICE_IDS, {"pro": "price_test"}
    ):
        response = client.post(
            "/api/stripe/create-checkout-session",
            json={"tier": "pro"},
            headers={"X-Session-Token": "session-1"},
        )

    assert response.status_code == 503
    assert "STRIPE_TEST_SECRET_KEY" in response.get_json()["error"]


def test_webhook_reports_missing_signing_secret():
    app = create_app()
    app.config["STRIPE_WEBHOOK_SECRET"] = None

    with app.test_client() as client:
        response = client.post("/api/stripe/webhook", data=b"{}")

    assert response.status_code == 503
    assert "STRIPE_TEST_WEBHOOK_SECRET" in response.get_json()["error"]
