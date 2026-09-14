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


def create_checkout_session(customer_email: str, tier: str):
    """Free tier never calls this -- only 'pro' and 'enterprise' go through Stripe."""
    price_id = TIER_PRICE_IDS.get(tier)
    if not price_id:
        raise ValueError(f"Unknown or unconfigured tier: {tier}")

    return stripe.checkout.Session.create(
        mode="subscription",
        payment_method_types=["card"],
        line_items=[{"price": price_id, "quantity": 1}],
        customer_email=customer_email,
        # Carried onto both the Checkout Session AND the Subscription object,
        # so the webhook can read the tier back out on every relevant event
        # (initial purchase, and later plan changes) without guessing from
        # the price ID alone.
        metadata={"tier": tier},
        subscription_data={"metadata": {"tier": tier}},
        # TODO: swap to your real domain once deployed, e.g.
        # https://exelidoc.com/success.html?session_id={CHECKOUT_SESSION_ID}
        success_url="http://localhost:8000/success.html?session_id={CHECKOUT_SESSION_ID}",
        cancel_url="http://localhost:8000/download.html",
    )


def get_checkout_session(session_id: str):
    return stripe.checkout.Session.retrieve(session_id)


def handle_webhook_event(payload: bytes, sig_header: str, webhook_secret: str) -> dict:
    event = stripe.Webhook.construct_event(payload, sig_header, webhook_secret)
    return event
