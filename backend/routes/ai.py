"""
Endpoints the Office add-in and browser extension both call to get AI
suggestions. Both frontends send plain JSON plus an X-Api-Key header and
never touch the AI provider directly -- the API key stays server-side.
"""
import logging

from flask import Blueprint, request, jsonify, g

from services.ai_service import (
    MAX_CONTEXT_CHARS,
    AIServiceError,
    analyze_text,
    edit_spreadsheet_range,
    format_spreadsheet_range,
    format_google_document,
    analyze_spreadsheet_range,
    generate_text,
)
from services.history_service import save_conversation
from services.user_service import log_ai_usage
from services.monitoring_service import capture_exception
from utils.auth_decorator import require_subscription

ai_bp = Blueprint("ai", __name__)


def _save_history(action):
    try:
        data = request.get_json(silent=True) or {}
        save_conversation(
            g.user["id"],
            data.get("client", "unknown"),
            action,
            data.get("source_url"),
            data.get("source_urls"),
            data.get("prompt") if isinstance(data.get("prompt"), str) else data.get("instruction"),
            data.get("source_refs"),
        )
    except Exception as error:
        logging.error(
            "history_save_failed action=%s exception_type=%s",
            action,
            type(error).__name__,
        )
        capture_exception(error)


def _get_request_context(data):
    context = data.get("context", "")
    if context is None:
        return ""
    if not isinstance(context, str):
        raise ValueError("Reference context must be text")
    if len(context) > MAX_CONTEXT_CHARS:
        raise ValueError("Reference context is too large")
    return context


def _service_error_response(result):
    error = result.get("error")
    if not error:
        return None
    status = 413 if "too large" in error.lower() else 502
    return jsonify(error=error), status


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

    try:
        context = _get_request_context(data)
    except ValueError as error:
        return jsonify(error=str(error)), 400

    try:
        result = generate_text(prompt, context=context)
    except AIServiceError as error:
        return jsonify(error=str(error)), error.status_code
    error_response = _service_error_response(result)
    if error_response:
        return error_response
    _save_history("generate-text")
    try:
        log_ai_usage(g.user["id"], "generate-text")
    except Exception as error:
        logging.error("ai_usage_log_failed action=generate-text exception_type=%s", type(error).__name__)
        capture_exception(error)
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
    if not text.strip() and not instruction.strip():
        return jsonify(error="No text provided"), 400

    try:
        context = _get_request_context(data)
    except ValueError as error:
        return jsonify(error=str(error)), 400

    try:
        result = analyze_text(text, instruction, context=context or None)
    except AIServiceError as error:
        return jsonify(error=str(error)), error.status_code
    error_response = _service_error_response(result)
    if error_response:
        return error_response
    _save_history("analyze-text")
    try:
        log_ai_usage(g.user["id"], "analyze-text")
    except Exception as error:
        logging.error("ai_usage_log_failed action=analyze-text exception_type=%s", type(error).__name__)
        capture_exception(error)
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

    try:
        context = _get_request_context(data)
    except ValueError as error:
        return jsonify(error=str(error)), 400

    try:
        result = analyze_spreadsheet_range(values, context=context or None)
    except AIServiceError as error:
        return jsonify(error=str(error)), error.status_code
    error_response = _service_error_response(result)
    if error_response:
        return error_response
    _save_history("analyze-range")
    try:
        log_ai_usage(g.user["id"], "analyze-range")
    except Exception as error:
        logging.error("ai_usage_log_failed action=analyze-range exception_type=%s", type(error).__name__)
        capture_exception(error)
    result["remaining_requests"] = g.remaining_requests
    result["tier"] = g.user.get("tier")
    return jsonify(result)


@ai_bp.post("/edit-range")
@require_subscription
def edit_range_route():
    """Return a reviewable proposal for editing a spreadsheet cell range."""
    data = request.get_json(silent=True) or {}
    values = data.get("values")
    instruction = data.get("instruction", "")
    if (
        not isinstance(values, list)
        or not values
        or any(not isinstance(row, list) or not row for row in values)
    ):
        return jsonify(error="Range values must be a non-empty 2D array"), 400
    if any(len(row) != len(values[0]) for row in values):
        return jsonify(error="Range values must have the same number of cells in every row"), 400
    if any(
        value is not None and not isinstance(value, (str, int, float, bool))
        for row in values
        for value in row
    ):
        return jsonify(error="Spreadsheet cells must be text, numbers, booleans, or empty"), 400
    if not isinstance(instruction, str) or not instruction.strip():
        return jsonify(error="Enter an instruction for the spreadsheet edit"), 400

    try:
        context = _get_request_context(data)
    except ValueError as error:
        return jsonify(error=str(error)), 400

    try:
        result = edit_spreadsheet_range(values, instruction, context=context or None)
    except AIServiceError as error:
        return jsonify(error=str(error)), error.status_code
    error_response = _service_error_response(result)
    if error_response:
        return error_response
    _save_history("edit-range")
    try:
        log_ai_usage(g.user["id"], "edit-range")
    except Exception as error:
        logging.error("ai_usage_log_failed action=edit-range exception_type=%s", type(error).__name__)
        capture_exception(error)
    result["remaining_requests"] = g.remaining_requests
    result["tier"] = g.user.get("tier")
    return jsonify(result)


@ai_bp.post("/format-range")
@require_subscription
def format_range_route():
    """Return a reviewable, constrained formatting plan for a spreadsheet range."""
    data = request.get_json(silent=True) or {}
    values = data.get("values")
    instruction = data.get("instruction", "")
    if (
        not isinstance(values, list)
        or not values
        or any(not isinstance(row, list) or not row for row in values)
    ):
        return jsonify(error="Range values must be a non-empty 2D array"), 400
    if any(len(row) != len(values[0]) for row in values):
        return jsonify(error="Range values must have the same number of cells in every row"), 400
    if not isinstance(instruction, str) or not instruction.strip():
        return jsonify(error="Enter formatting instructions"), 400

    try:
        context = _get_request_context(data)
    except ValueError as error:
        return jsonify(error=str(error)), 400

    try:
        result = format_spreadsheet_range(values, instruction, context=context or None)
    except AIServiceError as error:
        return jsonify(error=str(error)), error.status_code
    error_response = _service_error_response(result)
    if error_response:
        return error_response
    _save_history("format-range")
    try:
        log_ai_usage(g.user["id"], "format-range")
    except Exception as error:
        logging.error(
            "ai_usage_log_failed action=format-range exception_type=%s",
            type(error).__name__,
        )
        capture_exception(error)
    result["remaining_requests"] = g.remaining_requests
    result["tier"] = g.user.get("tier")
    return jsonify(result)


@ai_bp.post("/format-document")
@require_subscription
def format_document_route():
    """Return a reviewable, constrained formatting plan for a Google Doc."""
    data = request.get_json(silent=True) or {}
    paragraphs = data.get("paragraphs")
    instruction = data.get("instruction", "")
    if (
        not isinstance(paragraphs, list)
        or not paragraphs
        or len(paragraphs) > 500
        or any(not isinstance(paragraph, str) for paragraph in paragraphs)
    ):
        return jsonify(error="Document paragraphs must be a non-empty list of text"), 400
    if not isinstance(instruction, str) or not instruction.strip():
        return jsonify(error="Enter formatting instructions"), 400
    try:
        context = _get_request_context(data)
    except ValueError as error:
        return jsonify(error=str(error)), 400

    try:
        result = format_google_document(paragraphs, instruction, context=context or None)
    except AIServiceError as error:
        return jsonify(error=str(error)), error.status_code
    error_response = _service_error_response(result)
    if error_response:
        return error_response
    _save_history("format-document")
    try:
        log_ai_usage(g.user["id"], "format-document")
    except Exception as error:
        logging.error(
            "ai_usage_log_failed action=format-document exception_type=%s",
            type(error).__name__,
        )
        capture_exception(error)
    result["remaining_requests"] = g.remaining_requests
    result["tier"] = g.user.get("tier")
    return jsonify(result)