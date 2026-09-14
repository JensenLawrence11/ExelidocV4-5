"""
Single shared Supabase client, built with the service_role key so the backend
can read/write any row (bypasses Row Level Security). Never expose this key
or this client to a frontend.
"""
from supabase import create_client, Client
from config import Config

_client: Client | None = None


def get_supabase() -> Client:
    global _client
    if _client is None:
        if not Config.SUPABASE_URL or not Config.SUPABASE_SERVICE_KEY:
            raise RuntimeError(
                "SUPABASE_URL / SUPABASE_SERVICE_KEY not set -- check your .env file"
            )
        _client = create_client(Config.SUPABASE_URL, Config.SUPABASE_SERVICE_KEY)
    return _client
