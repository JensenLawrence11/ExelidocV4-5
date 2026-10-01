"""Persistence for cross-client AI history and one-time Office pairing codes."""
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from services.supabase_client import get_supabase

LINK_CODE_LIFETIME = timedelta(minutes=10)


def save_conversation(user_id: str, client: str, action: str, prompt: str, response: dict) -> None:
    supabase = get_supabase()
    supabase.table("ai_conversation_history").insert({
        "user_id": user_id,
        "client": client if isinstance(client, str) and client in {"chrome", "office"} else "unknown",
        "action": action,
        "prompt": prompt[:10000],
        "response": response,
    }).execute()


def list_conversations(user_id: str, limit: int = 30, offset: int = 0) -> list[dict]:
    supabase = get_supabase()
    result = (
        supabase.table("ai_conversation_history")
        .select("id,client,action,prompt,response,created_at")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .range(offset, offset + limit - 1)
        .execute()
    )
    return result.data


def delete_conversations(user_id: str) -> None:
    get_supabase().table("ai_conversation_history").delete().eq("user_id", user_id).execute()


def create_link_code(user_id: str) -> tuple[str, str]:
    supabase = get_supabase()
    supabase.table("session_link_codes").delete().lt(
        "expires_at", datetime.now(timezone.utc).isoformat()
    ).execute()
    supabase.table("session_link_codes").delete().eq("user_id", user_id).is_(
        "redeemed_at", "null"
    ).execute()
    code = secrets.token_urlsafe(9).replace("-", "").replace("_", "").upper()
    expires_at = datetime.now(timezone.utc) + LINK_CODE_LIFETIME
    code_hash = hashlib.sha256(code.encode("ascii")).hexdigest()
    supabase.table("session_link_codes").insert({
        "code_hash": code_hash,
        "user_id": user_id,
        "expires_at": expires_at.isoformat(),
    }).execute()
    return code, expires_at.isoformat()


def redeem_link_code(code: str) -> str | None:
    normalized_code = "".join(code.split()).upper()
    if not normalized_code or len(normalized_code) > 40:
        return None

    code_hash = hashlib.sha256(normalized_code.encode("ascii", errors="ignore")).hexdigest()
    now = datetime.now(timezone.utc).isoformat()
    result = (
        get_supabase()
        .table("session_link_codes")
        .update({"redeemed_at": now})
        .eq("code_hash", code_hash)
        .is_("redeemed_at", "null")
        .gt("expires_at", now)
        .select("user_id")
        .execute()
    )
    return result.data[0]["user_id"] if result.data else None