"""
Refuses to run the test suite against a non-local database.

WHY THIS EXISTS — a real incident, 2026-08-01:

`app.database.engine` is built from DATABASE_URL, and DATABASE_URL points at
production Supabase even when the suite runs on a laptop. Any test that binds to
that engine operates on live customer data. One did:

    # tests/test_demo_workspace_consistency.py
    finally:
        Base.metadata.drop_all(bind=engine)     # <-- dropped 34 production tables

Running `pytest tests/` dropped every application table in production. Only
`alembic_version` survived, because it is not part of Base.metadata. The schema
was silently recreated — empty — on the next backend cold start, because
init_db() calls create_all() at startup. Nothing alerted: no error, no failed
request. 49 accounts remained in Supabase's own auth.users while every profile,
workspace and uploaded catalogue behind them was gone.

The guard is deliberately a hard abort at collection time rather than a fixture,
so it fires before any test module's import-time or fixture code can touch the
engine.

To run integration tests, point DATABASE_URL at a local or disposable database:

    DATABASE_URL=postgresql://postgres:postgres@localhost:5432/eve_test pytest

To override deliberately (you had better be certain):

    EVE_ALLOW_NONLOCAL_TEST_DB=1 pytest
"""
import os
from urllib.parse import urlparse

import pytest

# Hosts that are safe to run a destructive suite against.
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "0.0.0.0", "db", "postgres", ""}


def _is_local(url: str) -> bool:
    if not url:
        return True  # unset -> app falls back to a local/sqlite default
    if url.startswith("sqlite"):
        return True
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    return host in _LOCAL_HOSTS


def _effective_database_url() -> str:
    """
    The URL the app will actually use.

    Reading os.environ alone is NOT sufficient and gave a false all-clear on the
    first version of this guard: DATABASE_URL lives in backend/.env and is loaded
    by pydantic-settings, so the OS environment is empty while the engine still
    connects to production. Resolve it the same way app.database does.
    """
    env_url = os.environ.get("DATABASE_URL", "")
    if env_url:
        return env_url
    try:
        from app.config import settings
        return getattr(settings, "DATABASE_URL", "") or ""
    except Exception:
        # If config cannot be imported we cannot prove the target is safe.
        # Return a sentinel that fails the local check rather than passing it.
        return "postgresql://unknown-host/unresolved"


def pytest_configure(config):
    if os.environ.get("EVE_ALLOW_NONLOCAL_TEST_DB") == "1":
        return

    url = _effective_database_url()
    if _is_local(url):
        return

    host = urlparse(url).hostname or "unknown"
    # UsageError so pytest reports a clean, readable abort instead of dumping an
    # INTERNALERROR traceback around a bare SystemExit.
    raise pytest.UsageError(
        "\n"
        "=========================================================================\n"
        " ABORTED: the test suite is pointed at a NON-LOCAL database.\n"
        f"   host: {host}\n"
        "\n"
        " Tests in this suite call Base.metadata.drop_all() on app.database.engine.\n"
        " Running them here would destroy real data — this has happened before.\n"
        "\n"
        " Point DATABASE_URL at a disposable database, e.g.\n"
        "   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/eve_test\n"
        "\n"
        " Override only if you are certain: EVE_ALLOW_NONLOCAL_TEST_DB=1\n"
        "=========================================================================\n"
    )

@pytest.fixture(autouse=True)
def _force_app_ready():
    # Because main.py uses background init, test clients hitting the app immediately
    # will get 503s. We force the app to be READY for the test suite.
    from app.main import _mark_ready
    _mark_ready()
