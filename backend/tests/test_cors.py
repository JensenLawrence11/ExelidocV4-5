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


if __name__ == "__main__":
    unittest.main()
