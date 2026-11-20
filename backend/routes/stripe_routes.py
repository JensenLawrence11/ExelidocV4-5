"""
Subscription billing. The website's "Subscribe" button hits /create-checkout-session
with a tier, Stripe redirects the user through checkout, then calls our
/webhook to confirm payment and provision/update the user's row in Supabase.
"""
from flask import Blueprint, request, jsonify, current_app, g
import stripe

from services.stripe_service import (
    create_checkout_session,
    create_customer_portal_session,
    handle_webhook_event,
)
from services.user_service import (
    get_user_by_email,
    create_user,
    link_stripe_customer,
    set_subscription_status,
    set_user_tier,
    get_user_by_stripe_customer,
)
from utils.auth_decorator import require_session

stripe_bp = Blueprint("stripe", __name__)

PAID_TIERS = {"pro", "enterprise"}


@stripe_bp.post("/customer-portal")
@require_session
def customer_portal_route():
    customer_id = g.user.get("stripe_customer_id")
    if not customer_id:
        return jsonify(error="There is no Stripe billing account linked to this Exelidoc account."), 409

    try:
        session = create_customer_portal_session(customer_id)
    except stripe.error.StripeError as error:
        current_app.logger.error(
            "Stripe customer portal failed: type=%s request_id=%s message=%s",
            type(error).__name__,
            getattr(error, "request_id", None),
            str(error),
        )
        return jsonify(
            error="Could not open billing management. Try again shortly or contact Exelidoc support.",
        ), 503
    except ValueError as error:
        return jsonify(error=str(error)), 503

    return jsonify(url=session.url)


@stripe_bp.post("/create-checkout-session")
@require_session
def create_checkout_session_route():
    """
    Body: { "tier": "pro" | "enterprise" }
    Requires the signed-in account session; the account email is never accepted
    from the request body.
    Returns: { "url": "https://checkout.stripe.com/..." }
    """
    data = request.get_json(silent=True) or {}
    tier = data.get("tier")
    if tier not in PAID_TIERS:
        return jsonify(error=f"tier must be one of {sorted(PAID_TIERS)}"), 400

    user = g.user
    if user.get("tier") in PAID_TIERS and user.get("subscription_status") in ("active", "trialing", "past_due"):
        return jsonify(error="An active paid plan already exists. Use Manage subscription to update it."), 409

    try:
        session = create_checkout_session(
            customer_email=user["email"],
            tier=tier,
            customer_id=user.get("stripe_customer_id"),
        )
    except stripe.error.InvalidRequestError as error:
        current_app.logger.warning(
            "Stripe checkout invalid request: code=%s param=%s request_id=%s message=%s",
            getattr(error, "code", None),
            getattr(error, "param", None),
            getattr(error, "request_id", None),
            str(error),
        )
        return jsonify(
            error=(
                "Stripe could not find the configured price. Check that the STRIPE_PRICE_ID for this plan "
                "is an active recurring Price ID from the same Stripe account and test/live mode as STRIPE_SECRET_KEY."
            ),
            stripe_code=getattr(error, "code", None),
            stripe_param=getattr(error, "param", None),
            stripe_request_id=getattr(error, "request_id", None),
        ), 503
    except stripe.error.AuthenticationError as error:
        current_app.logger.error(
            "Stripe checkout authentication failed: request_id=%s message=%s",
            getattr(error, "request_id", None),
            str(error),
        )
        return jsonify(
            error="Stripe authentication failed. Set a valid STRIPE_SECRET_KEY for the same Stripe account as the plan prices."
        ), 503
    except stripe.error.StripeError as error:
        current_app.logger.error(
            "Stripe checkout failed: type=%s code=%s request_id=%s message=%s",
            type(error).__name__,
            getattr(error, "code", None),
            getattr(error, "request_id", None),
            str(error),
        )
        return jsonify(
            error="Stripe could not create checkout. Check the secret key, recurring Price IDs, and Stripe account permissions."
        ), 503
    except ValueError as e:
        return jsonify(error=str(e)), 503

    return jsonify(url=session.url)


@stripe_bp.post("/webhook")
def webhook_route():
    """
    Stripe calls this directly (not the frontend) on payment/subscription events.
    Verifies the signature, then updates the matching Supabase row.
    """
    payload = request.data
    sig_header = request.headers.get("Stripe-Signature")
    webhook_secret = current_app.config.get("STRIPE_WEBHOOK_SECRET")
    if not webhook_secret:
        return jsonify(error="Stripe webhook is not configured: set STRIPE_WEBHOOK_SECRET in the backend environment."), 503

    try:
        event = handle_webhook_event(
            payload, sig_header, webhook_secret
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
        user = get_user_by_stripe_customer(customer_id) if customer_id else None
        email = email or (user or {}).get("email")
        if email and customer_id:
            user = user or get_user_by_email(email)
            if not user:
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
