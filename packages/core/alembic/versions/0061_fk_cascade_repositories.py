"""Ensure ON DELETE CASCADE on all child FKs referencing repositories.

SQLite stores managed by init_db never run Alembic, so their FK constraints
were baked in at CREATE TABLE time by the version of the ORM model that ran
first.  When a later release added ON DELETE CASCADE to a model, the SQLite
store kept the old RESTRICT/NO ACTION constraint — causing DELETE FROM
repositories to fail with FOREIGN KEY constraint failed.

This migration targets Postgres (the only backend that runs Alembic).  For
SQLite the fix lives in ``_reconcile_schema`` which now detects and rebuilds
tables with incorrect FK constraints on every ``init_db`` call.

Revision ID: 0061
Revises: 0060
Create Date: 2026-09-06
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers
revision: str = "0061"
down_revision: str | None = "0060"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# All child tables that have a FK → repositories.id.
# For each we drop the old FK constraint and add the CASCADE version.
# Postgres names FK constraints automatically if not named, so we use
# a heuristic: look up existing FK names via information_schema, then
# drop + re-add.

_CHILD_TABLES = [
    "generation_jobs",
    "wiki_pages",
    "wiki_page_versions",
    "wiki_symbols",
    "graph_nodes",
    "graph_edges",
    "graph_metrics",
    "graph_node_membership",
    "external_systems",
    "decision_records",
    "conversations",
    "llm_costs",
    "dead_code_findings",
    "health_findings",
    "health_file_metrics",
    "health_snapshots",
    "refactoring_suggestions",
    "refactoring_opportunities",
    "refactoring_summaries",
    "performance_opportunities",
    "performance_summaries",
    "coverage_files",
    "test_coverage",
    "answer_cache",
    "knowledge_graph_layers",
    "knowledge_graph_tour_steps",
    "kg_project_meta",
    "kg_node_meta",
    "pipeline_jobs",
    "webhook_events",
]


def upgrade() -> None:
    conn = op.get_bind()
    for table in _CHILD_TABLES:
        # Find existing FK constraints on this table that reference repositories
        rows = conn.execute(
            """
            SELECT tc.constraint_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
            JOIN information_schema.constraint_column_usage ccu
              ON tc.constraint_name = ccu.constraint_name
            WHERE tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_name = :tbl
              AND ccu.table_name = 'repositories'
            """,
            {"tbl": table},
        ).fetchall()

        for (conname,) in rows:
            op.drop_constraint(conname, table, type_="foreignkey")

        # Add the new FK with ON DELETE CASCADE
        op.create_table_comment(
            None, None, existing_table=table, comment=None
        ) if False else None  # no-op guard; just re-create FK:

        op.create_foreign_key(
            f"fk_{table}_repositories",
            table,
            "repositories",
            ["repository_id"],
            ["id"],
            ondelete="CASCADE",
        )


def downgrade() -> None:
    conn = op.get_bind()
    for table in _CHILD_TABLES:
        # Find and drop the CASCADE FKs we added
        rows = conn.execute(
            """
            SELECT tc.constraint_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.constraint_column_usage ccu
              ON tc.constraint_name = ccu.constraint_name
            WHERE tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_name = :tbl
              AND ccu.table_name = 'repositories'
            """,
            {"tbl": table},
        ).fetchall()

        for (conname,) in rows:
            op.drop_constraint(conname, table, type_="foreignkey")

        # Restore original: RESTRICT for most, SET NULL for webhook_events
        ondelete = "SET NULL" if table == "webhook_events" else "RESTRICT"
        nullable = table == "webhook_events"
        op.create_foreign_key(
            f"fk_{table}_repositories",
            table,
            "repositories",
            ["repository_id"],
            ["id"],
            ondelete=ondelete,
            nullable=nullable,
        )