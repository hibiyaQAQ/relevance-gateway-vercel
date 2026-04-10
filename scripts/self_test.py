from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any

import httpx


BASE_URL = os.getenv("SELF_TEST_BASE_URL", "http://127.0.0.1:18080")
ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin")

UPSTREAM_PROJECT = os.getenv("SELF_TEST_UPSTREAM_PROJECT", "")
UPSTREAM_REGION = os.getenv("SELF_TEST_UPSTREAM_REGION", "")
UPSTREAM_API_KEY = os.getenv("SELF_TEST_UPSTREAM_API_KEY", "")
UPSTREAM_MODEL = os.getenv(
    "SELF_TEST_UPSTREAM_MODEL",
    "anthropic-claude-opus-4-6-context-1m",
)


def require(value: str, name: str) -> str:
    if not value:
        raise SystemExit(f"{name} is required for self-test.")
    return value


def collect_sse(
    client: httpx.Client,
    *,
    headers: dict[str, str],
    payload: dict[str, Any],
) -> dict[str, Any]:
    started = time.monotonic()
    first_chunk_ms: int | None = None
    chunk_count = 0
    preview_parts: list[str] = []

    with client.stream(
        "POST",
        "/v1/chat/completions",
        headers=headers,
        json=payload,
    ) as response:
        response.raise_for_status()
        response_headers = dict(response.headers)
        for chunk in response.iter_text():
            if not chunk:
                continue
            chunk_count += 1
            if first_chunk_ms is None:
                first_chunk_ms = int((time.monotonic() - started) * 1000)
            if sum(len(part) for part in preview_parts) < 1600:
                preview_parts.append(chunk)

    return {
        "chunk_count": chunk_count,
        "first_chunk_ms": first_chunk_ms,
        "preview": "".join(preview_parts)[:1600],
        "headers": response_headers,
        "elapsed_ms": int((time.monotonic() - started) * 1000),
    }


def main() -> int:
    require(UPSTREAM_PROJECT, "SELF_TEST_UPSTREAM_PROJECT")
    require(UPSTREAM_REGION, "SELF_TEST_UPSTREAM_REGION")
    require(UPSTREAM_API_KEY, "SELF_TEST_UPSTREAM_API_KEY")

    client = httpx.Client(base_url=BASE_URL, follow_redirects=True, timeout=360)

    login = client.post(
        "/admin-api/login",
        json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD},
    )
    login.raise_for_status()
    run_id = uuid.uuid4().hex[:8]

    upstream_a = client.post(
        "/admin-api/upstream-keys",
        json={
            "name": f"selftest-key-a-{run_id}",
            "project": UPSTREAM_PROJECT,
            "region": UPSTREAM_REGION,
            "api_key": UPSTREAM_API_KEY,
        },
    ).json()["upstream_key"]
    upstream_b = client.post(
        "/admin-api/upstream-keys",
        json={
            "name": f"selftest-key-b-{run_id}",
            "project": UPSTREAM_PROJECT,
            "region": UPSTREAM_REGION,
            "api_key": UPSTREAM_API_KEY,
        },
    ).json()["upstream_key"]

    client.post(f"/admin-api/upstream-keys/{upstream_a['id']}/verify").raise_for_status()
    client.post(f"/admin-api/upstream-keys/{upstream_b['id']}/verify").raise_for_status()

    catalog_cached = client.get(f"/admin-api/model-catalog?upstream_key_id={upstream_a['id']}")
    catalog_cached.raise_for_status()
    catalog_refreshed = client.post(f"/admin-api/model-catalog/refresh?upstream_key_id={upstream_a['id']}")
    catalog_refreshed.raise_for_status()

    deployment_a = client.post(
        f"/admin-api/upstream-keys/{upstream_a['id']}/deployments",
        json={
            "upstream_model": UPSTREAM_MODEL,
        },
    ).json()["deployment"]

    sync_result = client.post(
        f"/admin-api/upstream-keys/{upstream_a['id']}/deployments/sync",
        json={"target_upstream_key_ids": [upstream_b["id"]]},
    ).json()

    gateway_key_result = client.post(
        "/admin-api/gateway-keys",
        json={
            "name": f"selftest-public-{run_id}",
        },
    ).json()
    gateway_key = gateway_key_result["raw_key"]

    headers = {"Authorization": f"Bearer {gateway_key}"}

    models = client.get("/v1/models", headers=headers)
    models.raise_for_status()

    non_stream = client.post(
        "/v1/chat/completions",
        headers=headers,
        json={
            "model": deployment_a["public_model_name"],
            "messages": [{"role": "user", "content": "请用一句话介绍你自己"}],
        },
    )
    non_stream.raise_for_status()

    short_stream = collect_sse(
        client,
        headers=headers,
        payload={
            "model": deployment_a["public_model_name"],
            "stream": True,
            "messages": [{"role": "user", "content": "请用一句话介绍你自己"}],
        },
    )
    long_stream = collect_sse(
        client,
        headers=headers,
        payload={
            "model": deployment_a["public_model_name"],
            "stream": True,
            "messages": [
                {
                    "role": "user",
                    "content": "请写一个中文奇幻冒险故事，至少 1200 字，分成 6 段，每段都有标题。",
                }
            ],
        },
    )

    bootstrap = client.get("/admin-api/bootstrap")
    bootstrap.raise_for_status()

    agents = client.get(f"/admin-api/upstream-keys/{upstream_a['id']}/agents")
    agents.raise_for_status()

    summary: dict[str, Any] = {
        "catalog_cached": {
            "model_count": catalog_cached.json()["catalog"]["model_count"],
            "is_stale": catalog_cached.json()["catalog"]["is_stale"],
        },
        "catalog_refreshed": {
            "model_count": catalog_refreshed.json()["catalog"]["model_count"],
            "is_stale": catalog_refreshed.json()["catalog"]["is_stale"],
        },
        "models": models.json(),
        "non_stream": {
            "headers": dict(non_stream.headers),
            "body": non_stream.json(),
        },
        "short_stream": short_stream,
        "long_stream": long_stream,
        "sync_result": sync_result,
        "upstream_agents": agents.json(),
        "logs_count": len(bootstrap.json()["request_logs"]),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
