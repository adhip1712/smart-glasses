import os

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

# The path can be overridden (tests use a throw-away file so they never
# touch the developer's database).
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./smartglasses.db")

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False}
    if DATABASE_URL.startswith("sqlite")
    else {},
)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
