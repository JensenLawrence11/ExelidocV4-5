"""
Central place for all configuration/env vars. Everything else in the backend
should import from here rather than calling os.environ directly, so there's
one place to see every setting the app depends on.
"""
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")


class Config:
    SECRET_KEY = os.environ.get("FLASK_SECRET_KEY", "dev-only-insecure-key")
    ENV = os.environ.get("FLASK_ENV", "development")

    FRONTEND_ORIGINS = os.environ.get("FRONTEND_ORIGINS", "*").split(",")

    ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
    OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
    OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")
    OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "openai/gpt-4o-mini")
    OPENROUTER_SITE_URL = os.environ.get("OPENROUTER_SITE_URL", "")
    OPENROUTER_SITE_NAME = os.environ.get("OPENROUTER_SITE_NAME", "")

    STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY")
    STRIPE_PUBLISHABLE_KEY = os.environ.get("STRIPE_PUBLISHABLE_KEY")
    STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET")
    STRIPE_PRICE_ID_PRO = os.environ.get("STRIPE_PRICE_ID_PRO")
    STRIPE_PRICE_ID_ENTERPRISE = os.environ.get("STRIPE_PRICE_ID_ENTERPRISE")

    TIER_LIMITS = {
        "free": 50,
        "pro": 500,
        "enterprise": 5000,
    }

    SUPABASE_URL = os.environ.get("SUPABASE_URL")
    SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")