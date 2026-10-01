"""Persistence for cross-client AI history and selected history context."""
import json
from uuid import UUID

from services.supabase_client import get_supabase

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





