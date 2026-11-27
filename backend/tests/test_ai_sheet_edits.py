import json
import logging
from unittest.mock import patch

import pytest

from services.ai_service import (
    AIServiceError,
    MAX_CONTEXT_CHARS,
    edit_spreadsheet_range,
    format_google_document,
    format_spreadsheet_range,
    generate_google_spreadsheet,
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


def test_google_docs_format_returns_only_validated_document_styles():
    paragraphs = ["Quarterly Report", "Revenue increased by 10%."]
    provider_result = {
        "formatting": {
            "textStyle": {"fontFamily": "Georgia", "fontSize": 12},
            "paragraphStyles": [{
                "paragraphIndex": 0,
                "textStyle": {"foregroundColor": "#1A237E", "bold": True},
                "paragraphStyle": {"namedStyleType": "TITLE"},
            }],
        },
        "notes": ["Styled the title and set a readable body font."],
    }

    with patch(
        "services.ai_service._call_gemini",
        return_value=json.dumps(provider_result),
    ) as call_provider:
        result = format_google_document(paragraphs, "Make the title blue and use a readable font")

    assert result == provider_result
    request_content = call_provider.call_args.args[1]
    assert "Make the title blue" in request_content
    assert json.dumps(paragraphs, ensure_ascii=False, separators=(",", ":")) in request_content


def test_google_docs_format_rejects_out_of_range_paragraph_indexes():
    with patch(
        "services.ai_service._call_gemini",
        return_value=json.dumps({
            "formatting": {
                "paragraphStyles": [{
                    "paragraphIndex": 4,
                    "paragraphStyle": {"namedStyleType": "HEADING_1"},
                }],
            },
            "notes": [],
        }),
    ):
        with pytest.raises(AIServiceError, match="invalid formatting plan"):
            format_google_document(["First paragraph"], "Make the last paragraph a heading")


def test_spreadsheet_generation_returns_validated_tabs_and_formulas():
    plan = {
        "title": "Monthly Budget",
        "sheets": [{
            "title": "Summary",
            "values": [
                ["Category", "Planned", "Actual", "Variance"],
                ["Housing", 1200, 1150, "=B2-C2"],
                ["Total", "=SUM(B2:B2)", "=SUM(C2:C2)", "=SUM(D2:D2)"],
            ],
            "columnFormats": [{"columnIndex": 1, "numberFormat": "CURRENCY"}],
        }],
        "notes": ["Formula cells are included for totals and variance."],
    }

    with patch(
        "services.ai_service._call_gemini",
        return_value=json.dumps(plan),
    ) as call_provider:
        result = generate_google_spreadsheet("Create a monthly budget workbook")

    assert result["title"] == "Monthly Budget"
    assert result["sheets"] == plan["sheets"]
    assert result["cellCount"] == 12
    assert result["formulaCount"] == 4
    assert "Create a monthly budget workbook" in call_provider.call_args.args[1]


def test_spreadsheet_generation_rejects_external_formula_functions():
    with patch(
        "services.ai_service._call_gemini",
        return_value=json.dumps({
            "title": "Budget",
            "sheets": [{
                "title": "Summary",
                "values": [["Category", "External data"], ["A", '=IMPORTXML("https://example.com","//item")']],
            }],
            "notes": [],
        }),
    ):
        with pytest.raises(AIServiceError, match="invalid spreadsheet plan"):
            generate_google_spreadsheet("Create a budget with imported data")


def test_spreadsheet_generation_rejects_ragged_sheets():
    with patch(
        "services.ai_service._call_gemini",
        return_value=json.dumps({
            "title": "Budget",
            "sheets": [{
                "title": "Summary",
                "values": [["Category", "Total"], ["A"]],
            }],
            "notes": [],
        }),
    ):
        with pytest.raises(AIServiceError, match="invalid spreadsheet plan"):
            generate_google_spreadsheet("Create a budget")


def test_spreadsheet_generation_logs_validation_reason_without_response_content(caplog):
    with (
        patch("services.ai_service._call_gemini", return_value="not valid JSON"),
        patch("services.ai_service.capture_exception"),
        caplog.at_level(logging.ERROR),
    ):
        with pytest.raises(AIServiceError, match="invalid spreadsheet plan"):
            generate_google_spreadsheet("Create a budget")

    assert "ai_response_invalid kind=spreadsheet_generation" in caplog.text
    assert "reason=" in caplog.text
    assert "not valid JSON" not in caplog.text
