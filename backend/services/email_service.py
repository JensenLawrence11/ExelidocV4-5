"""Transactional email delivery for account verification and welcome messages."""
from email.message import EmailMessage
from smtplib import SMTP, SMTP_SSL
from urllib.parse import urlencode

from config import Config


def _send_email(recipient: str, subject: str, body: str) -> None:
    if not Config.EMAIL_SMTP_HOST or not Config.EMAIL_FROM_ADDRESS:
        raise RuntimeError("Email delivery is not configured")

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = f"{Config.EMAIL_FROM_NAME} <{Config.EMAIL_FROM_ADDRESS}>"
    message["To"] = recipient
    message.set_content(body)

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