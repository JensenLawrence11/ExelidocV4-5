import unittest
from unittest.mock import patch

from app import create_app


class CorsExtensionOriginTests(unittest.TestCase):
    def setUp(self):
        self.extension_origin = "chrome-extension://random-extension-id-123"

    def test_extension_origin_is_allowed(self):
        with patch("app.Config.FRONTEND_ORIGINS", ["chrome-extension://random-extension-id-123"]):
            client = create_app().test_client()
            response = client.get(
                "/api/health",
                headers={"Origin": "chrome-extension://random-extension-id-123"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.headers["Access-Control-Allow-Origin"],
            "chrome-extension://random-extension-id-123",
        )

    def test_unconfigured_extension_origin_is_not_allowed(self):
        with patch("app.Config.FRONTEND_ORIGINS", ["chrome-extension://approved-extension"]):
            client = create_app().test_client()
            response = client.get(
                "/api/health",
                headers={"Origin": "chrome-extension://other-extension"},
            )

        self.assertNotIn("Access-Control-Allow-Origin", response.headers)

    def test_allowed_origin_does_not_match_lookalike_hostname(self):
        with patch("app.Config.FRONTEND_ORIGINS", ["https://example.com"]):
            client = create_app().test_client()
            response = client.get(
                "/api/health",
                headers={"Origin": "https://example.com.attacker.test"},
            )

        self.assertNotIn("Access-Control-Allow-Origin", response.headers)

    def test_extension_preflight_allows_session_token_header(self):
        with patch("app.Config.FRONTEND_ORIGINS", [self.extension_origin]):
            response = create_app().test_client().options(
                "/api/ai/analyze-text",
                headers={
                    "Origin": self.extension_origin,
                    "Access-Control-Request-Method": "POST",
                    "Access-Control-Request-Headers": "content-type,x-session-token",
                },
            )

        self.assertIn("X-Session-Token", response.headers["Access-Control-Allow-Headers"])

    def test_extension_preflight_allows_history_delete(self):
        with patch("app.Config.FRONTEND_ORIGINS", [self.extension_origin]):
            response = create_app().test_client().options(
                "/api/history",
                headers={
                    "Origin": self.extension_origin,
                    "Access-Control-Request-Method": "DELETE",
                    "Access-Control-Request-Headers": "x-session-token",
                },
            )

        self.assertIn("DELETE", response.headers["Access-Control-Allow-Methods"])

    def test_configured_public_app_url_allows_checkout_preflight(self):
        with patch("app.Config.APP_PUBLIC_URL", "https://exelidoc.com"), patch(
            "app.Config.FRONTEND_ORIGINS", ["chrome-extension://test-extension"]
        ):
            client = create_app().test_client()
            response = client.options(
                "/api/stripe/create-checkout-session",
                headers={
                    "Origin": "https://exelidoc.com",
                    "Access-Control-Request-Method": "POST",
                    "Access-Control-Request-Headers": "content-type",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.headers["Access-Control-Allow-Origin"],
            "https://exelidoc.com",
        )
        self.assertIn("Content-Type", response.headers["Access-Control-Allow-Headers"])


if __name__ == "__main__":
    unittest.main()
