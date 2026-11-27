import json
from unittest.mock import patch

import pytest

from services.ai_service import (
    AIServiceError,
    MAX_CONTEXT_CHARS,
    edit_spreadsheet_range,
    format_spreadsheet_range,
)


def test_sheet_edit_returns_a_same_shape_preview_and_forwards_instruction():
    values = [["=SUM(A1:A2)", "old"], [None, 42]]
    provider_result = {
        "correctedValues": [["=SUM(A1:A2)", "new"], [None, 50]],
        "notes": ["Updated the label and total."],
    }

    with patch(
        "services.ai_service._call_gemini",
        return_value=json.dumps(provider_result),
    ) as call_provider:
        result = edit_spreadsheet_range(values, "Rename and update the total")

    assert result == provider_result
    request_content = call_provider.call_args.args[1]
    assert "Rename and update the total" in request_content
    assert json.dumps(values, ensure_ascii=False, separators=(",", ":")) in request_content


def test_sheet_edit_rejects_malformed_provider_matrix():
    with patch(
        "services.ai_service._call_gemini",
        return_value=json.dumps({"correctedValues": [["changed"]], "notes": []}),
    ):
        with pytest.raises(AIServiceError, match="invalid response"):
            edit_spreadsheet_range([["a", "b"]], "Update the cells")


def test_oversized_sheet_edit_does_not_call_provider():
    with patch("services.ai_service._call_gemini") as call_provider:
        result = edit_spreadsheet_range(
            [["x" * MAX_CONTEXT_CHARS]],
            "Update this cell",
        )

    assert "too large" in result["error"].lower()
    call_provider.assert_not_called()


def test_sheet_edit_rejects_non_rectangular_ranges_without_provider_call():
    with patch("services.ai_service._call_gemini") as call_provider:
        result = edit_spreadsheet_range([["a", "b"], ["c"]], "Update the cells")

    assert "same number of cells" in result["error"]
    call_provider.assert_not_called()


def test_sheet_format_returns_only_a_validated_format_plan():
    values = [["Amount", "Date"], [12, "2026-01-01"]]
    provider_result = {
        "formatting": {
            "headerStyle": True,
            "headerBackgroundColor": "#1A237E",
            "headerTextColor": "#FFFFFF",
            "numberFormat": "CURRENCY",
        },
        "notes": ["Styled the header and formatted amounts as currency."],
    }

    with patch(
        "services.ai_service._call_gemini",
        return_value=json.dumps(provider_result),
    ) as call_provider:
        result = format_spreadsheet_range(values, "Use a blue header and currency")

    assert result == provider_result
    assert "Use a blue header and currency" in call_provider.call_args.args[1]
    assert json.dumps(values, ensure_ascii=False, separators=(",", ":")) in call_provider.call_args.args[1]


def test_sheet_format_rejects_unsupported_provider_colors():
    with patch(
        "services.ai_service._call_gemini",
        return_value=json.dumps({
            "formatting": {"backgroundColor": "red"},
            "notes": [],
        }),
    ):
        with pytest.raises(AIServiceError, match="invalid formatting plan"):
            format_spreadsheet_range([["Header"]], "Make it red")


def test_sheet_format_rejects_non_rectangular_ranges_without_provider_call():
    with patch("services.ai_service._call_gemini") as call_provider:
        result = format_spreadsheet_range([["a", "b"], ["c"]], "Style the table")

    assert "same number of cells" in result["error"]
    call_provider.assert_not_called()
