"""
consumer.py — Kafka Consumer Service (port 8002)

Subscribes to all restaurant Kafka topics from the beginning on startup,
replays every event to rebuild in-memory state, then serves read queries
via HTTP.

Run:
    KAFKA_BROKER=localhost:9092 uvicorn consumer:app --port 8002
"""

import os
import json
import threading
from datetime import datetime
from confluent_kafka import Consumer, KafkaError
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from typing import Optional

# ── Config ─────────────────────────────────────────────────────────────────────

KAFKA_BROKER   = os.getenv("KAFKA_BROKER", "localhost:9092")
CONSUMER_GROUP = "restaurant-python-consumer"

TOPICS = [
    "restaurant.orders",
    "restaurant.order-status",
    "restaurant.customers",
    "restaurant.menu",
]

# ── In-Memory State ────────────────────────────────────────────────────────────

state = {
    "orders":             {},   # orderId -> order dict
    "orders_by_customer": {},   # customerId -> [orderId, ...]
    "customers":          {},   # phone -> customer dict
    "customers_by_id":    {},   # id -> customer dict
    "menu_categories":    [],
    "menu_items":         [],
}

_ready = False   # True once initial topic replay is complete
_lock  = threading.Lock()

# ── Static fallback menu (used when restaurant.menu topic is empty) ────────────

STATIC_CATEGORIES = [
    {"id": 1, "name": "Starters",   "display_order": 1},
    {"id": 2, "name": "Dosa",       "display_order": 2},
    {"id": 3, "name": "Breakfast",  "display_order": 3},
    {"id": 4, "name": "Dinner",     "display_order": 4},
    {"id": 5, "name": "Beverages",  "display_order": 5},
]

STATIC_ITEMS = [
    {"id": 1,  "category_id": 1, "name": "Gobi Manchurian",       "price": 120, "is_available": True},
    {"id": 2,  "category_id": 1, "name": "Paneer Tikka",           "price": 160, "is_available": True},
    {"id": 3,  "category_id": 2, "name": "Plain Dosa",             "price": 60,  "is_available": True},
    {"id": 4,  "category_id": 2, "name": "Masala Dosa",            "price": 80,  "is_available": True},
    {"id": 5,  "category_id": 3, "name": "Idli (2 pcs)",           "price": 40,  "is_available": True},
    {"id": 6,  "category_id": 3, "name": "Vada (2 pcs)",           "price": 50,  "is_available": True},
    {"id": 7,  "category_id": 4, "name": "Veg Fried Rice",         "price": 140, "is_available": True},
    {"id": 8,  "category_id": 4, "name": "Paneer Butter Masala",   "price": 180, "is_available": True},
    {"id": 9,  "category_id": 5, "name": "Filter Coffee",          "price": 30,  "is_available": True},
    {"id": 10, "category_id": 5, "name": "Masala Tea",             "price": 25,  "is_available": True},
]

# ── Event Handlers ─────────────────────────────────────────────────────────────

def apply_order_event(event: str, data: dict):
    if event == "ORDER_CREATED":
        order = {
            "order_id":     data["orderId"],
            "customer_id":  data.get("customerId"),
            "table_number": data.get("tableNumber"),
            "customer_name":data.get("customerName"),
            "total_amount": data.get("totalAmount"),
            "items":        data.get("items", []),
            "status":       "NEW",
            "created_at":   data.get("timestamp"),
            "updated_at":   data.get("timestamp"),
        }
        state["orders"][data["orderId"]] = order
        cid = str(data.get("customerId") or "")
        if cid:
            lst = state["orders_by_customer"].setdefault(cid, [])
            if data["orderId"] not in lst:
                lst.append(data["orderId"])


def apply_order_status_event(event: str, data: dict):
    if event == "ORDER_STATUS_CHANGED":
        order = state["orders"].get(data["orderId"])
        if order:
            order["status"]     = data["status"]
            order["updated_at"] = data.get("timestamp")


def apply_customer_event(event: str, data: dict):
    if event in ("CUSTOMER_CREATED", "CUSTOMER_UPDATED"):
        phone = data.get("phone")
        cid   = str(data.get("id", ""))
        existing = state["customers"].get(phone, {})
        merged   = {**existing, **data}
        if phone:
            state["customers"][phone]         = merged
        if cid:
            state["customers_by_id"][cid]     = merged


def apply_menu_event(event: str, data: dict):
    if event == "MENU_CATEGORY_UPSERTED":
        cats = state["menu_categories"]
        idx  = next((i for i, c in enumerate(cats) if c["id"] == data["id"]), -1)
        if idx >= 0:
            cats[idx] = data
        else:
            cats.append(data)
        state["menu_categories"] = sorted(cats, key=lambda c: c.get("display_order", 0))

    elif event == "MENU_ITEM_UPSERTED":
        items = state["menu_items"]
        idx   = next((i for i, it in enumerate(items) if it["id"] == data["id"]), -1)
        if idx >= 0:
            items[idx] = data
        else:
            items.append(data)


# ── Consumer Loop (runs in background thread) ──────────────────────────────────

def run_consumer():
    global _ready

    c = Consumer({
        "bootstrap.servers":  KAFKA_BROKER,
        "group.id":           CONSUMER_GROUP,
        "auto.offset.reset":  "earliest",
        "enable.auto.commit": True,
    })
    c.subscribe(TOPICS)

    # Track which topics have been fully caught up (reached EOF)
    eofs_seen = set()
    print(f"[consumer] Subscribed to {TOPICS} — replaying from beginning...")

    try:
        while True:
            msg = c.poll(timeout=1.0)

            if msg is None:
                # No new messages — check if we have seen EOF on all topic-partitions
                if not _ready and len(eofs_seen) >= len(TOPICS):
                    _ready = True
                    print("[consumer] Initial replay complete — ready to serve reads")
                continue

            if msg.error():
                if msg.error().code() == KafkaError._PARTITION_EOF:
                    eofs_seen.add(msg.topic())
                    if not _ready and len(eofs_seen) >= len(TOPICS):
                        _ready = True
                        print("[consumer] Initial replay complete — ready to serve reads")
                else:
                    print(f"[consumer] Error: {msg.error()}")
                continue

            try:
                payload = json.loads(msg.value().decode("utf-8"))
            except Exception:
                continue

            event = payload.get("event", "")
            data  = payload.get("data", {})

            with _lock:
                topic = msg.topic()
                if topic == "restaurant.orders":
                    apply_order_event(event, data)
                elif topic == "restaurant.order-status":
                    apply_order_status_event(event, data)
                elif topic == "restaurant.customers":
                    apply_customer_event(event, data)
                elif topic == "restaurant.menu":
                    apply_menu_event(event, data)

    finally:
        c.close()


# Start consumer thread on import
_thread = threading.Thread(target=run_consumer, daemon=True)
_thread.start()

# ── FastAPI App ────────────────────────────────────────────────────────────────

app = FastAPI(title="Restaurant Kafka Consumer", version="1.0.0")

def safe_state(fn):
    """Run fn under the state lock and return result."""
    with _lock:
        return fn()

# ── Health ─────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"ready": _ready, "service": "consumer"}

# ── Customer Read Endpoints ────────────────────────────────────────────────────

@app.get("/customers/phone/{phone}")
def get_customer_by_phone(phone: str):
    """Return customer including hashed password (for login verification in kafka.js)."""
    customer = safe_state(lambda: state["customers"].get(phone))
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    return customer


@app.get("/customers/{customer_id}")
def get_customer_by_id(customer_id: str):
    customer = safe_state(lambda: state["customers_by_id"].get(str(customer_id)))
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    return {k: v for k, v in customer.items() if k != "password"}


@app.get("/customers/{customer_id}/orders")
def get_customer_orders(customer_id: str):
    def _get():
        order_ids = state["orders_by_customer"].get(str(customer_id), [])
        orders    = [state["orders"][oid] for oid in order_ids if oid in state["orders"]]
        return sorted(orders, key=lambda o: o.get("created_at", ""), reverse=True)
    return safe_state(_get)

# ── Order Read Endpoints ───────────────────────────────────────────────────────

@app.get("/orders/pending")
def get_pending_orders():
    ACTIVE = {"NEW", "CONFIRMED", "PREPARING", "READY"}
    def _get():
        pending = [o for o in state["orders"].values() if o.get("status") in ACTIVE]
        return sorted(pending, key=lambda o: o.get("created_at", ""))
    return safe_state(_get)


@app.get("/orders/{order_id}/status")
def get_order_status(order_id: str):
    order = safe_state(lambda: state["orders"].get(order_id))
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    return {
        "order_id":     order["order_id"],
        "status":       order["status"],
        "total_amount": order["total_amount"],
        "table_number": order["table_number"],
        "customer_name":order["customer_name"],
        "created_at":   order["created_at"],
        "updated_at":   order["updated_at"],
    }


@app.get("/orders/{order_id}")
def get_order_by_id(order_id: str):
    order = safe_state(lambda: state["orders"].get(order_id))
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    return order

# ── Menu Read Endpoints ────────────────────────────────────────────────────────

@app.get("/menu/categories")
def get_menu_categories():
    cats = safe_state(lambda: list(state["menu_categories"]))
    return cats if cats else STATIC_CATEGORIES


@app.get("/menu/items")
def get_menu_items(category_id: Optional[int] = None):
    items = safe_state(lambda: list(state["menu_items"]))
    if not items:
        items = STATIC_ITEMS
    items = [i for i in items if i.get("is_available") is not False]
    if category_id is not None:
        items = [i for i in items if i.get("category_id") == category_id]
    return items


@app.get("/menu")
def get_full_menu():
    categories = get_menu_categories()
    items      = get_menu_items()
    return [
        {**cat, "items": [i for i in items if i.get("category_id") == cat["id"]]}
        for cat in categories
    ]
