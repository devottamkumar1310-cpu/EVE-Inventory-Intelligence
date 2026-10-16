# ==============================================================================CORSMiddleware
# PURPOSE: FastAPI Application Bootstrap Entrypoint.
# DATA FLOW: Initializes database -> sets up routes -> configures CORS -> runs Web server.
# EXTENSION POINTS: Add global exception handlers, rate limiters, or mount websocket gateways.
# ARCHITECTURAL DECISION:
# - Uvicorn binds to $PORT immediately; heavy DB init runs in a background asyncio task.
# - A readiness guard returns 503 SERVER_INITIALIZING on /api/* until the background
#   task completes, so the app is reachable within 1-2 seconds on every cold start.
# ==============================================================================

import asyncio
import enum
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from app.core.rate_limiter import rate_limit  # noqa: F401  # available for route-level Depends()

from app.config import settings
from app.database import init_db
from app.core.schema_validator import validate_schema, SchemaValidationError
from app.core.logging import setup_logging
from app.routes import inventory
from app.routes import chat
from app.routes import dashboard
# Import model registrations so Base.metadata is fully populated before init_db().
# These are lightweight: no pandas, no google.genai, no openpyxl.
import app.models  # noqa: F401
# NOTE: Heavy service modules (gemini_service, report_service, embeddings, analytics_service,
# competitor_service, supplier_service, memory layers, knowledge_manager, artifact_manager)
# are intentionally NOT imported at module level. They are imported lazily inside the
# background init task or inside the individual route handlers that use them, so they
# do not block Uvicorn port binding during cold start.

logger = logging.getLogger("eve.main")

# Build allowed origins BEFORE the lifespan function is defined,
# so the startup log inside lifespan can reference this list without a NameError.
# Order matters: put more-specific origins first.
allowed_origins = [
    "https://aethercorp-eve.vercel.app",
    "https://eveinventory.in",
    "https://www.eveinventory.in",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:8000",    # Swagger UI self-requests
    "http://127.0.0.1:8000",
]
if settings.FRONTEND_URL:
    for _origin in settings.FRONTEND_URL.split(","):
        _stripped = _origin.strip()
        if _stripped and _stripped not in allowed_origins:
            allowed_origins.append(_stripped)

logger.info(f"[CORS] Allowed origins at module load: {allowed_origins}")


# ──────────────────────────────────────────────────────────────────────────────
# APP READINESS STATE
# Tracks whether the background database initialisation has completed.
# All /api/* endpoints check this before processing a request.
# ──────────────────────────────────────────────────────────────────────────────

class _ReadinessState(enum.Enum):
    INITIALIZING = "initializing"
    READY        = "ready"
    FAILED       = "failed"

_app_state = _ReadinessState.INITIALIZING
_init_failure_detail: str = ""


def _mark_ready() -> None:
    global _app_state
    _app_state = _ReadinessState.READY


def _mark_failed(detail: str) -> None:
    global _app_state, _init_failure_detail
    _app_state = _ReadinessState.FAILED
    _init_failure_detail = detail


def is_ready() -> bool:
    return _app_state == _ReadinessState.READY


# ──────────────────────────────────────────────────────────────────────────────
# BACKGROUND INITIALISATION TASK
# Runs init_db() and validate_schema() asynchronously after Uvicorn has bound.
# Uses run_in_executor so blocking SQLAlchemy calls don't stall the event loop.
# ──────────────────────────────────────────────────────────────────────────────

async def _background_init() -> None:
    """
    Run database initialisation and schema validation in a thread pool so the
    event loop (and therefore Uvicorn's port binding) is never blocked.
    """
    loop = asyncio.get_event_loop()
    try:
        logger.info("[STARTUP] Background init started: running init_db() ...")
        await loop.run_in_executor(None, init_db)
        logger.info("[STARTUP] init_db() completed. Running validate_schema() ...")
        await loop.run_in_executor(None, validate_schema)
        logger.info("[STARTUP] validate_schema() completed. App is READY.")
        _mark_ready()
    except SchemaValidationError as exc:
        detail = f"Schema mismatch: {exc}"
        logger.critical(f"[STARTUP] {detail}")
        _mark_failed(detail)
    except Exception as exc:
        detail = f"Database initialisation failed: {exc}"
        logger.critical(f"[STARTUP] {detail}", exc_info=exc)
        _mark_failed(detail)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Handles application startup and shutdown lifecycle events.

    Uvicorn binds to 0.0.0.0:$PORT as soon as this yields — within 1-2 seconds.
    The expensive init_db() / validate_schema() work runs in the background so
    cold starts no longer trigger Render's port-binding timeout.
    """
    # 1. Setup structured logging
    setup_logging(level="INFO")
    logger.info("EVE Platform starting — launching background DB initialisation ...")
    logger.info(f"[CORS] Allowed origins active: {allowed_origins}")

    # 2. Fire off background initialisation (non-blocking).
    asyncio.create_task(_background_init())

    # 3. Yield immediately so Uvicorn binds to $PORT.
    yield

    logger.info("Shutting down EVE Platform services ...")


# Initialize FastAPI app instance
app = FastAPI(
    title="EVE (Enterprise Virtual Executive) API Gateway",
    description="AI Operating System for D2C Fashion Brands.",
    version="1.0.0",
    lifespan=lifespan
)

# ──────────────────────────────────────────────────────────────────────────────
# READINESS GUARD MIDDLEWARE
# Gates all /api/* requests until the background DB init completes.
# Passes OPTIONS (CORS preflights) through unconditionally so browsers always
# receive their CORS headers regardless of app readiness state.
# ──────────────────────────────────────────────────────────────────────────────

class ReadinessGuardMiddleware:
    """
    Returns 503 SERVER_INITIALIZING for any /api/* request while the background
    database initialisation is still running. This prevents requests from
    hitting uninitialised database state.

    Exempt paths (always pass through):
      - OPTIONS requests (CORS preflights must always get a CORS response)
      - / and /healthz (liveness probes must not be blocked)
      - /docs, /redoc, /openapi.json (Swagger UI)

    Note: Starlette adds CORS headers to responses from this middleware because
    CORSMiddleware is registered AFTER this one and therefore runs FIRST in
    Starlette's LIFO execution order.
    """

    # Paths that must always be served regardless of readiness state.
    _EXEMPT_PREFIXES = ("/docs", "/redoc", "/openapi.json")
    _EXEMPT_EXACT    = {"/", "/healthz"}

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        import json
        from fastapi.responses import JSONResponse

        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        method = scope.get("method", "")
        path   = scope.get("path", "")

        # Always pass through OPTIONS (CORS preflights) and exempt paths.
        if (
            method == "OPTIONS"
            or path in self._EXEMPT_EXACT
            or any(path.startswith(p) for p in self._EXEMPT_PREFIXES)
        ):
            return await self.app(scope, receive, send)

        # For all /api/* routes, enforce readiness.
        if path.startswith("/api/"):
            if _app_state == _ReadinessState.INITIALIZING:
                response = JSONResponse(
                    status_code=503,
                    content={
                        "status": "error",
                        "code": "SERVER_INITIALIZING",
                        "message": "Server is initializing. Please retry in a few seconds.",
                    },
                    headers={"Retry-After": "5"},
                )
                await response(scope, receive, send)
                return
            if _app_state == _ReadinessState.FAILED:
                response = JSONResponse(
                    status_code=503,
                    content={
                        "status": "error",
                        "code": "SERVER_INIT_FAILED",
                        "message": "Server failed to initialize. Check deployment logs.",
                        "detail": "The server could not finish initialization.",
                    },
                )
                await response(scope, receive, send)
                return

        return await self.app(scope, receive, send)

# ──────────────────────────────────────────────────────────────────────────────
# MIDDLEWARE REGISTRATION ORDER NOTE
# Starlette processes middleware in REVERSE registration order.
# The LAST middleware added runs FIRST on incoming requests.
#
# Desired execution order (request in → response out):
#   CORSMiddleware → ReadinessGuardMiddleware → SecurityHeadersMiddleware → Router
#
# To achieve this:
#   - CORSMiddleware is added LAST (executes FIRST — intercepts OPTIONS preflights
#     before ReadinessGuard can block them, so CORS headers always flow back).
#   - ReadinessGuardMiddleware is added second-to-last (blocks /api/* while INITIALIZING;
#     OPTIONS are passed through unconditionally inside the middleware itself as a backup).
#   - SecurityHeadersMiddleware is added FIRST (executes LAST — on response out).
# ──────────────────────────────────────────────────────────────────────────────

# 1. Add SecurityHeadersMiddleware FIRST (executes LAST — on response out).
class SecurityHeadersMiddleware:
    """Injects standard security headers into every HTTP response.
    Skips OPTIONS (preflight) requests so CORS headers are not overwritten.
    Implemented as pure ASGI middleware to prevent disrupting FastAPI dependency teardown.
    """
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                if scope["method"] != "OPTIONS":
                    headers = message.get("headers", [])
                    headers.append((b"x-content-type-options", b"nosniff"))
                    headers.append((b"x-frame-options", b"DENY"))
                    headers.append((b"referrer-policy", b"strict-origin-when-cross-origin"))
                    headers.append((b"x-xss-protection", b"1; mode=block"))
                    headers.append((b"strict-transport-security", b"max-age=31536000; includeSubDomains; preload"))
                    headers.append((b"content-security-policy", b"default-src 'self'; frame-ancestors 'none'; object-src 'none';"))
                    message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_wrapper)


from app.core.internal_analytics_middleware import InternalTelemetryMiddleware
app.add_middleware(InternalTelemetryMiddleware)
app.add_middleware(SecurityHeadersMiddleware)

# 2. Add ReadinessGuardMiddleware second-to-last (executes second — after CORS but
#    before security headers on the way out). Gates /api/* until DB init completes.
app.add_middleware(ReadinessGuardMiddleware)

# 3. Add CORSMiddleware LAST (executes FIRST — intercepts OPTIONS preflights
#    before ReadinessGuard or any router sees them).
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allow_headers=["*"],
    expose_headers=["*"],
    max_age=600,  # Cache preflight for 10 minutes
)



# Global exception handlers for gateway error consistency
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from fastapi.responses import JSONResponse

def get_error_code(status_code: int) -> str:
    if status_code == 400:
        return "BAD_REQUEST"
    elif status_code == 401:
        return "UNAUTHORIZED"
    elif status_code == 402:
        return "PAYMENT_REQUIRED"
    elif status_code == 403:
        return "FORBIDDEN"
    elif status_code == 404:
        return "NOT_FOUND"
    elif status_code == 422:
        return "VALIDATION_ERROR"
    elif status_code == 429:
        return "RATE_LIMIT_EXCEEDED"
    elif status_code >= 500:
        return "INTERNAL_SERVER_ERROR"
    return "ERROR"

@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        headers=getattr(exc, "headers", None),
        content={
            "status": "error",
            "message": exc.detail,
            "code": get_error_code(exc.status_code),
            "detail": exc.detail
        }
    )

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    # str(exc) embeds the rejected INPUT VALUE for every failing field
    # ("... [type=int_parsing, input_value='<what the caller sent>']"). Echoing a
    # request body back to whoever sent it turns a validation error into a
    # reflection gadget, and any credential a client mistakenly posts to the
    # wrong field would come straight back in the response. Only the field
    # location and the reason are returned; the full error, with values, stays
    # in the server log.
    logger.warning(
        "[VALIDATION ERROR] path=%s errors=%s", request.url.path, exc.errors()
    )
    safe_errors = [
        {
            "field": ".".join(str(part) for part in err.get("loc", ())),
            "reason": err.get("msg", "Invalid value."),
        }
        for err in exc.errors()
    ]
    msg = "Request validation failed."
    return JSONResponse(
        status_code=422,
        content={
            "status": "error",
            "message": msg,
            "code": "VALIDATION_ERROR",
            "detail": msg,
            "errors": safe_errors,
        }
    )

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"[GLOBAL UNHANDLED EXCEPTION] path={request.url.path} error={exc}", exc_info=exc)
    from app.services.alert_service import AlertService
    AlertService.alert_http_5xx(str(exc), request.url.path, request.method)
    msg = "An unexpected error occurred."
    return JSONResponse(
        status_code=500,
        content={
            "status": "error",
            "message": msg,
            "code": "INTERNAL_SERVER_ERROR",
            "detail": msg
        }
    )



app.include_router(inventory.router)
app.include_router(chat.router)
app.include_router(dashboard.router)
from app.routes import auth, profile, organization, clients, projects, tasks, finance, analytics, activity, intelligence, executive, feedback, observability, document_intelligence, health, recommendation_trace, account, waitlist, internal_analytics, integrations_shopify, integrations_messaging, billing
app.include_router(auth.router)
app.include_router(account.router)
app.include_router(health.router)
app.include_router(recommendation_trace.router)
app.include_router(document_intelligence.router)
app.include_router(profile.router)
app.include_router(waitlist.router)
app.include_router(organization.router)
app.include_router(clients.router)
app.include_router(projects.router)
app.include_router(tasks.router)
app.include_router(finance.router)
app.include_router(analytics.router)
app.include_router(activity.router)
app.include_router(intelligence.router)
app.include_router(executive.router)
app.include_router(feedback.router)
app.include_router(observability.router)
app.include_router(internal_analytics.router)
app.include_router(integrations_shopify.router)
app.include_router(integrations_messaging.router)
app.include_router(billing.router)

from sqlalchemy.orm import Session
from app.database import get_db
from app.core.security import get_current_user, verify_supabase_token
from app.models.profile import Profile

@app.get("/api/me", tags=["profile"])
def me_alias(
    current_user: Profile = Depends(get_current_user),
    payload: dict = Depends(verify_supabase_token),
    db: Session = Depends(get_db)
):
    return profile.get_my_profile(current_user=current_user, payload=payload, db=db)

@app.get("/api/workspaces", tags=["organization"])
def workspaces_alias(
    current_user: Profile = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    return organization.get_workspaces(current_user=current_user, db=db)


@app.get("/")
def read_root():
    """
    API liveness endpoint. Always responds immediately regardless of DB readiness.
    """
    state = _app_state.value
    return {
        "status": "operational",
        "service": "EVE API Gateway",
        "environment": settings.ENV,
        "ready": is_ready(),
        "init_state": state,
    }

@app.get("/healthz")
def health_check():
    """
    Database-verified health check.
    Returns 200 during initialisation (liveness passes; database shows 'initializing').
    Returns 200 + SELECT 1 ping once READY.
    Returns 503 if background init failed.
    """
    if _app_state == _ReadinessState.INITIALIZING:
        return {
            "status": "initializing",
            "database": "connecting",
            "service": "EVE API Gateway",
        }

    if _app_state == _ReadinessState.FAILED:
        return JSONResponse(
            status_code=503,
            content={
                "status": "unhealthy",
                "database": "init_failed",
                "detail": _init_failure_detail,
            },
        )

    # READY: run a quick DB ping.
    try:
        from sqlalchemy import text
        from app.database import engine
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return {
            "status": "operational",
            "database": "connected",
            "service": "EVE API Gateway",
        }
    except Exception as e:
        logger.error(f"Health check database query failure: {e}")
        return JSONResponse(
            status_code=503,
            content={
                "status": "unhealthy",
                "database": "disconnected",
                "detail": "Failed to connect to the database",
            },
        )

