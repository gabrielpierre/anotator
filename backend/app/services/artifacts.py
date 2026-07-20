from app.core.config import Settings


class ArtifactStore:
    def put_bytes(self, key: str, content: bytes, content_type: str | None = None) -> str:
        raise NotImplementedError


class S3ArtifactStore(ArtifactStore):
    def __init__(self, settings: Settings):
        self.settings = settings

    def put_bytes(self, key: str, content: bytes, content_type: str | None = None) -> str:
        import boto3
        from botocore.config import Config

        client = boto3.client(
            "s3",
            endpoint_url=self.settings.s3_endpoint,
            aws_access_key_id=self.settings.s3_access_key_id,
            aws_secret_access_key=self.settings.s3_secret_access_key,
            region_name=self.settings.s3_region,
            config=Config(signature_version="s3v4"),
        )
        client.put_object(
            Bucket=self.settings.s3_bucket,
            Key=key,
            Body=content,
            ContentType=content_type or "application/octet-stream",
        )
        return f"s3://{self.settings.s3_bucket}/{key}"
