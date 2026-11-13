"""Additive personal-intelligence APIs for Visionary Nexus.

All user-owned records are scoped to the authenticated account. Memory is only
saved when the user explicitly submits it. Reminder/workflow records are data
only; this module never executes arbitrary browser or device actions.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text
from sqlalchemy.orm import Session

try:
    from backend.database import Base, SessionLocal
    from backend.models import Device
except ImportError:  # pragma: no cover
    from database import Base, SessionLocal
    from models import Device

router = APIRouter(prefix="/api/assistant", tags=["personal intelligence"])


class NexusMemory(Base):
    __tablename__ = "nexus_memories"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String(64), nullable=False, index=True)
    content = Column(Text, nullable=False)
    category = Column(String(40), nullable=False, default="preference")
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class NexusReminder(Base):
    __tablename__ = "nexus_reminders"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String(64), nullable=False, index=True)
    title = Column(String(180), nullable=False)
    notes = Column(Text, nullable=True)
    due_at = Column(String(80), nullable=False)
    timezone_name = Column(String(80), nullable=False, default="Asia/Kolkata")
    completed = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class NexusWorkflow(Base):
    __tablename__ = "nexus_workflows"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String(64), nullable=False, index=True)
    name = Column(String(120), nullable=False)
    description = Column(Text, nullable=True)
    trigger_type = Column(String(30), nullable=False, default="manual")
    definition_json = Column(Text, nullable=False, default="{}")
    enabled = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class MemoryCreate(BaseModel):
    content: str = Field(min_length=1, max_length=1200)
    category: str = Field(default="preference", max_length=40)


class ReminderCreate(BaseModel):
    title: str = Field(min_length=1, max_length=180)
    notes: str = Field(default="", max_length=1000)
    due_at: str = Field(min_length=10, max_length=80)
    timezone_name: str = Field(default="Asia/Kolkata", max_length=80)


class ReminderUpdate(BaseModel):
    completed: bool


class WorkflowCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=1000)
    trigger_type: str = Field(default="manual", max_length=30)
    definition: dict[str, Any] = Field(default_factory=dict)


def _user_id(request: Request) -> str:
    user = getattr(request.state, "auth_user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Sign in to use personal intelligence.")
    return str(user.id)


def _memory_json(row: NexusMemory) -> dict[str, Any]:
    return {"id": row.id, "content": row.content, "category": row.category, "created_at": row.created_at.isoformat()}


def _reminder_json(row: NexusReminder) -> dict[str, Any]:
    return {"id": row.id, "title": row.title, "notes": row.notes or "", "due_at": row.due_at, "timezone": row.timezone_name, "completed": bool(row.completed), "created_at": row.created_at.isoformat()}


def _workflow_json(row: NexusWorkflow) -> dict[str, Any]:
    try:
        definition = json.loads(row.definition_json or "{}")
    except (TypeError, ValueError):
        definition = {}
    return {"id": row.id, "name": row.name, "description": row.description or "", "trigger_type": row.trigger_type, "definition": definition, "enabled": bool(row.enabled), "created_at": row.created_at.isoformat()}


@router.get("/memories")
def list_memories(request: Request):
    user_id = _user_id(request)
    db: Session = SessionLocal()
    try:
        rows = db.query(NexusMemory).filter_by(user_id=user_id).order_by(NexusMemory.created_at.desc()).all()
        return {"memories": [_memory_json(row) for row in rows]}
    finally:
        db.close()


@router.post("/memories")
def create_memory(payload: MemoryCreate, request: Request):
    user_id = _user_id(request)
    content = payload.content.strip()
    category = payload.category.strip().lower()
    if not content:
        raise HTTPException(status_code=422, detail="Memory cannot be empty.")
    if category not in {"preference", "project", "workflow", "other"}:
        category = "other"
    db: Session = SessionLocal()
    try:
        row = NexusMemory(user_id=user_id, content=content, category=category)
        db.add(row)
        db.commit()
        db.refresh(row)
        return {"memory": _memory_json(row)}
    finally:
        db.close()


@router.delete("/memories/{memory_id}")
def delete_memory(memory_id: int, request: Request):
    user_id = _user_id(request)
    db: Session = SessionLocal()
    try:
        row = db.query(NexusMemory).filter_by(id=memory_id, user_id=user_id).first()
        if not row:
            raise HTTPException(status_code=404, detail="Memory not found.")
        db.delete(row)
        db.commit()
        return {"deleted": True}
    finally:
        db.close()


@router.get("/reminders")
def list_reminders(request: Request):
    user_id = _user_id(request)
    db: Session = SessionLocal()
    try:
        rows = db.query(NexusReminder).filter_by(user_id=user_id).order_by(NexusReminder.due_at.asc()).all()
        return {"reminders": [_reminder_json(row) for row in rows]}
    finally:
        db.close()


@router.post("/reminders")
def create_reminder(payload: ReminderCreate, request: Request):
    user_id = _user_id(request)
    due_at = payload.due_at.strip()
    try:
        datetime.fromisoformat(due_at.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=422, detail="Use a valid ISO date/time for the reminder.")
    db: Session = SessionLocal()
    try:
        row = NexusReminder(user_id=user_id, title=payload.title.strip(), notes=payload.notes.strip(), due_at=due_at, timezone_name=payload.timezone_name.strip() or "UTC")
        db.add(row)
        db.commit()
        db.refresh(row)
        return {"reminder": _reminder_json(row)}
    finally:
        db.close()


@router.patch("/reminders/{reminder_id}")
def update_reminder(reminder_id: int, payload: ReminderUpdate, request: Request):
    user_id = _user_id(request)
    db: Session = SessionLocal()
    try:
        row = db.query(NexusReminder).filter_by(id=reminder_id, user_id=user_id).first()
        if not row:
            raise HTTPException(status_code=404, detail="Reminder not found.")
        row.completed = payload.completed
        db.commit()
        db.refresh(row)
        return {"reminder": _reminder_json(row)}
    finally:
        db.close()


@router.delete("/reminders/{reminder_id}")
def delete_reminder(reminder_id: int, request: Request):
    user_id = _user_id(request)
    db: Session = SessionLocal()
    try:
        row = db.query(NexusReminder).filter_by(id=reminder_id, user_id=user_id).first()
        if not row:
            raise HTTPException(status_code=404, detail="Reminder not found.")
        db.delete(row)
        db.commit()
        return {"deleted": True}
    finally:
        db.close()


@router.get("/workflows")
def list_workflows(request: Request):
    user_id = _user_id(request)
    db: Session = SessionLocal()
    try:
        rows = db.query(NexusWorkflow).filter_by(user_id=user_id).order_by(NexusWorkflow.created_at.desc()).all()
        return {"workflows": [_workflow_json(row) for row in rows]}
    finally:
        db.close()


@router.post("/workflows")
def create_workflow(payload: WorkflowCreate, request: Request):
    user_id = _user_id(request)
    trigger = payload.trigger_type.strip().lower()
    if trigger not in {"manual", "time", "phrase"}:
        raise HTTPException(status_code=422, detail="Trigger must be manual, time, or phrase.")
    # This is intentionally a saved draft: no workflow runner is enabled yet.
    definition = payload.definition
    if len(json.dumps(definition, ensure_ascii=False)) > 8000:
        raise HTTPException(status_code=413, detail="Workflow definition is too large.")
    db: Session = SessionLocal()
    try:
        row = NexusWorkflow(user_id=user_id, name=payload.name.strip(), description=payload.description.strip(), trigger_type=trigger, definition_json=json.dumps(definition, ensure_ascii=False), enabled=False)
        db.add(row)
        db.commit()
        db.refresh(row)
        return {"workflow": _workflow_json(row), "status": "draft"}
    finally:
        db.close()


@router.get("/device-health")
def device_health(request: Request):
    _user_id(request)
    db: Session = SessionLocal()
    try:
        rows = db.query(Device).order_by(Device.id.asc()).all()
        now = datetime.utcnow()
        devices = []
        for row in rows:
            heartbeat_age = int((now - row.last_heartbeat_at).total_seconds()) if row.last_heartbeat_at else None
            devices.append({
                "device_id": row.device_id,
                "name": row.name,
                "model": row.model,
                "status": row.status,
                "online": row.status == "online",
                "battery": row.battery,
                "temperature": row.temperature,
                "rssi": row.rssi,
                "camera_ready": bool(row.camera_ready),
                "camera_sensor": row.camera_sensor,
                "heartbeat_age_seconds": heartbeat_age,
                "last_seen_at": row.last_seen_at.isoformat() if row.last_seen_at else None,
                "firmware": row.firmware,
            })
        return {"devices": devices, "checked_at": now.replace(tzinfo=timezone.utc).isoformat()}
    finally:
        db.close()
