"""Pytest-wide test database isolation for the Visionary Nexus backend.

backend.database binds its SQLAlchemy engine at import time from DATABASE_URL,
defaulting to ./smartglasses.db - i.e. the developer's real database - relative
to the working directory.

Several suites already force their own throw-away location before importing the
backend (tests/test_camera.py and tests/test_vision.py use os.environ.setdefault,
tests/test_device_lifecycle.py assigns the variable directly), but tests/
test_features.py only patches api.SessionLocal while the auth router binds
backend.database.SessionLocal directly, and modules such as tests/test_intents.py
and tests/test_wake_word_custom.py import the backend without setting the
variable at all. Run on their own, those modules could therefore connect to and
write through the real database file.

This root conftest is imported by pytest before any test module for every
invocation - the full suite or a single module - and it points DATABASE_URL at
a fresh throw-away file first. Suites that set their own location keep working:
later assignments win over earlier values, later setdefaults keep the value
already placed here. Whichever engine ends up bound, it can never be the real
smartglasses.db.
"""

import os
import tempfile

_DATABASE_DIR = tempfile.mkdtemp(prefix="nexus-pytest-db-")

os.environ["DATABASE_URL"] = "sqlite:///" + _DATABASE_DIR + "/conftest-tests.db"
