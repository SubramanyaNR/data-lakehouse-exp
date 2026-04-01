"""
producer.py — Kafka Producer Service (port 8001)

Accepts HTTP calls from db/kafka.js and publishes events to Kafka topics.
Handles all write operations: customers, orders, order-status.

Run:
    KAFKA_BROKER=localhost:9092 uvicorn producer:app --port 8001
"""

import os
import json
import time
import bcrypt
from datetime import datetime, timezone
from confluent_kafka import Producer
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, List

# ── Config ─────────────────────────────────────────────────────────────────────

KAFKA_BROKER = os.getenv("KAFKA_BROKER", "localhost:9092")

TOPIC_CUSTOMERS   = "restaurant.customers"
TOPIC_ORDERS      = "restaurant.orders"
TOPIC_ORDER_STATUS = "restaurant.order-status"

# ── Kafka Producer ─────────────────────────────────────────────────────────────

producer = Producer({
    "bootstrap.servers": KAFKA_BROKER,
    "acks": "all",
    "retries": 5,
    "retry.backoff.ms": 300,
})

def publish(topic: str, key: str, event: str, data: dict):
    """Publish a single event envelope to a Kafka topic."""
    message = {
        "event": event,
        "data": data,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    producer.produce(
        topic=topic,
        key=key.encode("utf-8"),
        value=json.dumps(message).encode("utf-8"),
    )
    producer.flush()

# ── FastAPI App ────────────────────────────────────────────────────────────────

app = FastAPI(title="Restaurant Kafka Producer", version="1.0.0")

# ── Request Models ─────────────────────────────────────────────────────────────

class CreateCustomerRequest(BaseModel):
    phone: str
    name: Optional[str] = None
    email: Optional[str] = None
    password: str
    address: Optional[str] = None
    city: Optional[str] = None

class UpdateCustomerRequest(BaseModel):
    id: str
    phone: str
    name: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    loyalty_points: Optional[int] = 0
    password: Optional[str] = None
    created_at: Optional[str] = None

class AddLoyaltyRequest(BaseModel):
    phone: str
    loyalty_points: int

class OrderItem(BaseModel):
    name: str
    price: float
    qty: int

class CreateOrderRequest(BaseModel):
    orderId: str
    customerId: Optional[str] = None
    tableNumber: Optional[int] = None
    customerName: Optional[str] = None
    totalAmount: float
    items: List[OrderItem]

class UpdateOrderStatusRequest(BaseModel):
    status: str

# ── Customer Endpoints ─────────────────────────────────────────────────────────

@app.post("/customers", status_code=201)
def create_customer(req: CreateCustomerRequest):
    """Hash password and publish CUSTOMER_CREATED event."""
    hashed = bcrypt.hashpw(req.password.encode("utf-8"), bcrypt.gensalt(rounds=10)).decode("utf-8")
    record = {
        "id": str(int(time.time() * 1000)),
        "phone": req.phone,
        "name": req.name,
        "email": req.email,
        "password": hashed,
        "address": req.address,
        "city": req.city,
        "loyalty_points": 0,
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    publish(TOPIC_CUSTOMERS, req.phone, "CUSTOMER_CREATED", record)
    safe = {k: v for k, v in record.items() if k != "password"}
    return safe


@app.put("/customers/{customer_id}")
def update_customer(customer_id: str, req: UpdateCustomerRequest):
    """Publish CUSTOMER_UPDATED event with merged fields."""
    updated = req.model_dump()
    updated["updated_at"] = datetime.now(timezone.utc).isoformat()
    publish(TOPIC_CUSTOMERS, req.phone, "CUSTOMER_UPDATED", updated)
    safe = {k: v for k, v in updated.items() if k != "password"}
    return safe


@app.post("/customers/{customer_id}/loyalty")
def add_loyalty(customer_id: str, req: AddLoyaltyRequest):
    """Publish CUSTOMER_UPDATED event with new loyalty_points total."""
    data = {
        "id": customer_id,
        "phone": req.phone,
        "loyalty_points": req.loyalty_points,
        "updated_at": datetime.now(timezone.utc).isoformat()
    }
    publish(TOPIC_CUSTOMERS, req.phone, "CUSTOMER_UPDATED", data)
    return {"loyalty_points": req.loyalty_points}

# ── Order Endpoints ────────────────────────────────────────────────────────────

@app.post("/orders", status_code=201)
def create_order(req: CreateOrderRequest):
    """Publish ORDER_CREATED event."""
    ts = datetime.now(timezone.utc).isoformat()
    data = {
        "orderId":      req.orderId,
        "customerId":   req.customerId,
        "tableNumber":  req.tableNumber,
        "customerName": req.customerName,
        "totalAmount":  req.totalAmount,
        "items":        [i.model_dump() for i in req.items],
        "status":       "NEW",
        "timestamp":    ts
    }
    publish(TOPIC_ORDERS, req.orderId, "ORDER_CREATED", data)
    return {"orderId": req.orderId}


@app.post("/orders/{order_id}/status")
def update_order_status(order_id: str, req: UpdateOrderStatusRequest):
    """Publish ORDER_STATUS_CHANGED event."""
    ts = datetime.now(timezone.utc).isoformat()
    data = {"orderId": order_id, "status": req.status, "timestamp": ts}
    publish(TOPIC_ORDER_STATUS, order_id, "ORDER_STATUS_CHANGED", data)
    return {"orderId": order_id, "status": req.status}

# ── Health ─────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"ready": True, "service": "producer"}
