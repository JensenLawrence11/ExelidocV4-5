"""
Endpoints the Office add-in and browser extension both call to get AI
suggestions. Both frontends send plain JSON plus an X-Api-Key header and
never touch the AI provider directly -- the API key stays server-side.
"""
from flask import Blueprint, request, jsonify, g

from services.ai_service import analyze_text, analyze_spreadsheet_range, generate_text
from services.user_service import log_ai_usage
from utils.auth_decorator import require_subscription

ai_bp = Blueprint("ai", __name__)


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
    if not prompt.strip():
        return jsonify(error="No prompt provided"), 400

    result = generate_text(prompt)
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
    print(f"DEBUG instruction received: {instruction!r}")
    if not text.strip() and not instruction.strip():
        return jsonify(error="No text provided"), 400

    result = analyze_text(text, instruction)
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

    result = analyze_spreadsheet_range(values)
    try:
        log_ai_usage(g.user["id"], "analyze-range")
    except Exception as e:
        print(f"analyze_range_route: log_ai_usage failed -- {e}")
    result["remaining_requests"] = g.remaining_requests
    result["tier"] = g.user.get("tier")
    return jsonify(result)