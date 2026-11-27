"""Shared fixed-window rate limits backed by Supabase."""
import hashlib
import hmac

from config import Config
from services.supabase_client import get_supabase


def consume_rate_limit(
    action: str,
    identity: str,
    max_requests: int,
    window_seconds: int,
) -> tuple[bool, int]:
    key_hash = hmac.new(
        Config.SECRET_KEY.encode("utf-8"),
        f"{action}\0{identity}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    result = get_supabase().rpc(
        "consume_api_rate_limit",
        {
            "p_action": action,
            "p_key_hash": key_hash,
            "p_limit": max_requests,
            "p_window_seconds": window_seconds,
        },
    ).execute()

    data = result.data
    if isinstance(data, dict):
        row = data
    elif isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict):
        row = data[0]
    else:
        raise RuntimeError("API rate-limit RPC returned an invalid result")

    allowed = row.get("allowed")
    retry_after = row.get("retry_after_seconds")
    if not isinstance(allowed, bool) or not isinstance(retry_after, int):
        raise RuntimeError("API rate-limit RPC returned an invalid result")
    return allowed, max(0, retry_after)
