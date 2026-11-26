"""Persistence for user questions and safe source references, without AI content."""
import re
from urllib.parse import urlsplit, urlunsplit

from services.supabase_client import get_supabase

ALLOWED_SOURCE_HOSTS = {
    "docs.google.com",
    "drive.google.com",
    "mail.google.com",
    "sheets.google.com",
    "excel.office.com",
    "onedrive.live.com",
    "outlook.live.com",
    "outlook.office.com",
    "outlook.office365.com",
    "word.office.com",
    "powerpoint.office.com",
}
ALLOWED_SOURCE_REF_KINDS = {
    "gmail_message",
    "google_document",
    "google_spreadsheet",
    "google_presentation",
}
MAX_HISTORY_PROMPT_CHARS = 10000


def sanitize_history_prompt(value: str | None) -> str:
    if not isinstance(value, str):
        return ""
    return value.replace("\x00", "").strip()[:MAX_HISTORY_PROMPT_CHARS]


def sanitize_source_refs(source_refs: list[dict] | None) -> list[dict]:
    if not isinstance(source_refs, list):
        return []

    safe_refs = []
    seen = set()
    for source_ref in source_refs[:10]:
        if not isinstance(source_ref, dict):
            continue
        provider = source_ref.get("provider")
        kind = source_ref.get("kind")
        identifier = source_ref.get("id")
        if (
            provider != "google"
            or not isinstance(kind, str)
            or kind not in ALLOWED_SOURCE_REF_KINDS
            or not isinstance(identifier, str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", identifier)
        ):
            continue
        key = (kind, identifier)
        if key in seen:
            continue
        seen.add(key)
        safe_refs.append({"provider": provider, "kind": kind, "id": identifier})
    return safe_refs


def sanitize_source_url(value: str | None) -> str | None:
    if not isinstance(value, str) or not value or len(value) > 2048:
        return None

    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        return None

    if (
        parsed.scheme != "https"
        or parsed.hostname not in ALLOWED_SOURCE_HOSTS
        or parsed.username
        or parsed.password
        or port not in (None, 443)
    ):
        return None

    return urlunsplit(("https", parsed.netloc, parsed.path, "", ""))


def save_conversation(
    user_id: str,
    client: str,
    action: str,
    source_url: str | None = None,
    source_urls: list[str] | None = None,
    prompt: str | None = None,
    source_refs: list[dict] | None = None,
) -> None:
    safe_client = client if isinstance(client, str) and client in {"chrome", "office"} else "unknown"
    safe_source_url = sanitize_source_url(source_url)
    requested_source_urls = source_urls[:10] if isinstance(source_urls, list) else []
    if safe_source_url:
        requested_source_urls.insert(0, safe_source_url)
    safe_source_urls = list(dict.fromkeys(
        safe_url
        for safe_url in (
            sanitize_source_url(url)
            for url in requested_source_urls
        )
        if safe_url
    ))[:10]

    get_supabase().table("ai_conversation_history").insert({
        "user_id": user_id,
        "client": safe_client,
        "action": action,
        "prompt": sanitize_history_prompt(prompt),
        "response": {},
        "source_url": safe_source_url or (safe_source_urls[0] if safe_source_urls else None),
        "source_urls": safe_source_urls,
        "source_refs": sanitize_source_refs(source_refs),
    }).execute()


def list_conversations(user_id: str, limit: int = 30, offset: int = 0) -> list[dict]:
    result = (
        get_supabase()
        .table("ai_conversation_history")
        .select("id,client,action,prompt,source_url,source_urls,source_refs,created_at")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .range(offset, offset + limit - 1)
        .execute()
    )
    return [
        {
            **item,
            "prompt": sanitize_history_prompt(item.get("prompt")),
            "source_refs": sanitize_source_refs(item.get("source_refs")),
        }
        for item in result.data
    ]


def delete_conversations(user_id: str) -> None:
    get_supabase().table("ai_conversation_history").delete().eq("user_id", user_id).execute()
