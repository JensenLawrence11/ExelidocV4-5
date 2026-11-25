"""Transactional email delivery for account verification and welcome messages."""
from email.message import EmailMessage
from html import escape
from smtplib import SMTP, SMTP_SSL
from urllib.parse import urlencode

import requests

from config import Config

RESEND_API_URL = "https://api.resend.com/emails"


def _send_email(recipient: str, subject: str, body: str, html_body: str | None = None) -> None:
    if not Config.EMAIL_FROM_ADDRESS:
        raise RuntimeError("Email delivery is not configured: set EMAIL_FROM_ADDRESS")

    if Config.RESEND_API_KEY:
        payload = {
            "from": f"{Config.EMAIL_FROM_NAME} <{Config.EMAIL_FROM_ADDRESS}>",
            "to": [recipient],
            "subject": subject,
            "text": body,
        }
        if html_body is not None:
            payload["html"] = html_body

        response = requests.post(
            RESEND_API_URL,
            headers={
                "Authorization": f"Bearer {Config.RESEND_API_KEY}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=15,
        )
        response.raise_for_status()
        return

    if not Config.EMAIL_SMTP_HOST:
        raise RuntimeError(
            "Email delivery is not configured: set RESEND_API_KEY or EMAIL_SMTP_HOST"
        )

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = f"{Config.EMAIL_FROM_NAME} <{Config.EMAIL_FROM_ADDRESS}>"
    message["To"] = recipient
    message.set_content(body)
    if html_body:
        message.add_alternative(html_body, subtype="html")

    smtp_class = SMTP_SSL if Config.EMAIL_SMTP_PORT == 465 else SMTP
    with smtp_class(Config.EMAIL_SMTP_HOST, Config.EMAIL_SMTP_PORT, timeout=15) as server:
        if Config.EMAIL_SMTP_PORT != 465:
            server.starttls()
        if Config.EMAIL_SMTP_USERNAME:
            server.login(Config.EMAIL_SMTP_USERNAME, Config.EMAIL_SMTP_PASSWORD or "")
        server.send_message(message)


def send_verification_email(recipient: str, token: str) -> None:
    link = (
        f"{Config.APP_PUBLIC_URL.rstrip('/')}/api/auth/verify-email?"
        f"{urlencode({'token': token})}"
    )
    _send_email(
        recipient,
        "Verify your Exelidoc email address",
        "Confirm your email address to finish creating your Exelidoc account.\n\n"
        f"{link}\n\nThis link expires in 24 hours. If you did not request this, ignore this email.",
    )


def send_welcome_email(recipient: str) -> None:
    _send_email(
        recipient,
        "Welcome to Exelidoc",
        "Your email address is verified and your Exelidoc account is ready. "
        "You can now sign in from the Exelidoc extension or add-in.",
    )


def send_password_reset_email(recipient: str, token: str) -> None:
    link = (
        f"{Config.APP_PUBLIC_URL.rstrip('/')}/api/auth/reset-password?"
        f"{urlencode({'token': token})}"
    )
    _send_email(
        recipient,
        "Reset your Exelidoc password",
        "Use this link to reset your Exelidoc password:\n\n"
        f"{link}\n\nThis link expires in 30 minutes. If you did not request this, ignore this email.",
        (
            "<p>Use this link to reset your Exelidoc password:</p>"
            f'<p><a href="{escape(link, quote=True)}">Reset password</a></p>'
            "<p>This link expires in 30 minutes. If you did not request this, ignore this email.</p>"
        ),
    )