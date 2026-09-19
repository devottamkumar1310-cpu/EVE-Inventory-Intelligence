# ==============================================================================
# PURPOSE: Database session and engine configuration.
# DATA FLOW: Creates connection pool to database, providing SQLAlchemy sessions to routes.
# EXTENSION POINTS: Add database migration hooks or custom connection pools (e.g., PgBouncer).
# ARCHITECTURAL DECISION:
# - Leverages standard SQLAlchemy Session factories.
# - Includes automatic SQLite fallback for testing environments where Postgres is not running.
# - Exposes a dependency injection generator function `get_db` for FastAPI routes.
# ==============================================================================

import logging
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
from app.config import settings

logger = logging.getLogger("eve.database")

# Setup connection options
database_url = settings.DATABASE_URL
if database_url and database_url.startswith("postgres://"):
    database_url = database_url.replace("postgres://", "postgresql://", 1)

engine_args = {}

# SQLite specific tuning parameters
if database_url.startswith("sqlite"):
    engine_args["connect_args"] = {"check_same_thread": False}
else:
    # Postgres specific connection pool limits (Tuned for Supabase session mode limit)
    engine_args["pool_size"] = 5
    engine_args["max_overflow"] = 5
    # pool_pre_ping: validate connection health before checkout.
    # Eliminates 'idle in transaction' sessions that have been
    # abandoned by a previous request but not yet returned/closed.
    engine_args["pool_pre_ping"] = True
    # pool_recycle: force-recycle connections older than 5 minutes.
    # Prevents Postgres from accumulating long-lived idle connections.
    engine_args["pool_recycle"] = 300
    # pool_timeout: raise immediately if no connection available within 30s.
    # Prevents request pile-up during overload instead of hanging forever.
    engine_args["pool_timeout"] = 30

# Create engine lazily: create_engine() is non-blocking (no network call).
# The first actual connection is deferred until init_db() runs in the background
# task, so Uvicorn binds to $PORT immediately without any WAN round-trip.
Base = declarative_base()
engine = None
SessionLocal = None

try:
    from sqlalchemy.engine.url import make_url

    # 1. Log environment loading status by checking if it matches the default fallback
    is_default = (database_url == "postgresql://postgres:postgres@localhost:5432/eve")
    logger.info(f"[DB CONFIG] .env loaded custom DATABASE_URL: {not is_default}")

    # 2. Parse and log host and username safely (no connection made here)
    parsed_url = make_url(database_url)
    host_info = parsed_url.host if parsed_url.host else "Unix Socket/Local"
    logger.info(f"[DB CONFIG] Parsed Host: {host_info}")
    logger.info(f"[DB CONFIG] Parsed Username: {parsed_url.username}")

    # create_engine() is lazy — no socket opened, no WAN round-trip.
    engine = create_engine(database_url, **engine_args)
    logger.info("[DB CONFIG] SQLAlchemy engine created (connection deferred until first use).")
except Exception as e:
    logger.error(f"Failed to configure primary database engine: {e}")
    logger.warning("Falling back to local SQLite database 'eve_mvp.db'.")
    fallback_url = "sqlite:///eve_mvp.db"
    engine = create_engine(fallback_url, connect_args={"check_same_thread": False})

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

from sqlalchemy.engine import Engine
from sqlalchemy import event

@event.listens_for(Engine, "connect")
def set_sqlite_pragma(dbapi_connection, connection_record):
    if "sqlite" in str(dbapi_connection.__class__.__name__).lower():
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA foreign_keys=ON")
        except Exception:
            pass
        finally:
            cursor.close()


def get_db():
    """
    FastAPI dependency that provides a transactional database session.
    Automatically rolls back on exceptions and closes the session when done.
    """
    db = SessionLocal()
    try:
        yield db
    except Exception as e:
        db.rollback()
        from app.services.alert_service import AlertService
        AlertService.alert_database_failure(str(e))
        raise e
    finally:
        # We also add a safe rollback in finally just in case it wasn't caught
        # (e.g., GeneratorExit / CancelledError). SQLAlchemy ignores rollback if no transaction is active.
        try:
            db.rollback()
        except:
            pass
        db.close()



from sqlalchemy import event
import datetime

@event.listens_for(Base, 'load', propagate=True)
def convert_datetimes_to_utc(target, context):
    for key in list(target.__dict__.keys()):
        value = target.__dict__[key]
        if isinstance(value, datetime.datetime) and value.tzinfo is None:
            setattr(target, key, value.replace(tzinfo=datetime.timezone.utc))


def as_naive_utc(value):
    """
    Normalises a datetime read off a model to naive UTC.

    The listener above makes every datetime tz-AWARE once a row has been loaded,
    while models are written with naive datetime.utcnow(). Comparing the two
    directly raises "can't compare offset-naive and offset-aware datetimes" — and
    only on the path where the row was loaded in a different request from the one
    that wrote it, which is exactly the production path and not the obvious test.
    Any expiry check against a persisted timestamp must go through this.
    """
    if value is None:
        return None
    if value.tzinfo is None:
        return value
    return value.astimezone(datetime.timezone.utc).replace(tzinfo=None)


def init_db():
    """
    Initializes database schemas. Creating tables if they do not exist.
    """
    # Serialises schema creation across concurrently starting workers.
    # The container runs `uvicorn --workers 2`, and Cloud Run may start several
    # instances at once. create_all(checkfirst=True) inspects, then creates, so
    # two workers could both pass the inspection and race, and the loser died
    # with "type ... already exists", killing the parent process and failing the
    # whole instance. A transaction-scoped advisory lock makes exactly one worker
    # perform the DDL; the others block, then find the tables already present.
    DDL_LOCK_KEY = 776699001

    try:
        # Import all models to ensure they are registered on Base.metadata
        from sqlalchemy import text

        if "postgresql" in engine.url.drivername:
            with engine.begin() as conn:
                conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector;"))
                logger.info("PostgreSQL pgvector extension verified.")

                # Held until this transaction commits, so create_all below is
                # protected. It must run on THIS connection to be covered.
                conn.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": DDL_LOCK_KEY})
                logger.info("Acquired schema-initialisation advisory lock.")
                Base.metadata.create_all(bind=conn)
        else:
            # SQLite/tests: no cross-process contention to guard against.
            Base.metadata.create_all(bind=engine)

        logger.info("Database schemas initialized successfully.")
    except Exception as e:
        # Belt and braces: if another actor created the schema between our
        # inspection and DDL, that is a benign race, not a reason to kill the
        # worker and take the instance down with it.
        message = str(e).lower()
        if "already exists" in message or "duplicatetable" in message or "duplicateobject" in message:
            logger.warning(f"Schema already present, continuing startup: {e}")
            return
        logger.error(f"Error during database initialization: {e}")
        raise e
