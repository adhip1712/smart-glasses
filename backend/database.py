import os
from urllib.parse import urlsplit

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

# Prefer the hosted Turso database when both credentials are configured.
# Keep the existing SQLite fallback for local development and tests.
TURSO_DATABASE_URL = os.getenv("TURSO_DATABASE_URL", "").strip()
TURSO_AUTH_TOKEN = os.getenv("TURSO_AUTH_TOKEN", "").strip()

if bool(TURSO_DATABASE_URL) != bool(TURSO_AUTH_TOKEN):
    raise RuntimeError(
        "TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must both be configured."
    )

if TURSO_DATABASE_URL and TURSO_AUTH_TOKEN:
    parsed_url = urlsplit(TURSO_DATABASE_URL)

    # SQLAlchemy's libSQL dialect expects the host after sqlite+libsql://.
    # Turso supplies URLs in the libsql://host form.
    if parsed_url.scheme not in ("libsql", "https"):
        raise RuntimeError(
            "TURSO_DATABASE_URL must use the libsql:// or https:// scheme."
        )

    database_host = parsed_url.netloc
    if not database_host:
        raise RuntimeError("TURSO_DATABASE_URL does not contain a database host.")

    DATABASE_URL = f"sqlite+libsql://{database_host}?secure=true"
    CONNECT_ARGS = {"auth_token": TURSO_AUTH_TOKEN}
else:
    DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./smartglasses.db")
    CONNECT_ARGS = (
        {"check_same_thread": False}
        if DATABASE_URL.startswith("sqlite")
        else {}
    )

engine = create_engine(
    DATABASE_URL,
    connect_args=CONNECT_ARGS,
)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
