"""
All Stripe SDK calls live here, isolated from the route layer.
"""
import stripe
from config import Config

stripe.api_key = Config.STRIPE_SECRET_KEY

TIER_PRICE_IDS = {
    "pro": Config.STRIPE_PRICE_ID_PRO,
    "enterprise": Config.STRIPE_PRICE_ID_ENTERPRISE,
}


def _public_base_url() -> str:
    base = (Config.APP_PUBLIC_URL or "https://exelidocv4-5.onrender.com").rstrip("/")
    return base


def _success_url() -> str:
    return f"{_public_base_url()}/success.html?session_id={{CHECKOUT_SESSION_ID}}"


def _cancel_url() -> str:
    return f"{_public_base_url()}/download.html"


def create_checkout_session(customer_email: str, tier: str, customer_id: str | None = None):
    """Free tier never calls this -- only 'pro' and 'enterprise' go through Stripe."""
    if not Config.STRIPE_SECRET_KEY:
        env_name = Config.stripe_env_name("SECRET_KEY")
        raise ValueError(f"Stripe checkout is not configured: set {env_name} in the backend environment.")

    price_id = TIER_PRICE_IDS.get(tier)
    if not price_id:
        price_env_var = Config.stripe_env_name(
            "PRICE_ID_PRO" if tier == "pro" else "PRICE_ID_ENTERPRISE"
        )
        raise ValueError(f"Stripe {tier} is not configured: set {price_env_var} to an active recurring Price ID.")
    if not price_id.startswith("price_"):
        price_env_var = Config.stripe_env_name(
            "PRICE_ID_PRO" if tier == "pro" else "PRICE_ID_ENTERPRISE"
        )
        raise ValueError(
            f"Stripe {tier} must use a recurring Price ID beginning with 'price_', not a Product ID. "
            f"Check {price_env_var}."
        )

    session_options = {
        "mode": "subscription",
        "payment_method_types": ["card"],
        "line_items": [{"price": price_id, "quantity": 1}],
        "metadata": {"tier": tier},
        "subscription_data": {"metadata": {"tier": tier}},
        "success_url": _success_url(),
        "cancel_url": _cancel_url(),
    }
    if customer_id:
        session_options["customer"] = customer_id
    else:
        session_options["customer_email"] = customer_email
    return stripe.checkout.Session.create(**session_options)


def get_checkout_session(session_id: str):
    return stripe.checkout.Session.retrieve(session_id)


def create_customer_portal_session(customer_id: str):
    if not Config.STRIPE_SECRET_KEY:
        raise ValueError("Stripe billing is not configured.")
    return stripe.billing_portal.Session.create(
        customer=customer_id,
        return_url=Config.BILLING_RETURN_URL or _public_base_url(),
    )


def handle_webhook_event(payload: bytes, sig_header: str, webhook_secret: str) -> dict:
    event = stripe.Webhook.construct_event(payload, sig_header, webhook_secret)
    return event
