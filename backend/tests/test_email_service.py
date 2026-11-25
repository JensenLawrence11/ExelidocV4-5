from unittest.mock import MagicMock, patch

from config import Config
from services.email_service import (
    _send_email,
    send_password_reset_email,
    send_verification_email,
)


def test_account_emails_link_to_api_url_not_website_url():
    with patch.object(Config, "API_PUBLIC_URL", "https://api.example.com"), patch.object(
        Config, "APP_PUBLIC_URL", "https://website.example.com"
    ), patch("services.email_service._send_email") as send_email:
        send_verification_email("person@example.com", "verification-token")
        send_password_reset_email("person@example.com", "reset-token")

    verification_body = send_email.call_args_list[0].args[2]
    reset_text_body = send_email.call_args_list[1].args[2]
    reset_html_body = send_email.call_args_list[1].args[3]
    assert "https://api.example.com/api/auth/verify-email?token=verification-token" in verification_body
    assert "https://api.example.com/api/auth/reset-password?token=reset-token" in reset_text_body
    assert "https://api.example.com/api/auth/reset-password?token=reset-token" in reset_html_body
    assert "website.example.com/api/auth" not in verification_body + reset_text_body + reset_html_body


def test_send_email_uses_resend_api_when_configured():
    response = MagicMock()

    with patch.object(Config, "RESEND_API_KEY", "re_test_key"), patch.object(
        Config, "EMAIL_FROM_ADDRESS", "support@example.com"
    ), patch.object(Config, "EMAIL_FROM_NAME", "Exelidoc"), patch(
        "services.email_service.requests.post", return_value=response
    ) as post, patch("services.email_service.SMTP") as smtp:
        _send_email(
            "person@example.com",
            "Reset your password",
            "Use the reset link.",
            "<p>Use the reset link.</p>",
        )

    post.assert_called_once_with(
        "https://api.resend.com/emails",
        headers={
            "Authorization": "Bearer re_test_key",
            "Content-Type": "application/json",
        },
        json={
            "from": "Exelidoc <support@example.com>",
            "to": ["person@example.com"],
            "subject": "Reset your password",
            "text": "Use the reset link.",
            "html": "<p>Use the reset link.</p>",
        },
        timeout=15,
    )
    response.raise_for_status.assert_called_once_with()
    smtp.assert_not_called()


def test_send_email_falls_back_to_smtp_without_resend_key():
    smtp_server = MagicMock()
    smtp_context = MagicMock()
    smtp_context.__enter__.return_value = smtp_server

    with patch.object(Config, "RESEND_API_KEY", None), patch.object(
        Config, "EMAIL_SMTP_HOST", "smtp.example.com"
    ), patch.object(Config, "EMAIL_SMTP_PORT", 587), patch.object(
        Config, "EMAIL_FROM_ADDRESS", "support@example.com"
    ), patch.object(Config, "EMAIL_FROM_NAME", "Exelidoc"), patch(
        "services.email_service.SMTP", return_value=smtp_context
    ) as smtp, patch("services.email_service.requests.post") as post:
        _send_email("person@example.com", "Subject", "Body")

    smtp.assert_called_once_with("smtp.example.com", 587, timeout=15)
    smtp_server.starttls.assert_called_once_with()
    smtp_server.send_message.assert_called_once()
    post.assert_not_called()
