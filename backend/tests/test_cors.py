import unittest

from app import app


class CorsExtensionOriginTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_extension_origin_is_allowed(self):
        response = self.client.get(
            "/api/health",
            headers={"Origin": "chrome-extension://random-extension-id-123"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("Access-Control-Allow-Origin", response.headers)

    def test_extension_preflight_allows_session_token_header(self):
        response = self.client.options(
            "/api/ai/analyze-text",
            headers={
                "Origin": "chrome-extension://random-extension-id-123",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,x-session-token",
            },
        )

        self.assertIn("X-Session-Token", response.headers["Access-Control-Allow-Headers"])


if __name__ == "__main__":
    unittest.main()
