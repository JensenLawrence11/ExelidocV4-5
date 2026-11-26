"""
All actual AI-provider calls live here, isolated from the Flask route layer.
Uses Google's Gemini REST API directly, with an atomic monthly spend cap.
"""
import json
import logging
import re

import requests
from config import Config
from services.ai_budget_service import (
    release_monthly_ai_budget,
    reserve_monthly_ai_budget,
    settle_monthly_ai_budget,
)

GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"
GEMINI_MODEL_NANODOLLARS_PER_TOKEN = {
    "gemini-4-hydrogen": {
        "input": 1_500,
        "output": 7_500,
    },
}
GEMINI_PROMPT_TOKEN_OVERHEAD = 512


class AIServiceError(Exception):
    """A safe-to-return error raised when the configured AI service fails."""

    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


class AIMonthlyBudgetExceeded(AIServiceError):
    def __init__(self):
        super().__init__(
            "The monthly AI spending limit has been reached. Try again next month.",
            status_code=429,
        )


def _estimate_max_request_cost(system_prompt: str, user_content: str) -> int:
    rates = GEMINI_MODEL_NANODOLLARS_PER_TOKEN.get(Config.GEMINI_MODEL)
    if not rates:
        raise AIServiceError(
            "The configured Gemini model is not covered by the monthly spend limit.",
            status_code=503,
        )
    if Config.AI_MAX_OUTPUT_TOKENS <= 0:
        raise AIServiceError("AI output token limit must be positive.", status_code=503)

    prompt_bytes = (
        len(system_prompt.encode("utf-8"))
        + len(user_content.encode("utf-8"))
        + GEMINI_PROMPT_TOKEN_OVERHEAD
    )
    return (
        prompt_bytes * rates["input"]
        + Config.AI_MAX_OUTPUT_TOKENS * rates["output"]
    )


def _record_budget_settlement(month_start, reservation: int, actual: int) -> None:
    try:
        settle_monthly_ai_budget(month_start, reservation, actual)
    except Exception as error:
        logging.exception("Could not settle Gemini monthly budget reservation")
        raise AIServiceError(
            "AI usage could not be recorded. Try again later.",
            status_code=503,
        ) from error


def _release_budget_reservation(month_start, reservation: int) -> None:
    try:
        release_monthly_ai_budget(month_start, reservation)
    except Exception as error:
        logging.exception("Could not release Gemini monthly budget reservation")
        raise AIServiceError(
            "AI budget tracking is unavailable. Try again later.",
            status_code=503,
        ) from error


def _reported_request_cost(data: dict) -> int | None:
    usage = data.get("usageMetadata")
    if not isinstance(usage, dict):
        return None

    prompt_tokens = usage.get("promptTokenCount")
    candidate_tokens = usage.get("candidatesTokenCount")
    thought_tokens = usage.get("thoughtsTokenCount", 0)
    token_counts = (prompt_tokens, candidate_tokens, thought_tokens)
    if any(
        not isinstance(count, int) or isinstance(count, bool) or count < 0
        for count in token_counts
    ):
        return None

    rates = GEMINI_MODEL_NANODOLLARS_PER_TOKEN[Config.GEMINI_MODEL]
    return (
        prompt_tokens * rates["input"]
        + (candidate_tokens + thought_tokens) * rates["output"]
    )


def _call_gemini(system_prompt: str, user_content: str) -> str:
    if not Config.GEMINI_API_KEY:
        raise AIServiceError("AI provider is not configured. Try again later.")

    reservation = _estimate_max_request_cost(system_prompt, user_content)
    try:
        month_start = reserve_monthly_ai_budget(reservation)
    except Exception as error:
        logging.exception("Could not reserve Gemini monthly budget")
        raise AIServiceError(
            "AI budget tracking is unavailable. Try again later.",
            status_code=503,
        ) from error
    if month_start is None:
        raise AIMonthlyBudgetExceeded()

    try:
        response = requests.post(
            f"{GEMINI_API_BASE_URL}/{Config.GEMINI_MODEL}:generateContent",
            headers={
                "x-goog-api-key": Config.GEMINI_API_KEY,
                "Content-Type": "application/json",
            },
            json={
                "systemInstruction": {"parts": [{"text": system_prompt}]},
                "contents": [{"role": "user", "parts": [{"text": user_content}]}],
                "generationConfig": {
                    "temperature": 0,
                    "maxOutputTokens": Config.AI_MAX_OUTPUT_TOKENS,
                    "responseMimeType": "application/json",
                    "thinkingConfig": {"thinkingLevel": "low"},
                },
            },
            timeout=30,
        )
        response.raise_for_status()
    except requests.HTTPError as error:
        status_code = error.response.status_code if error.response is not None else 502
        if 400 <= status_code < 500:
            _release_budget_reservation(month_start, reservation)
        else:
            _record_budget_settlement(month_start, reservation, reservation)
        logging.exception("Gemini API request failed with HTTP %s", status_code)
        raise AIServiceError("Gemini could not complete this request. Try again later.") from error
    except requests.RequestException as error:
        _record_budget_settlement(month_start, reservation, reservation)
        logging.exception("Gemini API request failed")
        raise AIServiceError("Gemini could not complete this request. Try again later.") from error

    try:
        data = response.json()
        parts = data["candidates"][0]["content"]["parts"]
        content = "".join(
            part["text"]
            for part in parts
            if isinstance(part, dict)
            and isinstance(part.get("text"), str)
            and not part.get("thought", False)
        )
        if not content.strip():
            raise ValueError("Gemini returned an empty response")
    except (ValueError, KeyError, IndexError, TypeError) as error:
        _record_budget_settlement(month_start, reservation, reservation)
        logging.exception("Gemini returned an invalid response")
        raise AIServiceError("Gemini returned an invalid response. Try again later.") from error

    actual_cost = _reported_request_cost(data)
    if actual_cost is None:
        actual_cost = reservation
    _record_budget_settlement(month_start, reservation, actual_cost)
    return content


def _extract_json(raw: str):
    """Models sometimes wrap JSON in ```json fences despite instructions not to -- strip them."""
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip(), flags=re.MULTILINE)
    return json.loads(cleaned)


# ---------------------------------------------------------------------------
# Free text correction (Gmail, Google Docs, Word, Outlook)
# ---------------------------------------------------------------------------

TEXT_SYSTEM_PROMPT = (
    "You are a writing assistant, similar to Grammarly and Copilot. You will be given "
    "a piece of text and an instruction describing what change to make to it. Apply the "
    "instruction to the text. Preserve the author's meaning and formatting (line breaks, "
    "etc.) except where the instruction asks you to change them. If no instruction is given, "
    "default to fixing grammar, spelling, punctuation, and awkward phrasing without changing "
    "meaning or tone.\n\n"
    "If the user asks for a rewrite, polish, shortening, or tone change, do not return the "
    "text unchanged just because it was already grammatical. Produce the revised version in a "
    "way that clearly satisfies the instruction.\n\n"
    "Respond with ONLY valid JSON, no other text, in this exact shape:\n"
    '{"corrected": "<the full corrected text>", '
    '"suggestions": [{"original": "<snippet>", "revised": "<snippet>", "reason": "<short reason>"}]}\n\n'
    "If the text needs no changes, return it unchanged with an empty suggestions list."
)


def _add_context(user_content: str, context: str | None) -> str:
    if not context:
        return user_content
    return f"{context}\n\nCurrent request:\n{user_content}"


def analyze_text(text: str, instruction: str | None = None, context: str | None = None) -> dict:
    if len(text) > Config.AI_MAX_TEXT_CHARS or len(instruction or "") > Config.AI_MAX_TEXT_CHARS:
        return {"corrected": text, "suggestions": [], "error": "Text is too large to analyze"}

    if not text or not text.strip():
        if not instruction or not instruction.strip():
            return {"corrected": "", "suggestions": []}
        generated = generate_text(instruction, context=context)
        if generated.get("error"):
            return {"error": generated["error"]}
        return {
            "corrected": generated.get("generated", ""),
            "suggestions": [],
        }

    user_content = (
        f"Instruction: {instruction}\n\nText:\n{text}"
        if instruction
        else text
    )
    user_content = _add_context(user_content, context)
    raw = _call_gemini(TEXT_SYSTEM_PROMPT, user_content)
    try:
        parsed = _extract_json(raw)
        corrected = parsed.get("corrected")
        suggestions = parsed.get("suggestions", [])
        if not isinstance(corrected, str) or not isinstance(suggestions, list):
            raise ValueError("AI provider returned an invalid analysis response")
    except (ValueError, AttributeError) as error:
        logging.exception("AI provider returned an invalid analysis response")
        raise AIServiceError("The AI provider returned an invalid response. Try again later.") from error
    return {"corrected": corrected, "suggestions": suggestions}


# ---------------------------------------------------------------------------
# Text generation (new -- "write me a paragraph/email about X")
# ---------------------------------------------------------------------------

GENERATE_SYSTEM_PROMPT = (
    "You write clear, well-structured text on request -- emails, paragraphs, short "
    "documents, social posts, whatever is asked for. Match the tone, length, and "
    "format implied by the request (e.g. 'a short email' should look like an email, "
    "with a greeting and sign-off if appropriate). Write ONLY the requested content "
    "itself -- no preamble like 'Here's your email:', no explanation afterward, no "
    "quotation marks wrapping the output.\n\n"
    "Respond with ONLY valid JSON, no other text, in this exact shape:\n"
    '{"generated": "<the generated text>"}'
)


def generate_text(prompt: str, context: str | None = None) -> dict:
    if len(prompt) > Config.AI_MAX_TEXT_CHARS:
        return {"generated": "", "error": "Prompt is too large to process"}

    raw = _call_gemini(GENERATE_SYSTEM_PROMPT, _add_context(prompt, context))
    try:
        parsed = _extract_json(raw)
        generated = parsed.get("generated")
        if not isinstance(generated, str):
            raise ValueError("AI provider returned an invalid generation response")
    except (ValueError, AttributeError) as error:
        logging.exception("AI provider returned an invalid generation response")
        raise AIServiceError("The AI provider returned an invalid response. Try again later.") from error
    return {"generated": generated}


# ---------------------------------------------------------------------------
# Spreadsheet ranges (Excel)
# ---------------------------------------------------------------------------

RANGE_SYSTEM_PROMPT = (
    "You are a data-entry proofreader for spreadsheet cells. You will receive a JSON list "
    "of text cell values (formulas and pure numbers are filtered out before reaching you, "
    "so everything you see is free text). Fix obvious typos, inconsistent capitalization, "
    "extra whitespace, and inconsistent date/label formatting within a column's apparent "
    "pattern. Do not change values that already look correct. Do not invent data.\n\n"
    "Respond with ONLY valid JSON, no other text, in this exact shape:\n"
    '{"corrected": ["<value1>", "<value2>", ...], "notes": ["<short note about a change made>"]}\n\n'
    "The corrected array MUST have exactly the same number of elements, in the same order, "
    "as the input array. If nothing needs fixing, return the input unchanged with an empty notes list."
)


def _is_formula_or_number(cell) -> bool:
    if isinstance(cell, (int, float)):
        return True
    if isinstance(cell, str) and cell.strip().startswith("="):
        return True
    return False


def analyze_spreadsheet_range(values: list, context: str | None = None) -> dict:
    cell_count = sum(len(row) for row in values if isinstance(row, list))
    if cell_count > Config.AI_MAX_RANGE_CELLS:
        return {"correctedValues": values, "notes": [], "error": "Selected range is too large to analyze"}

    positions = []
    editable_cells = []
    for r, row in enumerate(values):
        for c, cell in enumerate(row):
            if isinstance(cell, str) and cell.strip() and not _is_formula_or_number(cell):
                positions.append((r, c))
                editable_cells.append(cell)

    if not editable_cells:
        return {"correctedValues": values, "notes": []}

    user_content = _add_context(json.dumps(editable_cells), context)
    raw = _call_gemini(RANGE_SYSTEM_PROMPT, user_content)
    try:
        parsed = _extract_json(raw)
        corrected = parsed.get("corrected")
        notes = parsed.get("notes", [])

        if (
            not isinstance(corrected, list)
            or len(corrected) != len(editable_cells)
            or any(not isinstance(value, str) for value in corrected)
            or not isinstance(notes, list)
        ):
            raise ValueError("AI provider returned an invalid range response")
    except (ValueError, AttributeError) as error:
        logging.exception("AI provider returned an invalid range response")
        raise AIServiceError("The AI provider returned an invalid response. Try again later.") from error

    result = [row[:] for row in values]
    for (r, c), new_value in zip(positions, corrected):
        result[r][c] = new_value

    return {"correctedValues": result, "notes": notes}