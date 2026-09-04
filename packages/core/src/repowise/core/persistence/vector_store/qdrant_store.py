"""Qdrant-backed vector store (standalone, network-accessible).

Uses plain HTTP (``aiohttp``) against the Qdrant REST API — no heavy
``qdrant-client`` dependency needed.  Every operation maps one-to-one to a
REST endpoint documented at ``https://api.qdrant.tech/api-reference``.

Environment variables
---------------------
QDRANT_URL         Qdrant HTTP endpoint (default ``http://localhost:6333``)
QDRANT_API_KEY     API key for authenticated instances
QDRANT_COLLECTION  Collection name (default ``"repowise-wiki"``)
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from repowise.core.providers.embedding.base import Embedder

from ..search import _SNIPPET_LEN, SearchResult, snippet_around
from ._base import STORED_SNIPPET_CHARS, VectorStore, iter_embed_chunks

__all__ = ["QdrantVectorStore"]

_log = logging.getLogger(__name__)


def _evidence(stored: str, query: str | None) -> str:
    if not stored:
        return ""
    if query:
        return snippet_around(stored, query)
    return stored[:_SNIPPET_LEN].rstrip()


def _page_id_to_uuid(page_id: str) -> str:
    """Deterministic string UUID v5 from a repowise page_id (Qdrant accepts strings)."""
    return str(uuid.uuid5(uuid.NAMESPACE_OID, page_id))


class QdrantVectorStore(VectorStore):
    """Lightweight Qdrant REST backend (~120 lines).

    No ``qdrant-client`` — just ``aiohttp`` talking straight to REST.
    """

    persists_across_runs = True

    def __init__(
        self,
        collection: str,
        embedder: Embedder,
        url: str | None = None,
        api_key: str | None = None,
    ) -> None:
        import os

        self._collection_name = collection
        self._embedder = embedder
        self._url = (url or os.environ.get("QDRANT_URL") or "http://localhost:6333").rstrip("/")
        self._api_key = api_key or os.environ.get("QDRANT_API_KEY") or None
        self._dims: int | None = None

    # ------------------------------------------------------------------ helpers
    def _headers(self) -> dict[str, str]:
        h: dict[str, str] = {"Content-Type": "application/json"}
        if self._api_key:
            h["api-key"] = self._api_key
        return h

    def _url_for(self, path: str) -> str:
        base = f"{self._url}/collections/{self._collection_name}{path}"
        return base

    async def _ensure_created(self) -> None:
        if self._dims is not None:
            return
        self._dims = getattr(self._embedder, "dimensions", 768)
        await self._create_if_missing()

    async def _create_if_missing(self) -> None:
        import aiohttp

        async with aiohttp.ClientSession() as session:
            try:
                async with session.get(
                    f"{self._url}/collections/{self._collection_name}",
                    headers=self._headers(),
                    timeout=aiohttp.ClientTimeout(total=5),
                ) as resp:
                    if resp.status == 200:
                        return  # already exists
            except Exception:
                pass  # unreachable, will fail later on first write

        # Create collection
        payload = {
            "vectors": {"size": self._dims, "distance": "Cosine"}
        }
        async with aiohttp.ClientSession() as session:
            async with session.put(
                f"{self._url}/collections/{self._collection_name}",
                json=payload,
                headers=self._headers(),
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                if resp.status in (200, 201):
                    _log.info("Created Qdrant collection '%s' (dim=%d)", self._collection_name, self._dims)
                elif resp.status == 409:
                    _log.debug("Collection '%s' already exists (race)", self._collection_name)
                else:
                    body = await resp.text()
                    raise RuntimeError(f"Qdrant create collection failed ({resp.status}): {body}")

    # ------------------------------------------------------------- public methods
    async def embed_and_upsert(self, page_id: str, text: str, metadata: dict) -> None:
        vectors = await self._embedder.embed([text])
        point_id = _page_id_to_uuid(page_id)
        payload: dict[str, Any] = {**metadata, "page_id": page_id}
        snippet = text[:STORED_SNIPPET_CHARS]
        if snippet:
            payload["content_snippet"] = snippet

        await self._ensure_created()
        body = {"points": [{"id": point_id, "vector": vectors[0], "payload": payload}]}

        import aiohttp
        async with aiohttp.ClientSession() as session:
            async with session.put(
                self._url_for("/points"),
                json=body,
                headers=self._headers(),
            ):
                pass

    async def embed_batch(self, items: list[tuple[str, str, dict]]) -> None:
        if not items:
            return
        await self._ensure_created()

        chunks_payloads: list[list[dict]] = []
        for chunk, texts in iter_embed_chunks(items):
            vectors = await self._embedder.embed(texts)
            batch_points: list[dict] = []
            for (page_id, text, metadata), vector in zip(chunk, vectors, strict=True):
                pid = _page_id_to_uuid(page_id)
                pl: dict[str, Any] = {**metadata, "page_id": page_id}
                snip = text[:STORED_SNIPPET_CHARS]
                if snip:
                    pl["content_snippet"] = snip
                batch_points.append({"id": pid, "vector": vector, "payload": pl})
            chunks_payloads.append(batch_points)

        import aiohttp
        async with aiohttp.ClientSession() as session:
            for points in chunks_payloads:
                async with session.put(
                    self._url_for("/points"),
                    json={"points": points},
                    headers=self._headers(),
                ):
                    pass

    async def search(self, query: str, limit: int = 10) -> list[SearchResult]:
        vectors = await self._embedder.embed([query])
        body = {
            "vector": vectors[0],
            "limit": limit,
            "with_payload": True,
            "with_vector": False,
        }

        import aiohttp
        async with aiohttp.ClientSession() as session:
            async with session.post(
                self._url_for("/points/search"),
                json=body,
                headers=self._headers(),
            ) as resp:
                data = await resp.json()
                hits = data.get("result", {}).get("scores", []) or data.get("result", [])

        results: list[SearchResult] = []
        for hit in hits:
            payload = (hit.get("payload") or {}) if isinstance(hit, dict) else {}
            score = hit.get("score", 0) if isinstance(hit, dict) else 0
            results.append(
                SearchResult(
                    id=str(payload.get("page_id", "")),
                    score=score,
                    target_path=str(payload.get("target_path", "")),
                    page_type=str(payload.get("page_type", "")),
                    title=str(payload.get("title", "")),
                    evidence=_evidence(str(payload.get("content_snippet", "")), query),
                )
            )
        return results

    async def search_by_vector(self, vector: list[float], limit: int = 10) -> list[SearchResult] | None:
        body = {
            "vector": vector,
            "limit": limit,
            "with_payload": True,
            "with_vector": False,
        }

        import aiohttp
        async with aiohttp.ClientSession() as session:
            async with session.post(
                self._url_for("/points/search"),
                json=body,
                headers=self._headers(),
            ) as resp:
                data = await resp.json()
                hits = data.get("result", {}).get("scores", []) or data.get("result", [])

        return [
            SearchResult(
                id=str((h.get("payload") or {}).get("page_id", "")),
                score=h.get("score", 0),
                target_path=str((h.get("payload") or {}).get("target_path", "")),
                page_type=str((h.get("payload") or {}).get("page_type", "")),
                title=str((h.get("payload") or {}).get("title", "")),
                evidence=str((h.get("payload") or {}).get("content_snippet", ""))[:_SNIPPET_LEN],
            )
            for h in hits
            if isinstance(h, dict) and h.get("payload")
        ]

    async def delete(self, page_id: str) -> None:
        point_id = _page_id_to_uuid(page_id)
        await self._ensure_created()
        body = {"points": [point_id], "wait": False}

        import aiohttp
        async with aiohttp.ClientSession() as session:
            async with session.delete(
                self._url_for("/points"),
                json=body,
                headers=self._headers(),
            ):
                pass

    async def delete_many(self, page_ids: list[str]) -> None:
        if not page_ids:
            return
        ids = [_page_id_to_uuid(pid) for pid in page_ids]
        await self._ensure_created()
        body = {"points": ids, "wait": False}

        import aiohttp
        async with aiohttp.ClientSession() as session:
            async with session.delete(
                self._url_for("/points"),
                json=body,
                headers=self._headers(),
            ):
                pass

    async def close(self) -> None:
        pass  # stateless REST, nothing to close

    async def list_page_ids(self) -> set[str]:
        """Scroll every point and collect ``page_id`` payloads."""
        ids: set[str] = set()
        offset_val: Any = None
        while True:
            import aiohttp
            scroll_body: dict[str, Any] = {
                "limit": 1000,
                "with_payload": True,
                "with_vector": False,
            }
            if offset_val is not None:
                scroll_body["offset"] = offset_val

            async with aiohttp.ClientSession() as session:
                async with session.post(
                    self._url_for("/points/scroll"),
                    json=scroll_body,
                    headers=self._headers(),
                ) as resp:
                    data = await resp.json()
                    results = data.get("result", [])

            if not results:
                break

            for point in results:
                pl = point.get("payload") or {}
                pid = pl.get("page_id")
                if pid:
                    ids.add(str(pid))
                # Use next point ID as offset (Qdrant native pagination)
                offset_val = point.get("id")

            if len(results) < 1000:
                break
        return ids

    async def get_page_summary_by_path(self, path: str) -> dict | None:
        """Return summary dict for a previously-indexed page, or None."""
        scroll_body = {
            "limit": 1,
            "with_payload": True,
            "with_vector": False,
            "filter": {
                "must": [
                    {"key": "target_path", "match": {"value": path}}
                ]
            },
        }

        import aiohttp
        async with aiohttp.ClientSession() as session:
            async with session.post(
                self._url_for("/points/scroll"),
                json=scroll_body,
                headers=self._headers(),
            ) as resp:
                data = await resp.json()
                results = data.get("result", [])

        if not results:
            return None
        payload = results[0].get("payload") or {}
        summary = str(payload.get("content_snippet", ""))[:_SNIPPET_LEN]
        return {"summary": summary, "key_exports": []}

    async def get_page_summaries_by_paths(self, paths: list[str]) -> dict[str, dict]:
        if not paths:
            return {}
        out: dict[str, dict] = {}
        for path in paths:
            result = await self.get_page_summary_by_path(path)
            if result and result.get("summary"):
                out[path] = result
        return out
