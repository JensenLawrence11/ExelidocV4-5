"""
Endpoints the Office add-in and browser extension both call to get AI
suggestions. Both frontends send plain JSON plus an X-Api-Key header and
never touch the AI provider directly -- the API key stays server-side.
"""
from flask import Blueprint, request, jsonify, g

from services.ai_service import analyze_text, analyze_spreadsheet_range, generate_text
from services.history_service import save_conversation
from services.user_service import log_ai_usage
from utils.auth_decorator import require_subscription

ai_bp = Blueprint("ai", __name__)


def _save_history(action, prompt, result):
    if result.get("error"):
        return
    try:
        data = request.get_json(silent=True) or {}
        save_conversation(
            g.user["id"],
            data.get("client", "unknown"),
            action,
            prompt,
            dict(result),
        )
    except Exception as e:
        print(f"{action}: save_conversation failed -- {e}")


@ai_bp.post("/generate-text")
@require_subscription
def generate_text_route():
    """
    Used by: extension popup, Office add-in "generate" panel.
    Header: X-Api-Key: <user's key>
    Body: { "prompt": "write a short email asking for a meeting reschedule" }
    Returns: { "generated": "..." }
    """
    data = request.get_json(silent=True) or {}
    prompt = data.get("prompt", "")
    if not isinstance(prompt, str):
        return jsonify(error="Prompt must be text"), 400
    if not prompt.strip():
        return jsonify(error="No prompt provided"), 400

    result = generate_text(prompt)
    _save_history("generate-text", prompt, result)
    try:
        log_ai_usage(g.user["id"], "generate-text")
    except Exception as e:
        print(f"generate_text_route: log_ai_usage failed -- {e}")
    result["remaining_requests"] = g.remaining_requests
    result["tier"] = g.user.get("tier")
    return jsonify(result)


@ai_bp.post("/analyze-text")
@require_subscription
def analyze_text_route():
    """
    Used by: Gmail/Google Docs content scripts, Word/Outlook task pane.
    Header: X-Api-Key: <user's key>
    Body: { "text": "...", "instruction": "..." }  -- instruction optional
    Returns: { "corrected": "...", "suggestions": [ ... ] }
    """
    data = request.get_json(silent=True) or {}
    text = data.get("text", "")
    instruction = data.get("instruction") or ""
    if not isinstance(text, str) or not isinstance(instruction, str):
        return jsonify(error="Text and instruction must be text"), 400
    print(f"DEBUG instruction received: {instruction!r}")
    if not text.strip() and not instruction.strip():
        return jsonify(error="No text provided"), 400

    result = analyze_text(text, instruction)
    _save_history("analyze-text", instruction or "Analyze selected text", result)
    try:
        log_ai_usage(g.user["id"], "analyze-text")
    except Exception as e:
        print(f"analyze_text_route: log_ai_usage failed -- {e}")
    result["remaining_requests"] = g.remaining_requests
    result["tier"] = g.user.get("tier")
    return jsonify(result)


@ai_bp.post("/analyze-range")
@require_subscription
def analyze_range_route():
    """
    Used by: Excel task pane.
    Header: X-Api-Key: <user's key>
    Body: { "values": [[...], [...]] }  -- 2D array matching range.values
    Returns: { "correctedValues": [[...], [...]], "notes": [ ... ] }
    """
    data = request.get_json(silent=True) or {}
    values = data.get("values")
    if not values:
        return jsonify(error="No range values provided"), 400
    if not isinstance(values, list) or any(not isinstance(row, list) for row in values):
        return jsonify(error="Range values must be a 2D array"), 400

    result = analyze_spreadsheet_range(values)
    _save_history("analyze-range", "Clean up selected Excel range", result)
    try:
        log_ai_usage(g.user["id"], "analyze-range")
    except Exception as e:
        print(f"analyze_range_route: log_ai_usage failed -- {e}")
    result["remaining_requests"] = g.remaining_requests
    result["tier"] = g.user.get("tier")
    return jsonify(result)