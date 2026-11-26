from unittest.mock import patch

from app import create_app
from services.ai_service import MAX_CONTEXT_CHARS
from services.history_service import list_conversations, save_conversation, sanitize_source_url


USER = {"id": "user-1", "email": "user@example.com", "tier": "free"}


def test_history_requires_a_session():
    app = create_app()

    with app.test_client() as client:
        response = client.get("/api/history")

    assert response.status_code == 401


def test_history_lists_only_authenticated_user_history():
    app = create_app()
    saved_items = [{"id": "history-1", "action": "analyze-text", "client": "chrome"}]

    with app.test_client() as client, patch(
        "utils.auth_decorator.get_user_by_session_token", return_value=USER
    ), patch("routes.history.list_conversations", return_value=saved_items) as list_items:
        response = client.get("/api/history", headers={"X-Session-Token": "session-1"})

    assert response.status_code == 200
    assert response.get_json()["history"] == saved_items
    list_items.assert_called_once_with("user-1", 31, 0)


def test_history_clear_is_scoped_to_authenticated_user():
    app = create_app()

    with app.test_client() as client, patch(
        "utils.auth_decorator.get_user_by_session_token", return_value=USER
    ), patch("routes.history.delete_conversations") as delete_items:
        response = client.delete("/api/history", headers={"X-Session-Token": "session-1"})

    assert response.status_code == 204
    delete_items.assert_called_once_with("user-1")


def test_successful_ai_request_is_saved_to_account_history():
    app = create_app()

    with app.test_client() as client, patch(
        "utils.auth_decorator.get_user_by_session_token", return_value=USER
    ), patch("utils.auth_decorator.has_access", return_value=True), patch(
        "utils.auth_decorator.check_and_consume_quota", return_value=(True, 49)
    ), patch(
        "routes.ai.generate_text", return_value={"generated": "A concise reply."}
    ) as generate, patch(
        "routes.ai.save_conversation"
    ) as save_history, patch("routes.ai.log_ai_usage"):
        response = client.post(
            "/api/ai/generate-text",
            json={
                "prompt": "Draft a reply",
                "client": "chrome",
                "source_url": "https://docs.google.com/document/d/doc-1/edit?private=query",
                "context": "Selected reference text",
                "source_refs": [{"provider": "google", "kind": "google_document", "id": "doc-1"}],
            },
            headers={"X-Session-Token": "session-1"},
        )

    assert response.status_code == 200
    generate.assert_called_once_with("Draft a reply", context="Selected reference text")
    save_history.assert_called_once_with(
        "user-1", "chrome", "generate-text",
        "https://docs.google.com/document/d/doc-1/edit?private=query",
        None,
        "Draft a reply",
        [{"provider": "google", "kind": "google_document", "id": "doc-1"}],
    )


def test_history_insert_contains_question_and_safe_source_references_only():
    with patch("services.history_service.get_supabase") as get_supabase:
        save_conversation(
            "user-1",
            "chrome",
            "analyze-text",
            "https://mail.google.com/mail/u/0/#inbox?search=private",
            prompt="Summarize this email",
            source_refs=[
                {"provider": "google", "kind": "gmail_message", "id": "message_1"},
                {"provider": "microsoft", "kind": "gmail_message", "id": "unsafe"},
                {"provider": "google", "kind": "google_document", "id": "bad/id"},
            ],
        )

    inserted = get_supabase.return_value.table.return_value.insert.call_args.args[0]
    assert inserted == {
        "user_id": "user-1",
        "client": "chrome",
        "action": "analyze-text",
        "prompt": "Summarize this email",
        "response": {},
        "source_url": "https://mail.google.com/mail/u/0/",
        "source_urls": ["https://mail.google.com/mail/u/0/"],
        "source_refs": [{"provider": "google", "kind": "gmail_message", "id": "message_1"}],
    }


def test_history_listing_returns_questions_and_source_refs_but_not_responses():
    with patch("services.history_service.get_supabase") as get_supabase:
        query = get_supabase.return_value.table.return_value.select.return_value
        query.eq.return_value.order.return_value.range.return_value.execute.return_value.data = []
        assert list_conversations("user-1") == []

    get_supabase.return_value.table.return_value.select.assert_called_once_with(
        "id,client,action,prompt,source_url,source_urls,source_refs,created_at"
    )


def test_source_url_must_be_https_and_from_a_supported_service():
    assert sanitize_source_url("https://docs.google.com/document/d/abc/edit?token=secret") == (
        "https://docs.google.com/document/d/abc/edit"
    )
    assert sanitize_source_url("http://docs.google.com/document/d/abc") is None
    assert sanitize_source_url("https://example.com/document/d/abc") is None


def test_history_stores_only_sanitized_selected_source_links():
    with patch("services.history_service.get_supabase") as get_supabase:
        save_conversation(
            "user-1",
            "chrome",
            "generate-text",
            source_urls=[
                "https://docs.google.com/document/d/doc-1/edit?token=secret",
                "https://mail.google.com/mail/u/0/#inbox",
                "https://attacker.example/file",
            ],
        )

    inserted = get_supabase.return_value.table.return_value.insert.call_args.args[0]
    assert inserted["source_urls"] == [
        "https://docs.google.com/document/d/doc-1/edit",
        "https://mail.google.com/mail/u/0/",
    ]


def test_history_prompt_is_trimmed_and_capped():
    with patch("services.history_service.get_supabase") as get_supabase:
        save_conversation(
            "user-1",
            "chrome",
            "generate-text",
            prompt=f"  {'q' * 10001}  ",
        )

    inserted = get_supabase.return_value.table.return_value.insert.call_args.args[0]
    assert len(inserted["prompt"]) == 10000
    assert inserted["prompt"] == "q" * 10000


def test_ai_route_rejects_oversized_source_context_before_provider_call():
    app = create_app()

    with app.test_client() as client, patch(
        "utils.auth_decorator.get_user_by_session_token", return_value=USER
    ), patch("utils.auth_decorator.has_access", return_value=True), patch(
        "utils.auth_decorator.check_and_consume_quota", return_value=(True, 49)
    ), patch("routes.ai.generate_text") as generate:
        response = client.post(
            "/api/ai/generate-text",
            json={"prompt": "Answer", "context": "x" * (MAX_CONTEXT_CHARS + 1)},
            headers={"X-Session-Token": "session-1"},
        )

    assert response.status_code == 400
    assert "too large" in response.get_json()["error"]
    generate.assert_not_called()


def test_google_sheet_edit_route_returns_preview_and_saves_question():
    app = create_app()
    values = [["Old label", "=SUM(B1:B2)"]]

    with app.test_client() as client, patch(
        "utils.auth_decorator.get_user_by_session_token", return_value=USER
    ), patch("utils.auth_decorator.has_access", return_value=True), patch(
        "utils.auth_decorator.check_and_consume_quota", return_value=(True, 49)
    ), patch(
        "routes.ai.edit_spreadsheet_range",
        return_value={"correctedValues": [["New label", "=SUM(B1:B2)"]], "notes": []},
    ) as edit_range, patch("routes.ai.save_conversation") as save_history, patch(
        "routes.ai.log_ai_usage"
    ):
        response = client.post(
            "/api/ai/edit-range",
            json={
                "values": values,
                "instruction": "Rename the label",
                "source_url": "https://docs.google.com/spreadsheets/d/sheet-1/edit",
                "source_urls": ["https://docs.google.com/spreadsheets/d/sheet-1/edit"],
                "client": "chrome",
            },
            headers={"X-Session-Token": "session-1"},
        )

    assert response.status_code == 200
    assert response.get_json()["correctedValues"] == [["New label", "=SUM(B1:B2)"]]
    edit_range.assert_called_once_with(values, "Rename the label", context=None)
    save_history.assert_called_once_with(
        "user-1",
        "chrome",
        "edit-range",
        "https://docs.google.com/spreadsheets/d/sheet-1/edit",
        ["https://docs.google.com/spreadsheets/d/sheet-1/edit"],
        "Rename the label",
        None,
    )
