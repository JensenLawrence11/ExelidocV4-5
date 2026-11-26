from unittest.mock import patch

from services.ai_service import (
    MAX_CONTEXT_CHARS,
    analyze_spreadsheet_range,
    analyze_text,
    generate_text,
)


def test_large_text_does_not_call_provider():
    with patch("services.ai_service._call_gemini") as call_provider:
        result = analyze_text("x" * 100_001)

    assert result["error"] == "Text is too large to analyze"
    call_provider.assert_not_called()


def test_large_prompt_does_not_call_provider():
    with patch("services.ai_service._call_gemini") as call_provider:
        result = generate_text("x" * 100_001)

    assert result["error"] == "Prompt is too large to process"
    call_provider.assert_not_called()


def test_large_range_does_not_call_provider():
    values = [["text"] * 5_001]

    with patch("services.ai_service._call_gemini") as call_provider:
        result = analyze_spreadsheet_range(values)

    assert result["error"] == "Selected range is too large to analyze"
    assert result["correctedValues"] is values
    call_provider.assert_not_called()


def test_oversized_reference_context_does_not_call_provider():
    context = "x" * (MAX_CONTEXT_CHARS + 1)

    with patch("services.ai_service._call_gemini") as call_provider:
        assert analyze_text("text", context=context)["error"] == "Reference context is too large to analyze"
        assert generate_text("question", context=context)["error"] == "Reference context is too large to process"
        assert analyze_spreadsheet_range([["text"]], context=context)["error"] == (
            "Reference context is too large to analyze"
        )

    call_provider.assert_not_called()