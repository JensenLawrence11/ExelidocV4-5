"""
All reads/writes to the `users` and `ai_usage_logs` tables live here, kept
separate from the route layer.
"""
from datetime import datetime, timezone, timedelta

from services.supabase_client import get_supabase
from config import Config

PERIOD_LENGTH = timedelta(days=30)
ACTIVE_SUBSCRIPTION_STATUSES = {"active", "trialing"}


def create_user(email: str, tier: str = "free") -> dict:
    """Free tier: called directly on signup. Paid tiers: called from the
    Stripe webhook once checkout completes."""
    supabase = get_supabase()
    result = supabase.table("users").insert({
        "email": email,
        "tier": tier,
        "requests_used": 0,
        "period_reset_at": (datetime.now(timezone.utc) + PERIOD_LENGTH).isoformat(),
    }).execute()
    return result.data[0]


def get_user_by_api_key(api_key: str) -> dict | None:
    supabase = get_supabase()
    result = supabase.table("users").select("*").eq("api_key", api_key).execute()
    return result.data[0] if result.data else None


def get_user_by_email(email: str) -> dict | None:
    supabase = get_supabase()
    result = supabase.table("users").select("*").eq("email", email).execute()
    return result.data[0] if result.data else None


def get_user_by_stripe_customer(stripe_customer_id: str) -> dict | None:
    supabase = get_supabase()
    result = (
        supabase.table("users")
        .select("*")
        .eq("stripe_customer_id", stripe_customer_id)
        .execute()
    )
    return result.data[0] if result.data else None


def set_subscription_status(
    stripe_customer_id: str,
    status: str,
    stripe_subscription_id: str | None = None,
) -> None:
    """Called from the Stripe webhook when subscription state changes."""
    supabase = get_supabase()
    update = {"subscription_status": status}
    if stripe_subscription_id:
        update["stripe_subscription_id"] = stripe_subscription_id
    # A canceled/expired paid subscription drops the account back to free
    # rather than leaving it stuck on a paid tier with no active billing.
    if status in ("canceled", "past_due"):
        update["tier"] = "free"
    supabase.table("users").update(update).eq(
        "stripe_customer_id", stripe_customer_id
    ).execute()


def set_user_tier(stripe_customer_id: str, tier: str) -> None:
    """Called from the Stripe webhook to record which paid tier was purchased."""
    supabase = get_supabase()
    supabase.table("users").update({"tier": tier}).eq(
        "stripe_customer_id", stripe_customer_id
    ).execute()


def link_stripe_customer(email: str, stripe_customer_id: str) -> None:
    supabase = get_supabase()
    supabase.table("users").update({"stripe_customer_id": stripe_customer_id}).eq(
        "email", email
    ).execute()


def log_ai_usage(user_id: str, endpoint: str) -> None:
    """Detailed per-call log, separate from the fast requests_used counter --
    useful for debugging/analytics, not used for quota enforcement itself."""
    supabase = get_supabase()
    supabase.table("ai_usage_logs").insert(
        {"user_id": user_id, "endpoint": endpoint}
    ).execute()


def has_access(user: dict) -> bool:
    """
    Free tier always has access (subject to its quota, checked separately).
    Paid tiers need Stripe to currently show them as active/trialing.
    """
    if user.get("tier", "free") == "free":
        return True
    return user.get("subscription_status") in ACTIVE_SUBSCRIPTION_STATUSES


def _parse_reset_at(value) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    # Supabase returns ISO timestamps; normalize the "Z" suffix for fromisoformat.
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def check_and_consume_quota(user: dict) -> tuple[bool, int]:
    """
    Enforces the monthly request limit for the user's tier. Lazily resets
    the counter if the stored period_reset_at has passed (no cron job
    needed -- the reset just happens on the next request after it expires).

    Returns (allowed, remaining_after_this_call). If allowed, this call has
    already been counted against the quota.
    """
    supabase = get_supabase()
    tier = user.get("tier", "free")
    limit = Config.TIER_LIMITS.get(tier, Config.TIER_LIMITS["free"])

    now = datetime.now(timezone.utc)
    reset_at = _parse_reset_at(user.get("period_reset_at"))
    requests_used = user.get("requests_used", 0)

    if reset_at is None or now >= reset_at:
        requests_used = 0
        reset_at = now + PERIOD_LENGTH
        supabase.table("users").update({
            "requests_used": 0,
            "period_reset_at": reset_at.isoformat(),
        }).eq("id", user["id"]).execute()

    if requests_used >= limit:
        return False, 0

    new_count = requests_used + 1
    supabase.table("users").update({"requests_used": new_count}).eq(
        "id", user["id"]
    ).execute()
    return True, limit - new_count
