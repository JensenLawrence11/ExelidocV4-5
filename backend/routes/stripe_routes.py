"""
Subscription billing. The website's "Subscribe" button hits /create-checkout-session
with a tier, Stripe redirects the user through checkout, then calls our
/webhook to confirm payment and provision/update the user's row in Supabase.
"""
from flask import Blueprint, request, jsonify, current_app

from services.stripe_service import create_checkout_session, handle_webhook_event
from services.user_service import (
    get_user_by_email,
    create_user,
    link_stripe_customer,
    set_subscription_status,
    set_user_tier,
)

stripe_bp = Blueprint("stripe", __name__)

PAID_TIERS = {"pro", "enterprise"}


@stripe_bp.post("/create-checkout-session")
def create_checkout_session_route():
    """
    Body: { "customer_email": "...", "tier": "pro" | "enterprise" }
    Returns: { "url": "https://checkout.stripe.com/..." }
    """
    data = request.get_json(silent=True) or {}
    email = data.get("customer_email")
    tier = data.get("tier")

    if not email:
        return jsonify(error="customer_email is required"), 400
    if tier not in PAID_TIERS:
        return jsonify(error=f"tier must be one of {sorted(PAID_TIERS)}"), 400

    # Make sure a Supabase row exists (and therefore an API key exists)
    # before the user even finishes paying. Starts on the free tier --
    # the webhook upgrades it once payment completes.
    if not get_user_by_email(email):
        create_user(email, tier="free")

    try:
        session = create_checkout_session(customer_email=email, tier=tier)
    except ValueError as e:
        return jsonify(error=str(e)), 500

    return jsonify(url=session.url)


@stripe_bp.post("/webhook")
def webhook_route():
    """
    Stripe calls this directly (not the frontend) on payment/subscription events.
    Verifies the signature, then updates the matching Supabase row.
    """
    payload = request.data
    sig_header = request.headers.get("Stripe-Signature")

    try:
        event = handle_webhook_event(
            payload, sig_header, current_app.config["STRIPE_WEBHOOK_SECRET"]
        )
    except ValueError:
        return jsonify(error="Invalid payload"), 400
    except Exception:
        return jsonify(error="Invalid signature"), 400

    event_type = event["type"]
    obj = event["data"]["object"]

    if event_type == "checkout.session.completed":
        email = obj.get("customer_email") or obj.get("customer_details", {}).get("email")
        customer_id = obj.get("customer")
        tier = (obj.get("metadata") or {}).get("tier", "pro")
        if email and customer_id:
            if not get_user_by_email(email):
                create_user(email, tier="free")
            link_stripe_customer(email, customer_id)
            set_subscription_status(customer_id, "active", obj.get("subscription"))
            set_user_tier(customer_id, tier)

    elif event_type == "customer.subscription.updated":
        customer_id = obj.get("customer")
        status = obj.get("status")  # active, trialing, past_due, canceled, etc.
        tier = (obj.get("metadata") or {}).get("tier")
        if customer_id and status:
            set_subscription_status(customer_id, status, obj.get("id"))
            # Only overrides tier if metadata carried one (e.g. user changed
            # plans) -- set_subscription_status already handles the
            # canceled/past_due -> free downgrade on its own.
            if tier and status in ("active", "trialing"):
                set_user_tier(customer_id, tier)

    elif event_type == "customer.subscription.deleted":
        customer_id = obj.get("customer")
        if customer_id:
            set_subscription_status(customer_id, "canceled")

    return jsonify(received=True, type=event_type)
