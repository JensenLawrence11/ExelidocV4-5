"""
Central place for all configuration/env vars. Everything else in the backend
should import from here rather than calling os.environ directly, so there's
one place to see every setting the app depends on.
"""
import os
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")


def _stripe_setting(name: str) -> str | None:
    mode = os.environ.get("STRIPE_MODE", "live").strip().lower()
    if mode == "test":
        return os.environ.get(f"STRIPE_TEST_{name}")
    if mode == "live":
        return os.environ.get(f"STRIPE_LIVE_{name}") or os.environ.get(f"STRIPE_{name}")
    return None


class Config:
    SECRET_KEY = os.environ.get("FLASK_SECRET_KEY", "dev-only-insecure-key")
    ENV = os.environ.get("FLASK_ENV", "development").strip().lower()
    MAX_CONTENT_LENGTH = int(os.environ.get("MAX_CONTENT_LENGTH", 1_000_000))
    AI_MAX_TEXT_CHARS = int(os.environ.get("AI_MAX_TEXT_CHARS", 100_000))
    AI_MAX_RANGE_CELLS = int(os.environ.get("AI_MAX_RANGE_CELLS", 5_000))
    AI_MAX_OUTPUT_TOKENS = int(os.environ.get("AI_MAX_OUTPUT_TOKENS", 4_000))

    FRONTEND_ORIGINS = os.environ.get("FRONTEND_ORIGINS", "*").split(",")

    ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
    OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
    OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")
    OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "openai/gpt-4o-mini")
    OPENROUTER_SITE_URL = os.environ.get("OPENROUTER_SITE_URL", "")
    OPENROUTER_SITE_NAME = os.environ.get("OPENROUTER_SITE_NAME", "")

    APP_PUBLIC_URL = os.environ.get("APP_PUBLIC_URL", "https://exelidocv4-5.onrender.com")
    BILLING_RETURN_URL = os.environ.get("BILLING_RETURN_URL")
    EMAIL_SMTP_HOST = os.environ.get("EMAIL_SMTP_HOST")
    EMAIL_SMTP_PORT = int(os.environ.get("EMAIL_SMTP_PORT", 587))
    EMAIL_SMTP_USERNAME = os.environ.get("EMAIL_SMTP_USERNAME")
    EMAIL_SMTP_PASSWORD = os.environ.get("EMAIL_SMTP_PASSWORD")
    EMAIL_FROM_ADDRESS = os.environ.get("EMAIL_FROM_ADDRESS")
    EMAIL_FROM_NAME = os.environ.get("EMAIL_FROM_NAME", "Exelidoc")
    RESEND_API_KEY = os.environ.get("RESEND_API_KEY")
    STRIPE_MODE = os.environ.get("STRIPE_MODE", "live").strip().lower()
    STRIPE_SECRET_KEY = _stripe_setting("SECRET_KEY")
    STRIPE_PUBLISHABLE_KEY = _stripe_setting("PUBLISHABLE_KEY")
    STRIPE_WEBHOOK_SECRET = _stripe_setting("WEBHOOK_SECRET")
    STRIPE_PRICE_ID_PRO = _stripe_setting("PRICE_ID_PRO") or _stripe_setting("PRICE_ID_MONTHLY")
    STRIPE_PRICE_ID_ENTERPRISE = _stripe_setting("PRICE_ID_ENTERPRISE")

    @classmethod
    def stripe_env_name(cls, name: str) -> str:
        if cls.STRIPE_MODE == "test":
            return f"STRIPE_TEST_{name}"
        if cls.STRIPE_MODE == "live":
            return f"STRIPE_LIVE_{name} or STRIPE_{name}"
        return "STRIPE_MODE (set to 'test' or 'live')"

    TIER_LIMITS = {
        "free": 5,
        "pro": 20,
        "enterprise": 50,
    }

    SUPABASE_URL = os.environ.get("SUPABASE_URL")
    SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")

    @classmethod
    def validate_for_production(cls) -> None:
        required_settings = {
            "SUPABASE_URL": cls.SUPABASE_URL,
            "SUPABASE_SERVICE_KEY": cls.SUPABASE_SERVICE_KEY,
            "OPENROUTER_API_KEY": cls.OPENROUTER_API_KEY,
            "EMAIL_FROM_ADDRESS": cls.EMAIL_FROM_ADDRESS,
            cls.stripe_env_name("SECRET_KEY"): cls.STRIPE_SECRET_KEY,
            cls.stripe_env_name("WEBHOOK_SECRET"): cls.STRIPE_WEBHOOK_SECRET,
            cls.stripe_env_name("PRICE_ID_PRO"): cls.STRIPE_PRICE_ID_PRO,
            cls.stripe_env_name("PRICE_ID_ENTERPRISE"): cls.STRIPE_PRICE_ID_ENTERPRISE,
            "BILLING_RETURN_URL": cls.BILLING_RETURN_URL,
        }
        missing = [
            name for name, value in required_settings.items()
            if not isinstance(value, str) or not value.strip()
        ]
        if cls.STRIPE_MODE not in {"test", "live"}:
            missing.append("STRIPE_MODE (use 'test' or 'live')")
        elif cls.ENV == "production" and cls.STRIPE_MODE != "live":
            missing.append("STRIPE_MODE (production requires live mode)")
        elif (
            cls.ENV == "production"
            and isinstance(cls.STRIPE_SECRET_KEY, str)
            and not cls.STRIPE_SECRET_KEY.startswith(("sk_live_", "rk_live_"))
        ):
            missing.append("STRIPE_SECRET_KEY (live-mode key required in production)")

        has_resend_key = (
            isinstance(cls.RESEND_API_KEY, str) and bool(cls.RESEND_API_KEY.strip())
        )
        has_smtp_host = (
            isinstance(cls.EMAIL_SMTP_HOST, str) and bool(cls.EMAIL_SMTP_HOST.strip())
        )
        if not has_resend_key and not has_smtp_host:
            missing.append("EMAIL_DELIVERY (set RESEND_API_KEY or EMAIL_SMTP_HOST)")

        if (
            not isinstance(cls.SECRET_KEY, str)
            or not cls.SECRET_KEY.strip()
            or cls.SECRET_KEY == "dev-only-insecure-key"
        ):
            missing.append("FLASK_SECRET_KEY")

        origins = [origin.strip().rstrip("/") for origin in cls.FRONTEND_ORIGINS if origin.strip()]
        if not origins or "*" in origins:
            missing.append("FRONTEND_ORIGINS (explicit origins required)")
        else:
            for origin in origins:
                parsed = urlparse(origin)
                no_credentials_or_suffix = (
                    not parsed.username
                    and not parsed.password
                    and not parsed.query
                    and not parsed.fragment
                )
                is_https_origin = (
                    parsed.scheme == "https"
                    and bool(parsed.netloc)
                    and not parsed.path
                    and no_credentials_or_suffix
                )
                is_extension_origin = (
                    parsed.scheme == "chrome-extension"
                    and bool(parsed.netloc)
                    and not parsed.path
                    and no_credentials_or_suffix
                )
                if not (is_https_origin or is_extension_origin):
                    missing.append("FRONTEND_ORIGINS (use exact HTTPS or Chrome extension origins)")
                    break

        public_url = urlparse(cls.APP_PUBLIC_URL or "")
        if (
            public_url.scheme != "https"
            or not public_url.netloc
            or public_url.path
            or public_url.username
            or public_url.password
            or public_url.query
            or public_url.fragment
        ):
            missing.append("APP_PUBLIC_URL (HTTPS origin required)")

        billing_return_url = urlparse(cls.BILLING_RETURN_URL or "")
        if (
            billing_return_url.scheme != "https"
            or not billing_return_url.netloc
            or billing_return_url.username
            or billing_return_url.password
        ):
            missing.append("BILLING_RETURN_URL (HTTPS customer-facing page required)")

        if missing:
            raise RuntimeError(
                "Invalid production configuration: " + ", ".join(dict.fromkeys(missing))
            )