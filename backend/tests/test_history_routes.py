from unittest.mock import patch

from app import create_app
from services.history_service import build_selected_context


USER = {"id": "user-1", "email": "user@example.com", "tier": "free"}


def test_history_requires_a_session():
    app = create_app()

    with app.test_client() as client:
        response = client.get("/api/history")

    assert response.status_code == 401


def test_history_lists_only_authenticated_user_history():
    app = create_app()
    saved_items = [{"id": "history-1", "prompt": "Draft a reply"}]

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


def test_office_link_code_requires_session_and_returns_code():
    app = create_app()

    with app.test_client() as client, patch(
        "utils.auth_decorator.get_user_by_session_token", return_value=USER
    ), patch("routes.auth.create_link_code", return_value=("A1B2C3D4", "expires")) as create_code:
        response = client.post(
            "/api/auth/link-code", headers={"X-Session-Token": "session-1"}
        )

    assert response.status_code == 200
    assert response.get_json()["code"] == "A1B2C3D4"
    create_code.assert_called_once_with("user-1")


def test_redeemed_office_link_code_returns_shared_session():
    app = create_app()
    linked_user = {**USER, "session_token": "shared-session"}

    with app.test_client() as client, patch(
        "routes.auth.redeem_link_code", return_value="user-1"
    ), patch("routes.auth.get_user_by_id", return_value=linked_user):
        response = client.post("/api/auth/redeem-link-code", json={"code": "A1B2C3D4"})

    assert response.status_code == 200
    assert response.get_json()["session_token"] == "shared-session"


def test_successful_ai_request_is_saved_to_account_history():
    app = create_app()

    with app.test_client() as client, patch(
        "utils.auth_decorator.get_user_by_session_token", return_value=USER
    ), patch("utils.auth_decorator.has_access", return_value=True), patch(
        "utils.auth_decorator.check_and_consume_quota", return_value=(True, 49)
    ), patch("routes.ai.build_selected_context", return_value="Earlier selected exchange") as get_context, patch(
        "routes.ai.generate_text", return_value={"generated": "A concise reply."}
    ) as generate, patch(
        "routes.ai.save_conversation"
    ) as save_history, patch("routes.ai.log_ai_usage"):
        response = client.post(
            "/api/ai/generate-text",
            json={"prompt": "Draft a reply", "client": "chrome", "history_ids": ["history-1"]},
            headers={"X-Session-Token": "session-1"},
        )

    assert response.status_code == 200
    get_context.assert_called_once_with("user-1", ["history-1"])
    generate.assert_called_once_with("Draft a reply", context="Earlier selected exchange")
    save_history.assert_called_once_with(
        "user-1", "chrome", "generate-text", "Draft a reply", {"generated": "A concise reply."}
    )


def test_selected_history_context_is_owner_scoped_and_formatted():
    saved_item = {
        "id": "history-1",
        "prompt": "Use a friendly tone",
        "response": {"generated": "Hello there"},
        "created_at": "2026-10-01T00:00:00Z",
    }
    with patch("services.history_service.get_supabase") as get_supabase:
        query = get_supabase.return_value.table.return_value.select.return_value
        query.eq.return_value.in_.return_value.order.return_value.execute.return_value.data = [saved_item]
        context = build_selected_context("user-1", ["00000000-0000-0000-0000-000000000001"])

    query.eq.assert_called_once_with("user_id", "user-1")
    assert "Use a friendly tone" in context
    assert "Hello there" in context


def test_selected_history_context_limits_entries_before_database_lookup():
    with patch("services.history_service.get_supabase") as get_supabase:
        try:
            build_selected_context("user-1", ["entry"] * 6)
        except ValueError as error:
            assert "no more than 5" in str(error)
        else:
            raise AssertionError("Expected the selected history limit to be enforced")

    get_supabase.assert_not_called()