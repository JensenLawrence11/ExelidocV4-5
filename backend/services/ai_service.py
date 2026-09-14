"""
All actual AI-provider calls live here, isolated from the Flask route layer.
Currently using OpenRouter (OpenAI-compatible chat completions endpoint) via
a direct REST call -- no SDK dependency.
"""
import json
import re

import requests
from config import Config

OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"


def _call_openrouter(system_prompt: str, user_content: str) -> str | None:
    """Returns the raw text response, or None if no key is configured."""
    if not Config.OPENROUTER_API_KEY:
        return None

    headers = {
        "Authorization": f"Bearer {Config.OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
    }
    if Config.OPENROUTER_SITE_URL:
        headers["HTTP-Referer"] = Config.OPENROUTER_SITE_URL
    if Config.OPENROUTER_SITE_NAME:
        headers["X-Title"] = Config.OPENROUTER_SITE_NAME

    response = requests.post(
        OPENROUTER_API_URL,
        headers=headers,
        json={
            "model": Config.OPENROUTER_MODEL,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
        },
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()
    return data["choices"][0]["message"]["content"]


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


def analyze_text(text: str, instruction: str | None = None) -> dict:
    try:
        if not text or not text.strip():
            if not instruction or not instruction.strip():
                return {"corrected": "", "suggestions": []}
            generated = generate_text(instruction)
            return {
                "corrected": generated.get("generated", ""),
                "suggestions": [],
            }

        user_content = (
            f"Instruction: {instruction}\n\nText:\n{text}"
            if instruction
            else text
        )
        raw = _call_openrouter(TEXT_SYSTEM_PROMPT, user_content)
        if raw is None:
            return {"corrected": text, "suggestions": []}
        parsed = _extract_json(raw)
        return {
            "corrected": parsed.get("corrected", text),
            "suggestions": parsed.get("suggestions", []),
        }
    except Exception as e:
        print(f"analyze_text error: {e}")
        return {"corrected": text, "suggestions": []}


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


def generate_text(prompt: str) -> dict:
    try:
        raw = _call_openrouter(GENERATE_SYSTEM_PROMPT, prompt)
        if raw is None:
            return {"generated": "", "error": "AI provider not configured"}
        parsed = _extract_json(raw)
        return {"generated": parsed.get("generated", "")}
    except Exception as e:
        print(f"generate_text error: {e}")
        return {"generated": "", "error": "Generation failed, try again"}


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


def analyze_spreadsheet_range(values: list) -> dict:
    positions = []
    editable_cells = []
    for r, row in enumerate(values):
        for c, cell in enumerate(row):
            if isinstance(cell, str) and cell.strip() and not _is_formula_or_number(cell):
                positions.append((r, c))
                editable_cells.append(cell)

    if not editable_cells:
        return {"correctedValues": values, "notes": []}

    try:
        raw = _call_openrouter(RANGE_SYSTEM_PROMPT, json.dumps(editable_cells))
        if raw is None:
            return {"correctedValues": values, "notes": []}

        parsed = _extract_json(raw)
        corrected = parsed.get("corrected", editable_cells)
        notes = parsed.get("notes", [])

        if len(corrected) != len(editable_cells):
            return {"correctedValues": values, "notes": []}

        result = [row[:] for row in values]
        for (r, c), new_value in zip(positions, corrected):
            result[r][c] = new_value

        return {"correctedValues": result, "notes": notes}
    except Exception as e:
        print(f"analyze_spreadsheet_range error: {e}")
        return {"correctedValues": values, "notes": []}