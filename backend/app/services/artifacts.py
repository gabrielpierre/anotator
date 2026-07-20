import base64
from dataclasses import dataclass
from urllib.parse import quote

from app.core.config import Settings


@dataclass(frozen=True)
class ArtifactBlob:
    content: bytes
    content_type: str | None = None
    size_bytes: int | None = None


@dataclass(frozen=True)
class ArtifactStat:
    uri: str
    content_type: str | None = None
    size_bytes: int | None = None
    etag: str | None = None


class ArtifactStore:
    def put_bytes(self, key: str, content: bytes, content_type: str | None = None) -> str:
        raise NotImplementedError

    def get(self, uri: str) -> ArtifactBlob:
        raise NotImplementedError

    def stat(self, uri: str) -> ArtifactStat:
        raise NotImplementedError

    def exists(self, uri: str) -> bool:
        try:
            self.stat(uri)
        except FileNotFoundError:
            return False
        return True

    def presign(self, uri: str, *, expires_in_seconds: int = 900) -> str:
        raise NotImplementedError


class S3ArtifactStore(ArtifactStore):
    def __init__(self, settings: Settings):
        self.settings = settings

    def put_bytes(self, key: str, content: bytes, content_type: str | None = None) -> str:
        self._client().put_object(
            Bucket=self.settings.s3_bucket,
            Key=key,
            Body=content,
            ContentType=content_type or "application/octet-stream",
        )
        return f"s3://{self.settings.s3_bucket}/{key}"

    def get(self, uri: str) -> ArtifactBlob:
        bucket, key = parse_s3_uri(uri)
        try:
            response = self._client().get_object(Bucket=bucket, Key=key)
        except Exception as exc:
            if _not_found(exc):
                raise FileNotFoundError(uri) from exc
            raise
        content = response["Body"].read()
        return ArtifactBlob(
            content=content,
            content_type=response.get("ContentType"),
            size_bytes=response.get("ContentLength") or len(content),
        )

    def stat(self, uri: str) -> ArtifactStat:
        bucket, key = parse_s3_uri(uri)
        try:
            response = self._client().head_object(Bucket=bucket, Key=key)
        except Exception as exc:
            if _not_found(exc):
                raise FileNotFoundError(uri) from exc
            raise
        return ArtifactStat(
            uri=uri,
            content_type=response.get("ContentType"),
            size_bytes=response.get("ContentLength"),
            etag=response.get("ETag"),
        )

    def presign(self, uri: str, *, expires_in_seconds: int = 900) -> str:
        bucket, key = parse_s3_uri(uri)
        return self._client().generate_presigned_url(
            ClientMethod="get_object",
            Params={"Bucket": bucket, "Key": key},
            ExpiresIn=expires_in_seconds,
        )

    def _client(self):
        import boto3
        from botocore.config import Config

        return boto3.client(
            "s3",
            endpoint_url=self.settings.s3_endpoint,
            aws_access_key_id=self.settings.s3_access_key_id,
            aws_secret_access_key=self.settings.s3_secret_access_key,
            region_name=self.settings.s3_region,
            config=Config(signature_version="s3v4"),
        )


def parse_s3_uri(uri: str) -> tuple[str, str]:
    if not uri.startswith("s3://"):
        raise ValueError("Artifact URI must start with s3://")
    without_scheme = uri.removeprefix("s3://")
    bucket, _, key = without_scheme.partition("/")
    if not bucket or not key:
        raise ValueError("Artifact URI must include bucket and key")
    return bucket, key


def artifact_id_for_uri(uri: str) -> str:
    return base64.urlsafe_b64encode(uri.encode("utf-8")).decode("ascii").rstrip("=")


def uri_for_artifact_id(artifact_id: str) -> str:
    padding = "=" * (-len(artifact_id) % 4)
    return base64.urlsafe_b64decode(f"{artifact_id}{padding}").decode("utf-8")


def proxy_download_url(uri: str) -> str:
    return f"/api/v1/artifacts/{quote(artifact_id_for_uri(uri))}/download"


def _not_found(exc: Exception) -> bool:
    response = getattr(exc, "response", None)
    error = response.get("Error", {}) if isinstance(response, dict) else {}
    return str(error.get("Code")) in {"404", "NoSuchKey", "NotFound"}
