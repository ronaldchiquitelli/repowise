"""Qdrant-backed vector store (standalone, network-accessible)."""

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
    return str(uuid.uuid5(uuid.NAMESPACE_OID, page_id))


class QdrantVectorStore(VectorStore):
    """Vector store backed by a remote Qdrant instance.

    Requires the ``qdrant-client`` package (``pip install qdrant-client``).

    Environment variables:
        QDRANT_URL        Qdrant endpoint (default: ``http://localhost:6333``)
        QDRANT_API_KEY    Optional API key
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
        self._url = url or os.environ.get("QDRANT_URL", "http://localhost:6333")
        self._api_key = api_key or os.environ.get("QDRANT_API_KEY") or None
        self._client: Any = None
        self._qm: Any = None

    async def _ensure_connected(self) -> None:
        if self._client is not None:
            return
        try:
            from qdrant_client import AsyncQdrantClient
            from qdrant_client.http import models as qm
        except ImportError as exc:
            raise RuntimeError(
                "Qdrant client not installed. Install with: pip install qdrant-client"
            ) from exc

        self._qm = qm
        self._client = AsyncQdrantClient(
            url=self._url, api_key=self._api_key, prefer_grpc=True,
        )
        collections = await self._client.get_collections()
        existing = {c.name for c in collections.collections}
        if self._collection_name not in existing:
            dim = getattr(self._embedder, "dimensions", 768)
            await self._client.create_collection(
                collection_name=self._collection_name,
                vectors_config=qm.VectorParams(size=dim, distance=qm.Distance.COSINE),
            )
            _log.info("Created Qdrant collection '%s' (dim=%d)", self._collection_name, dim)

    async def embed_and_upsert(self, page_id: str, text: str, metadata: dict) -> None:
        vectors = await self._embedder.embed([text])
        point_id = _page_id_to_uuid(page_id)
        payload: dict[str, Any] = dict(metadata)
        payload["page_id"] = page_id
        payload["content_snippet"] = text[: STORED_SNIPPET_CHARS]
        await self._ensure_connected()
        await self._client.upsert(
            collection_name=self._collection_name,
            points=[self._qm.PointStruct(id=point_id, vector=vectors[0], payload=payload)],
        )

    async def embed_batch(self, items: list[tuple[str, str, dict]]) -> None:
        if not items:
            return
        await self._ensure_connected()
        points: list[Any] = []
        for chunk, texts in iter_embed_chunks(items):
            vectors = await self._embedder.embed(texts)
            for (page_id, text, metadata), vector in zip(chunk, vectors, strict=True):
                point_id = _page_id_to_uuid(page_id)
                payload: dict[str, Any] = dict(metadata)
                payload["page_id"] = page_id
                payload["content_snippet"] = text[: STORED_SNIPPET_CHARS]
                points.append(self._qm.PointStruct(id=point_id, vector=vector, payload=payload))
            if points:
                await self._client.upsert(
                    collection_name=self._collection_name, points=points, wait=False,
                )
                points.clear()

    async def search(self, query: str, limit: int = 10) -> list[SearchResult]:
        await self._ensure_connected()
        vectors = await self._embedder.embed([query])
        hits = await self._client.search(
            collection_name=self._collection_name,
            query_vector=vectors[0],
            limit=limit,
            with_payload=True,
        )
        results: list[SearchResult] = []
        for hit in hits:
            payload = hit.payload or {}
            results.append(
                SearchResult(
                    id=str(payload.get("page_id", "")),
                    score=hit.score,
                    target_path=str(payload.get("target_path", "")),
                    page_type=str(payload.get("page_type", "")),
                    title=str(payload.get("title", "")),
                    evidence=_evidence(str(payload.get("content_snippet", "")), query),
                )
            )
        return results

    async def search_by_vector(self, vector: list[float], limit: int = 10) -> list[SearchResult] | None:
        await self._ensure_connected()
        hits = await self._client.search(
            collection_name=self._collection_name,
            query_vector=vector,
            limit=limit,
            with_payload=True,
        )
        return [
            SearchResult(
                id=str(hit.payload.get("page_id", "")),
                score=hit.score,
                target_path=str(hit.payload.get("target_path", "")),
                page_type=str(hit.payload.get("page_type", "")),
                title=str(hit.payload.get("title", "")),
                evidence=str(hit.payload.get("content_snippet", ""))[:_SNIPPET_LEN],
            )
            for hit in hits if hit.payload
        ]

    async def delete(self, page_id: str) -> None:
        point_id = _page_id_to_uuid(page_id)
        await self._ensure_connected()
        await self._client.delete(
            collection_name=self._collection_name,
            points_selector=self._qm.PointIdsList([point_id]),
        )

    async def delete_many(self, page_ids: list[str]) -> None:
        if not page_ids:
            return
        point_ids = [_page_id_to_uuid(pid) for pid in page_ids]
        await self._ensure_connected()
        await self._client.delete(
            collection_name=self._collection_name,
            points_selector=self._qm.PointIdsList(point_ids),
        )

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()
            self._client = None

    async def list_page_ids(self) -> set[str]:
        await self._ensure_connected()
        ids: set[str] = set()
        offset: int | None = None
        while True:
            page = await self._client.scroll(
                collection_name=self._collection_name,
                limit=1000, offset=offset,
                with_payload=True, with_vectors=False,
            )
            for point in page[0]:
                pid = (point.payload or {}).get("page_id")
                if pid:
                    ids.add(str(pid))
            offset = page[1]
            if offset is None:
                break
        return ids

    async def get_page_summary_by_path(self, path: str) -> dict | None:
        await self._ensure_connected()
        sf = self._qm.Filter(
            must=[self._qm.FieldCondition(key="target_path", match=self._qm.MatchValue(value=path))]
        )
        page = await self._client.scroll(
            collection_name=self._collection_name,
            limit=1, scroll_filter=sf,
            with_payload=True, with_vectors=False,
        )
        if not page[0]:
            return None
        payload = page[0][0].payload or {}
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
