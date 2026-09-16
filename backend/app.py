"""
Entrypoint. Run with:
    flask --app app run --debug
or in production behind gunicorn:
    gunicorn app:app
"""
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

from config import Config
from routes.ai import ai_bp
from routes.stripe_routes import stripe_bp
from routes.auth import auth_bp


def _is_allowed_origin(origin: str | None) -> bool:
    if not origin:
        return False

    if origin.startswith("chrome-extension://"):
        return True

    for allowed in Config.FRONTEND_ORIGINS:
        if not allowed:
            continue
        allowed = allowed.strip()
        if allowed == "*":
            return True
        if allowed.endswith("/*"):
            allowed = allowed[:-1]
        if origin == allowed or origin.startswith(allowed.rstrip("/")):
            return True

    local_hosts = (
        "http://localhost",
        "https://localhost",
        "http://127.0.0.1",
        "https://127.0.0.1",
    )
    return origin.startswith(local_hosts)


def create_app():
    app = Flask(__name__)
    app.config.from_object(Config)

    project_root = Path(__file__).resolve().parent.parent
    office_addin_root = project_root / "office-addin"

    @app.route("/src/<path:filename>")
    def serve_office_addin_src(filename):
        return send_from_directory(office_addin_root / "src", filename)

    @app.route("/assets/<path:filename>")
    def serve_office_addin_assets(filename):
        return send_from_directory(office_addin_root / "assets", filename)

    # Chrome extension IDs are install-specific and therefore not stable across
    # machines. Allow any extension origin plus the configured web origins and
    # localhost addresses that the app uses during local development.
    CORS(app, origins=Config.FRONTEND_ORIGINS, supports_credentials=True)

    @app.after_request
    def add_cors_headers(response):
        origin = request.headers.get("Origin")
        if origin and _is_allowed_origin(origin):
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Api-Key, Authorization"
            response.headers["Access-Control-Allow-Credentials"] = "true"
            response.headers["Vary"] = "Origin"
        return response

    app.register_blueprint(ai_bp, url_prefix="/api/ai")
    app.register_blueprint(stripe_bp, url_prefix="/api/stripe")
    app.register_blueprint(auth_bp, url_prefix="/api/auth")

    @app.get("/api/health")
    def health():
        return jsonify(status="ok", service="exelidoc-backend")

    @app.get("/")
    def root():
        return jsonify(status="ok", service="exelidoc-backend", static_host="enabled")

    return app


app = create_app()

if __name__ == "__main__":
    app.run(debug=True)
