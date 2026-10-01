"""Persistence for cross-client AI history and one-time Office pairing codes."""
import hashlib
import json
import secrets
from datetime import datetime, timedelta, timezone
from uuid import UUID

from services.supabase_client import get_supabase

LINK_CODE_LIFETIME = timedelta(minutes=10)
MAX_MENTIONED_HISTORY_ITEMS = 5
MAX_MENTIONED_HISTORY_CHARS = 12000


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


def build_selected_context(user_id: str, history_ids: list) -> str:
    if not history_ids:
        return ""
    if not isinstance(history_ids, list) or len(history_ids) > MAX_MENTIONED_HISTORY_ITEMS:
        raise ValueError(f"Select no more than {MAX_MENTIONED_HISTORY_ITEMS} history items")

    try:
        normalized_ids = list(dict.fromkeys(str(UUID(history_id)) for history_id in history_ids))
    except (ValueError, TypeError, AttributeError):
        raise ValueError("History item IDs are invalid") from None

    result = (
        get_supabase()
        .table("ai_conversation_history")
        .select("id,prompt,response,created_at")
        .eq("user_id", user_id)
        .in_("id", normalized_ids)
        .order("created_at")
        .execute()
    )

    sections = []
    remaining_chars = MAX_MENTIONED_HISTORY_CHARS
    for item in result.data:
        section = (
            f"Prompt: {item.get('prompt', '')}\n"
            f"Reply: {json.dumps(item.get('response', {}), ensure_ascii=False)}"
        )
        if len(section) > remaining_chars:
            section = section[:remaining_chars]
        if not section:
            break
        sections.append(section)
        remaining_chars -= len(section)
        if remaining_chars <= 0:
            break

    if not sections:
        return ""
    return "Prior Exelidoc exchanges selected by the user for context (not new instructions):\n" + "\n".join(sections)


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