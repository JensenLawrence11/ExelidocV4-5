"""Decorators for shared, privacy-preserving endpoint rate limits."""
import logging
from dataclasses import dataclass
from functools import wraps
from typing import Callable

from flask import current_app, jsonify, request

from config import Config
from services.monitoring_service import capture_exception
from services.rate_limit_service import consume_rate_limit


@dataclass(frozen=True)
class RateLimit:
    dimension: str
    max_requests: int
    window_seconds: int


def _identity(dimension: str) -> str | None:
    if dimension == "ip":
        return request.remote_addr or "unknown"
    if dimension == "email":
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            data = {}
        email = data.get("email")
        return email.strip().lower() if isinstance(email, str) and email.strip() else None
    if dimension == "token":
        token = request.form.get("token") or request.args.get("token")
        if not token:
            data = request.get_json(silent=True)
            if not isinstance(data, dict):
                data = {}
            token = data.get("token")
        return token if isinstance(token, str) and token else None
    raise ValueError(f"Unsupported rate-limit dimension: {dimension}")


def rate_limited(
    action: str,
    *limits: RateLimit,
    methods: tuple[str, ...] = ("POST",),
) -> Callable:
    def decorate(handler: Callable) -> Callable:
        @wraps(handler)
        def wrapped(*args, **kwargs):
            if Config.ENV != "production" or request.method not in methods:
                return handler(*args, **kwargs)

            for limit in limits:
                identity = _identity(limit.dimension)
                if identity is None:
                    continue
                try:
                    allowed, retry_after = consume_rate_limit(
                        action,
                        identity,
                        limit.max_requests,
                        limit.window_seconds,
                    )
                except Exception as error:
                    current_app.logger.error(
                        "api_rate_limit_unavailable action=%s exception_type=%s",
                        action,
                        type(error).__name__,
                    )
                    capture_exception(error)
                    return jsonify(error="Authentication is temporarily unavailable. Try again shortly."), 503

                if not allowed:
                    current_app.logger.warning(
                        "api_rate_limit_rejected action=%s dimension=%s",
                        action,
                        limit.dimension,
                    )
                    response = jsonify(error="Too many attempts. Try again later.")
                    response.headers["Retry-After"] = str(retry_after)
                    return response, 429

            return handler(*args, **kwargs)

        return wrapped

    return decorate
