import os

from sqlalchemy import create_engine, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./photoframe.db")

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def migrate_schema() -> None:
    """Apply lightweight additive migrations for existing SQLite databases."""
    if not DATABASE_URL.startswith("sqlite"):
        return

    with engine.begin() as conn:
        tables = {
            row[0]
            for row in conn.execute(
                text("SELECT name FROM sqlite_master WHERE type='table'")
            ).fetchall()
        }
        if "frames" not in tables:
            return

        columns = {
            row[1]
            for row in conn.execute(text("PRAGMA table_info(frames)")).fetchall()
        }
        if "source_type" not in columns:
            conn.execute(
                text(
                    "ALTER TABLE frames ADD COLUMN source_type VARCHAR(32) "
                    "NOT NULL DEFAULT 'album'"
                )
            )
            conn.execute(
                text(
                    "UPDATE frames SET source_type = 'library' "
                    "WHERE album_id IS NULL OR album_id = ''"
                )
            )
        if "owner_user_id" not in columns:
            conn.execute(
                text("ALTER TABLE frames ADD COLUMN owner_user_id INTEGER")
            )
        if "seasonal_weighting" not in columns:
            conn.execute(
                text(
                    "ALTER TABLE frames ADD COLUMN seasonal_weighting "
                    "BOOLEAN NOT NULL DEFAULT 1"
                )
            )
        if "seasonal_strength" not in columns:
            conn.execute(
                text(
                    "ALTER TABLE frames ADD COLUMN seasonal_strength "
                    "INTEGER NOT NULL DEFAULT 3"
                )
            )
            # Preserve prior on/off preference when upgrading.
            conn.execute(
                text(
                    "UPDATE frames SET seasonal_strength = CASE "
                    "WHEN seasonal_weighting = 0 THEN 0 ELSE 3 END"
                )
            )
        if "show_photo_location" not in columns:
            conn.execute(
                text(
                    "ALTER TABLE frames ADD COLUMN show_photo_location "
                    "BOOLEAN NOT NULL DEFAULT 1"
                )
            )
        if "overlay_json" not in columns:
            conn.execute(
                text(
                    "ALTER TABLE frames ADD COLUMN overlay_json TEXT "
                    "NOT NULL DEFAULT '{}'"
                )
            )
        if "context_json" not in columns:
            conn.execute(
                text(
                    "ALTER TABLE frames ADD COLUMN context_json TEXT "
                    "NOT NULL DEFAULT '{}'"
                )
            )
        if "slideshow_json" not in columns:
            conn.execute(
                text(
                    "ALTER TABLE frames ADD COLUMN slideshow_json TEXT "
                    "NOT NULL DEFAULT '{}'"
                )
            )
        if "allow_photo_actions" not in columns:
            conn.execute(
                text(
                    "ALTER TABLE frames ADD COLUMN allow_photo_actions "
                    "BOOLEAN NOT NULL DEFAULT 0"
                )
            )
        if "configured" not in columns:
            conn.execute(
                text(
                    "ALTER TABLE frames ADD COLUMN configured "
                    "BOOLEAN NOT NULL DEFAULT 0"
                )
            )
            # Existing frames were already in use — treat them as configured.
            conn.execute(text("UPDATE frames SET configured = 1"))

        if "users" in tables:
            user_columns = {
                row[1]
                for row in conn.execute(text("PRAGMA table_info(users)")).fetchall()
            }
            if "is_admin" not in user_columns:
                conn.execute(
                    text(
                        "ALTER TABLE users ADD COLUMN is_admin "
                        "BOOLEAN NOT NULL DEFAULT 0"
                    )
                )
                # Bootstrap: oldest user becomes server admin.
                conn.execute(
                    text(
                        "UPDATE users SET is_admin = 1 WHERE id = ("
                        "SELECT id FROM users ORDER BY id ASC LIMIT 1)"
                    )
                )

        if "app_config" in tables:
            app_columns = {
                row[1]
                for row in conn.execute(text("PRAGMA table_info(app_config)")).fetchall()
            }
            if "immich_server_name" not in app_columns:
                conn.execute(
                    text(
                        "ALTER TABLE app_config ADD COLUMN immich_server_name "
                        "VARCHAR(255) DEFAULT 'Immich'"
                    )
                )
            if "weather_api_key" not in app_columns:
                conn.execute(
                    text("ALTER TABLE app_config ADD COLUMN weather_api_key TEXT DEFAULT ''")
                )
            if "weather_units" not in app_columns:
                conn.execute(
                    text(
                        "ALTER TABLE app_config ADD COLUMN weather_units "
                        "VARCHAR(16) DEFAULT 'imperial'"
                    )
                )


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
