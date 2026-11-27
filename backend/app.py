"""
Entrypoint. Run with:
    flask --app app run --debug
or in production behind gunicorn:
    gunicorn app:app
"""
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from werkzeug.middleware.proxy_fix import ProxyFix

from config import Config
from routes.ai import ai_bp
from routes.stripe_routes import stripe_bp
from routes.auth import auth_bp
from routes.history import history_bp
from services.monitoring_service import initialize_monitoring


def _configured_frontend_origins() -> list[str]:
    origins = [*Config.FRONTEND_ORIGINS, Config.APP_PUBLIC_URL]
    return [origin.strip().rstrip("/") for origin in origins if origin and origin.strip()]


def _is_allowed_origin(origin: str | None) -> bool:
    if not origin:
        return False

    for allowed in _configured_frontend_origins():
        if allowed == "*":
            return True
        if allowed.endswith("/*"):
            base = allowed[:-2].rstrip("/")
            if origin == base or origin.startswith(base + "/"):
                return True
        elif origin == allowed:
            return True

    parsed = urlparse(origin)
    return (
        parsed.scheme in {"http", "https"}
        and parsed.hostname in {"localhost", "127.0.0.1"}
        and not parsed.path
    )


def create_app():
    if Config.ENV == "production":
        Config.validate_for_production()

    app = Flask(__name__)
    app.config.from_object(Config)
    if Config.TRUSTED_PROXY_HOPS:
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=Config.TRUSTED_PROXY_HOPS)
    initialize_monitoring()

    project_root = Path(__file__).resolve().parent.parent
    office_addin_root = project_root / "office-addin"

    @app.route("/src/<path:filename>")
    def serve_office_addin_src(filename):
        return send_from_directory(office_addin_root / "src", filename)

    @app.route("/assets/<path:filename>")
    def serve_office_addin_assets(filename):
        return send_from_directory(office_addin_root / "assets", filename)

    # Configure the installed extension ID explicitly; only local web origins
    # receive the development localhost exception.
    CORS(app, origins=_configured_frontend_origins(), supports_credentials=True)

    @app.after_request
    def add_cors_headers(response):
        origin = request.headers.get("Origin")
        if origin and _is_allowed_origin(origin):
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Api-Key, X-Session-Token, Authorization"
            response.headers["Access-Control-Allow-Credentials"] = "true"
            response.headers["Vary"] = "Origin"
        return response

    app.register_blueprint(ai_bp, url_prefix="/api/ai")
    app.register_blueprint(stripe_bp, url_prefix="/api/stripe")
    app.register_blueprint(auth_bp, url_prefix="/api/auth")
    app.register_blueprint(history_bp, url_prefix="/api/history")

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
