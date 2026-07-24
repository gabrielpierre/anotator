"""add frame workflow states

Revision ID: 0002_frame_workflow_states
Revises: 0001_initial_schema
Create Date: 2026-07-23 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "0002_frame_workflow_states"
down_revision = "0001_initial_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "frame_workflow_states",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("task_external_id", sa.String(length=64), nullable=False),
        sa.Column("frame", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("annotation_count", sa.Integer(), nullable=False),
        sa.Column("assigned_user_id", sa.String(length=36), nullable=True),
        sa.Column("submitted_by", sa.String(length=255), nullable=True),
        sa.Column("reviewed_by", sa.String(length=255), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("raw", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("task_external_id", "frame", name="uq_frame_workflow_states_task_frame"),
    )
    op.create_index("ix_frame_workflow_states_task_external_id", "frame_workflow_states", ["task_external_id"])
    op.create_index("ix_frame_workflow_states_frame", "frame_workflow_states", ["frame"])
    op.create_index("ix_frame_workflow_states_status", "frame_workflow_states", ["status"])
    op.create_index("ix_frame_workflow_states_assigned_user_id", "frame_workflow_states", ["assigned_user_id"])


def downgrade() -> None:
    op.drop_index("ix_frame_workflow_states_assigned_user_id", table_name="frame_workflow_states")
    op.drop_index("ix_frame_workflow_states_status", table_name="frame_workflow_states")
    op.drop_index("ix_frame_workflow_states_frame", table_name="frame_workflow_states")
    op.drop_index("ix_frame_workflow_states_task_external_id", table_name="frame_workflow_states")
    op.drop_table("frame_workflow_states")
