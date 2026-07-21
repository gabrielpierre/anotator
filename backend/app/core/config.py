from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    environment: str = Field(default="development", alias="ENVIRONMENT")
    database_url: str = Field(default="sqlite:///./anotator.db", alias="DATABASE_URL")
    redis_url: str = Field(default="redis://localhost:6379/0", alias="REDIS_URL")

    cvat_base_url: str = Field(default="http://localhost:8080", alias="CVAT_BASE_URL")
    cvat_access_token: str | None = Field(default=None, alias="CVAT_ACCESS_TOKEN")
    cvat_auth_scheme: str = Field(default="Bearer", alias="CVAT_AUTH_SCHEME")
    cvat_host_header: str | None = Field(default=None, alias="CVAT_HOST_HEADER")
    cvat_request_timeout_seconds: float = Field(default=20.0, alias="CVAT_REQUEST_TIMEOUT_SECONDS")
    annotation_frame_max_side: int = Field(default=1920, alias="ANNOTATION_FRAME_MAX_SIDE")
    annotation_frame_jpeg_quality: int = Field(default=84, alias="ANNOTATION_FRAME_JPEG_QUALITY")
    annotation_frame_source_quality: str = Field(default="compressed", alias="ANNOTATION_FRAME_SOURCE_QUALITY")
    annotation_frame_cache_dir: str = Field(
        default="/tmp/anotator-frame-cache",
        alias="ANNOTATION_FRAME_CACHE_DIR",
    )

    mlflow_tracking_uri: str = Field(default="http://localhost:5000", alias="MLFLOW_TRACKING_URI")
    s3_endpoint: str = Field(default="http://localhost:9000", alias="S3_ENDPOINT")
    s3_bucket: str = Field(default="anotator-artifacts", alias="S3_BUCKET")
    s3_access_key_id: str = Field(default="minioadmin", alias="S3_ACCESS_KEY_ID")
    s3_secret_access_key: str = Field(default="minioadmin", alias="S3_SECRET_ACCESS_KEY")
    s3_region: str = Field(default="us-east-1", alias="S3_REGION")
    dataset_export_format: str = Field(default="CVAT for images 1.1", alias="DATASET_EXPORT_FORMAT")
    cvat_request_poll_attempts: int = Field(default=30, alias="CVAT_REQUEST_POLL_ATTEMPTS")
    cvat_request_poll_interval_seconds: float = Field(default=1.0, alias="CVAT_REQUEST_POLL_INTERVAL_SECONDS")

    cors_origins_raw: str = Field(default="http://localhost:3000", alias="CORS_ORIGINS")
    auto_create_tables: bool = Field(default=False, alias="AUTO_CREATE_TABLES")
    internal_api_key: str | None = Field(default=None, alias="INTERNAL_API_KEY")
    auth_exempt_paths_raw: str = Field(
        default="/api/v1/health,/api/v1/auth/login,/docs,/redoc,/openapi.json",
        alias="AUTH_EXEMPT_PATHS",
    )
    session_ttl_hours: int = Field(default=168, alias="SESSION_TTL_HOURS")
    default_admin_email: str = Field(default="admin@cvat.plus", alias="DEFAULT_ADMIN_EMAIL")
    default_admin_password: str = Field(default="admin123", alias="DEFAULT_ADMIN_PASSWORD")
    default_admin_name: str = Field(default="Administrador", alias="DEFAULT_ADMIN_NAME")

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins_raw.split(",") if origin.strip()]

    @property
    def auth_exempt_paths(self) -> list[str]:
        return [path.strip() for path in self.auth_exempt_paths_raw.split(",") if path.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
