"""Object storage access for the Media service (Garage, S3 API; D-018). The service reads uploads and writes the
cleaned copies; it never writes database tables (spec 5.1 boundary rule). Presigned upload URLs are signed for the
public endpoint (the proxy), because an S3 signature covers the Host header the client will send (D-071)."""
from __future__ import annotations

import os
from functools import lru_cache

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError, EndpointConnectionError

from fs_common import ServiceError


def _client(endpoint: str):
    return boto3.client("s3", endpoint_url=endpoint, region_name=os.environ.get("S3_REGION", "garage"),
                        aws_access_key_id=os.environ["S3_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["S3_SECRET_ACCESS_KEY"],
                        config=Config(signature_version="s3v4", s3={"addressing_style": "path"},
                                      connect_timeout=5, read_timeout=30, retries={"max_attempts": 2}))


@lru_cache(maxsize=1)
def internal():
    return _client(os.environ.get("S3_ENDPOINT", "http://garage:3900"))


@lru_cache(maxsize=1)
def public():
    return _client(os.environ.get("S3_PUBLIC_ENDPOINT", "http://localhost:8080"))


def bucket() -> str:
    return os.environ.get("S3_BUCKET", "flatshare-media")


def _wrap(e: Exception, key: str):
    if isinstance(e, ClientError):
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("NoSuchKey", "404", "NotFound"):
            raise ServiceError("NOT_FOUND", f"object {key} not found")
        raise ServiceError("UPSTREAM_UNAVAILABLE", f"storage error {code or 'unknown'}")
    raise ServiceError("UPSTREAM_UNAVAILABLE", f"storage unreachable ({type(e).__name__})")


def head(key: str) -> dict:
    try:
        r = internal().head_object(Bucket=bucket(), Key=key)
        return {"bytes": int(r["ContentLength"]), "content_type": r.get("ContentType")}
    except (ClientError, BotoCoreError, EndpointConnectionError) as e:
        _wrap(e, key)


def get(key: str, max_bytes: int) -> bytes:
    info = head(key)
    if info["bytes"] > max_bytes:
        raise ServiceError("VALIDATION_FAILED", f"object is {info['bytes']} bytes, over {max_bytes}",
                           [{"field": "source_key", "issue": "TOO_LARGE"}])
    try:
        return internal().get_object(Bucket=bucket(), Key=key)["Body"].read(max_bytes + 1)
    except (ClientError, BotoCoreError, EndpointConnectionError) as e:
        _wrap(e, key)


def put(key: str, data: bytes, content_type: str) -> None:
    try:
        internal().put_object(Bucket=bucket(), Key=key, Body=data, ContentType=content_type)
    except (ClientError, BotoCoreError, EndpointConnectionError) as e:
        _wrap(e, key)


def delete(keys: list[str]) -> int:
    n = 0
    for k in keys:
        try:
            internal().delete_object(Bucket=bucket(), Key=k)
            n += 1
        except (ClientError, BotoCoreError, EndpointConnectionError) as e:
            _wrap(e, k)
    return n


def presign_put(key: str, content_type: str, expires_s: int) -> str:
    return public().generate_presigned_url("put_object", Params={"Bucket": bucket(), "Key": key, "ContentType": content_type},
                                           ExpiresIn=expires_s, HttpMethod="PUT")
