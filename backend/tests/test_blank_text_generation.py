from unittest.mock import patch

from services.ai_service import analyze_text


@patch("services.ai_service.generate_text")
def test_blank_text_uses_generated_reply(mock_generate):
    mock_generate.return_value = {"generated": "Dear cat,\n\nWe should meet soon.\n\nBest,\nMilo"}

    result = analyze_text("", "make me a cat email")

    assert result["corrected"] == "Dear cat,\n\nWe should meet soon.\n\nBest,\nMilo"
    assert result["suggestions"] == []
