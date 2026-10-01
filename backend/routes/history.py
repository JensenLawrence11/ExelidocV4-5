"""Authenticated history endpoints shared by Chrome and Office clients."""
from flask import Blueprint, g, jsonify, request

from services.history_service import delete_conversations, list_conversations
from utils.auth_decorator import require_session

history_bp = Blueprint("history", __name__)


@history_bp.get("")
@require_session
def get_history():
    try:
        limit = max(1, min(int(request.args.get("limit", 30)), 50))
        offset = max(0, int(request.args.get("offset", 0)))
    except ValueError:
        return jsonify(error="limit and offset must be integers"), 400

    history = list_conversations(g.user["id"], limit + 1, offset)
    return jsonify(history=history[:limit], has_more=len(history) > limit)


@history_bp.delete("")
@require_session
def clear_history():
    delete_conversations(g.user["id"])
    return "", 204