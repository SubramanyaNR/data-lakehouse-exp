"use strict";

/**
 * db/kafka.js — Spawns Python Kafka producer & consumer services, then proxies
 * HTTP calls to them.
 *
 * Writes  → http://localhost:PRODUCER_PORT  (kafka/producer.py)
 * Reads   → http://localhost:CONSUMER_PORT  (kafka/consumer.py)
 *
 * Exports the same interface as db/postgres.js so server.js needs no changes.
 */

const http   = require("http");
const bcrypt = require("bcrypt");
const { spawn } = require("child_process");
const path   = require("path");

const PRODUCER_PORT = process.env.PRODUCER_PORT || 8001;
const CONSUMER_PORT = process.env.CONSUMER_PORT || 8002;
const PRODUCER = `http://localhost:${PRODUCER_PORT}`;
const CONSUMER = `http://localhost:${CONSUMER_PORT}`;
const KAFKA_DIR = path.join(__dirname, "../kafka");

let isConnected  = false;
let producerProc = null;
let consumerProc = null;

// ── Spawn helpers ─────────────────────────────────────────────────────────────

function spawnService(script, port) {
  const proc = spawn(
    "python3",
    ["-m", "uvicorn", `${script}:app`, "--port", String(port), "--log-level", "warning"],
    { cwd: KAFKA_DIR, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] }
  );
  proc.stdout.on("data", d => process.stdout.write(`[${script}] ${d}`));
  proc.stderr.on("data", d => process.stderr.write(`[${script}] ${d}`));
  proc.on("exit", code => { if (code !== null) console.log(`[${script}] exited (code ${code})`); });
  return proc;
}

// Kill child processes whenever Node exits (crash or Ctrl+C)
process.on("exit", () => {
  if (producerProc) producerProc.kill();
  if (consumerProc) consumerProc.kill();
});

// ── HTTP helper ───────────────────────────────────────────────────────────────

function request(base, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const url     = new URL(path, base);
    const options = {
      hostname: url.hostname,
      port:     url.port,
      path:     url.pathname + url.search,
      method,
      headers: { "Content-Type": "application/json" }
    };
    if (payload) options.headers["Content-Length"] = Buffer.byteLength(payload);

    const req = http.request(options, res => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} from ${method} ${path}: ${data}`));
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const get  = (base, path)         => request(base, "GET",  path, null);
const post = (base, path, body)   => request(base, "POST", path, body);
const put  = (base, path, body)   => request(base, "PUT",  path, body);

// ── Connection lifecycle ──────────────────────────────────────────────────────

async function connect() {
  console.log("⏳ Starting Python Kafka producer and consumer services...");
  producerProc = spawnService("producer", PRODUCER_PORT);
  consumerProc = spawnService("consumer", CONSUMER_PORT);

  // Poll until both services are up and consumer has finished replaying topics
  for (let i = 0; i < 60; i++) {
    try {
      const [p, c] = await Promise.all([
        get(PRODUCER, "/health"),
        get(CONSUMER, "/health")
      ]);
      if (p && c && c.ready) {
        isConnected = true;
        console.log("✅ Kafka producer service ready");
        console.log("✅ Kafka consumer service ready (state replayed)");
        return;
      }
    } catch (_) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.error("❌ Kafka services did not become ready in time");
}

async function disconnect() {
  if (producerProc) { producerProc.kill(); producerProc = null; }
  if (consumerProc) { consumerProc.kill(); consumerProc = null; }
  isConnected = false;
  console.log("Kafka services stopped");
}

function isReady() { return isConnected; }

// ── Customers ─────────────────────────────────────────────────────────────────

async function createCustomer(customer) {
  return post(PRODUCER, "/customers", customer);
}

async function loginCustomer(phone, password) {
  // Fetch the full record (includes hashed password) then verify locally
  const customer = await get(CONSUMER, `/customers/phone/${encodeURIComponent(phone)}`);
  if (!customer) return null;
  const valid = await bcrypt.compare(password, customer.password);
  if (!valid) return null;
  const { password: _, ...safe } = customer;
  return safe;
}

async function getCustomerById(id) {
  return get(CONSUMER, `/customers/${id}`);
}

async function updateCustomer(id, updates) {
  // Fetch current record so we can send the full merged object to the producer
  const existing = await get(CONSUMER, `/customers/${id}`);
  if (!existing) throw new Error("Customer not found");
  const merged = { ...existing, ...updates };
  return put(PRODUCER, `/customers/${id}`, merged);
}

async function addLoyaltyPoints(customerId, points) {
  const existing = await get(CONSUMER, `/customers/${customerId}`);
  if (!existing) return;
  const newPoints = (existing.loyalty_points || 0) + points;
  await post(PRODUCER, `/customers/${customerId}/loyalty`, {
    phone:          existing.phone,
    loyalty_points: newPoints
  });
}

// ── Orders ────────────────────────────────────────────────────────────────────

async function saveOrder(order) {
  const result = await post(PRODUCER, "/orders", order);

  // Add loyalty points for logged-in customers
  if (order.customerId) {
    const pts = Math.floor(order.totalAmount / 10);
    if (pts > 0) await addLoyaltyPoints(order.customerId, pts);
  }

  return result;
}

async function getOrderStatus(orderId) {
  return get(CONSUMER, `/orders/${encodeURIComponent(orderId)}/status`);
}

async function getOrderById(id) {
  return get(CONSUMER, `/orders/${encodeURIComponent(id)}`);
}

async function getPendingOrders() {
  return get(CONSUMER, "/orders/pending");
}

async function updateOrderStatus(orderId, status) {
  return post(PRODUCER, `/orders/${encodeURIComponent(orderId)}/status`, { status });
}

async function getCustomerOrders(customerId) {
  return get(CONSUMER, `/customers/${customerId}/orders`);
}

async function autoCompleteOrders() {
  return [];
}

// ── Menu ──────────────────────────────────────────────────────────────────────

async function getMenuCategories() {
  return get(CONSUMER, "/menu/categories");
}

async function getMenuItems(categoryId = null) {
  const path = categoryId ? `/menu/items?category_id=${categoryId}` : "/menu/items";
  return get(CONSUMER, path);
}

async function getFullMenu() {
  return get(CONSUMER, "/menu");
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  connect,
  disconnect,
  isReady,

  createCustomer,
  loginCustomer,
  getCustomerById,
  updateCustomer,
  addLoyaltyPoints,

  saveOrder,
  getOrderStatus,
  getOrderById,
  getPendingOrders,
  updateOrderStatus,
  getCustomerOrders,
  autoCompleteOrders,

  getMenuCategories,
  getMenuItems,
  getFullMenu
};
