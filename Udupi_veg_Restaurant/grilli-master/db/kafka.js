const { Kafka } = require("kafkajs");

const kafka = new Kafka({
  clientId: "restaurant-app",
  brokers: [process.env.KAFKA_BROKER || "my-cluster-kafka-bootstrap.kafka.svc.cluster.local:9092"],
  retry: {
    initialRetryTime: 300,
    retries: 10
  }
});

const producer = kafka.producer({
  allowAutoTopicCreation: false,
  transactionTimeout: 30000
});

const consumer = kafka.consumer({
  groupId: "restaurant-app-state",
  sessionTimeout: 30000,
  heartbeatInterval: 3000
});

let isConnected = false;

// ═══════════════════════════════════════════════════════════════
// IN-MEMORY MATERIALIZED STATE
// Consumers rebuild these maps from Kafka topic replay on startup.
// Compacted topics ensure only the latest event per key is stored.
// ═══════════════════════════════════════════════════════════════

const state = {
  orders: new Map(),        // orderId -> order object
  ordersByCustomer: new Map(), // customerId -> [orderId, ...]
  customers: new Map(),     // phone -> customer object
  customersById: new Map(), // id -> customer object
  menuCategories: [],
  menuItems: []
};

// ═══════════════════════════════════════════════════════════════
// CONSUMER — Replay topics to hydrate in-memory state
// ═══════════════════════════════════════════════════════════════

async function startConsumer() {
  await consumer.connect();

  await consumer.subscribe({
    topics: [
      "restaurant.orders",
      "restaurant.order-status",
      "restaurant.customers",
      "restaurant.menu"
    ],
    fromBeginning: true  // Replay all history on startup to rebuild state
  });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      if (!message.value) return;

      let payload;
      try {
        payload = JSON.parse(message.value.toString());
      } catch {
        return;
      }

      if (topic === "restaurant.orders") {
        applyOrderEvent(payload);
      } else if (topic === "restaurant.order-status") {
        applyOrderStatusEvent(payload);
      } else if (topic === "restaurant.customers") {
        applyCustomerEvent(payload);
      } else if (topic === "restaurant.menu") {
        applyMenuEvent(payload);
      }
    }
  });

  console.log("✅ Kafka consumer started — replaying topics to build state...");
}

function applyOrderEvent(payload) {
  const { event, data } = payload;

  if (event === "ORDER_CREATED") {
    state.orders.set(data.orderId, {
      order_id: data.orderId,
      customer_id: data.customerId || null,
      table_number: data.tableNumber,
      customer_name: data.customerName,
      total_amount: data.totalAmount,
      items: data.items,
      status: "NEW",
      created_at: data.timestamp,
      updated_at: data.timestamp
    });

    if (data.customerId) {
      const list = state.ordersByCustomer.get(String(data.customerId)) || [];
      if (!list.includes(data.orderId)) list.push(data.orderId);
      state.ordersByCustomer.set(String(data.customerId), list);
    }
  }
}

function applyOrderStatusEvent(payload) {
  const { event, data } = payload;

  if (event === "ORDER_STATUS_CHANGED") {
    const order = state.orders.get(data.orderId);
    if (order) {
      order.status = data.status;
      order.updated_at = data.timestamp;
    }
  }
}

function applyCustomerEvent(payload) {
  const { event, data } = payload;

  if (event === "CUSTOMER_CREATED" || event === "CUSTOMER_UPDATED") {
    const existing = state.customers.get(data.phone) || {};
    const updated = { ...existing, ...data };
    state.customers.set(data.phone, updated);
    state.customersById.set(String(data.id), updated);
  }
}

function applyMenuEvent(payload) {
  const { event, data } = payload;

  if (event === "MENU_CATEGORY_UPSERTED") {
    const idx = state.menuCategories.findIndex(c => c.id === data.id);
    if (idx >= 0) state.menuCategories[idx] = data;
    else state.menuCategories.push(data);
    state.menuCategories.sort((a, b) => a.display_order - b.display_order);
  } else if (event === "MENU_ITEM_UPSERTED") {
    const idx = state.menuItems.findIndex(i => i.id === data.id);
    if (idx >= 0) state.menuItems[idx] = data;
    else state.menuItems.push(data);
  }
}

// ═══════════════════════════════════════════════════════════════
// CONNECTION
// ═══════════════════════════════════════════════════════════════

async function connect() {
  try {
    await producer.connect();
    console.log("✅ Kafka producer connected");
    await startConsumer();
    isConnected = true;
  } catch (err) {
    console.error("❌ Kafka connection failed:", err.message);
    isConnected = false;
  }
}

async function disconnect() {
  await producer.disconnect();
  await consumer.disconnect();
  isConnected = false;
  console.log("Kafka disconnected");
}

function isReady() {
  return isConnected;
}

async function autoCompleteOrders(minutes = 2) {
  // Handled by stream consumer — status events drive completion
  return [];
}

// ═══════════════════════════════════════════════════════════════
// CUSTOMERS
// ═══════════════════════════════════════════════════════════════

async function createCustomer(customer) {
  // Hash password before storing — bcrypt is available
  const bcrypt = require("bcrypt");
  const hashedPassword = await bcrypt.hash(customer.password, 10);

  const id = Date.now();
  const record = {
    id,
    phone: customer.phone,
    name: customer.name || null,
    email: customer.email || null,
    password: hashedPassword,
    address: customer.address || null,
    city: customer.city || null,
    loyalty_points: 0,
    created_at: new Date().toISOString()
  };

  await producer.send({
    topic: "restaurant.customers",
    messages: [{
      key: customer.phone,
      value: JSON.stringify({
        event: "CUSTOMER_CREATED",
        data: record,
        timestamp: record.created_at
      })
    }]
  });

  // Optimistically update local state immediately
  const { password: _, ...safeRecord } = record;
  state.customers.set(customer.phone, record);
  state.customersById.set(String(id), record);

  return safeRecord;
}

async function loginCustomer(phone, password) {
  const bcrypt = require("bcrypt");
  const customer = state.customers.get(phone);

  if (!customer) return null;

  const valid = await bcrypt.compare(password, customer.password);
  if (!valid) return null;

  const { password: _, ...safe } = customer;
  return safe;
}

async function getCustomerById(id) {
  const customer = state.customersById.get(String(id));
  if (!customer) return null;
  const { password: _, ...safe } = customer;
  return safe;
}

async function updateCustomer(id, updates) {
  const existing = state.customersById.get(String(id));
  if (!existing) throw new Error("Customer not found");

  const updated = {
    ...existing,
    name: updates.name ?? existing.name,
    email: updates.email ?? existing.email,
    address: updates.address ?? existing.address,
    city: updates.city ?? existing.city,
    updated_at: new Date().toISOString()
  };

  await producer.send({
    topic: "restaurant.customers",
    messages: [{
      key: existing.phone,
      value: JSON.stringify({
        event: "CUSTOMER_UPDATED",
        data: updated,
        timestamp: updated.updated_at
      })
    }]
  });

  state.customers.set(existing.phone, updated);
  state.customersById.set(String(id), updated);

  const { password: _, ...safe } = updated;
  return safe;
}

async function addLoyaltyPoints(customerId, points) {
  const existing = state.customersById.get(String(customerId));
  if (!existing) return;

  const updated = {
    ...existing,
    loyalty_points: (existing.loyalty_points || 0) + points,
    updated_at: new Date().toISOString()
  };

  await producer.send({
    topic: "restaurant.customers",
    messages: [{
      key: existing.phone,
      value: JSON.stringify({
        event: "CUSTOMER_UPDATED",
        data: updated,
        timestamp: updated.updated_at
      })
    }]
  });

  state.customers.set(existing.phone, updated);
  state.customersById.set(String(customerId), updated);
}

// ═══════════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════════

async function saveOrder(order) {
  const timestamp = new Date().toISOString();
  const record = {
    orderId: order.orderId,
    customerId: order.customerId || null,
    tableNumber: order.tableNumber,
    customerName: order.customerName,
    totalAmount: order.totalAmount,
    items: order.items,
    status: "NEW",
    timestamp
  };

  await producer.send({
    topic: "restaurant.orders",
    messages: [{
      key: order.orderId,
      value: JSON.stringify({
        event: "ORDER_CREATED",
        data: record,
        timestamp
      })
    }]
  });

  // Optimistically apply to local state
  applyOrderEvent({ event: "ORDER_CREATED", data: record });

  // Add loyalty points for logged-in customers
  if (order.customerId) {
    const points = Math.floor(order.totalAmount / 10);
    if (points > 0) {
      await addLoyaltyPoints(order.customerId, points);
    }
  }

  console.log("📨 Order published to Kafka:", order.orderId);
  return { orderId: order.orderId };
}

async function getOrderStatus(orderId) {
  const order = state.orders.get(orderId);
  if (!order) return null;
  return {
    order_id: order.order_id,
    status: order.status,
    total_amount: order.total_amount,
    table_number: order.table_number,
    customer_name: order.customer_name,
    created_at: order.created_at,
    updated_at: order.updated_at
  };
}

async function getOrderById(id) {
  for (const order of state.orders.values()) {
    if (String(order.id) === String(id)) return order;
  }
  return null;
}

async function getPendingOrders() {
  const ACTIVE = new Set(["NEW", "CONFIRMED", "PREPARING", "READY"]);
  return Array.from(state.orders.values())
    .filter(o => ACTIVE.has(o.status))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

async function updateOrderStatus(orderId, status) {
  const timestamp = new Date().toISOString();

  await producer.send({
    topic: "restaurant.order-status",
    messages: [{
      key: orderId,
      value: JSON.stringify({
        event: "ORDER_STATUS_CHANGED",
        data: { orderId, status, timestamp },
        timestamp
      })
    }]
  });

  // Optimistically apply to local state
  applyOrderStatusEvent({
    event: "ORDER_STATUS_CHANGED",
    data: { orderId, status, timestamp }
  });
}

async function getCustomerOrders(customerId) {
  const orderIds = state.ordersByCustomer.get(String(customerId)) || [];
  return orderIds
    .map(id => state.orders.get(id))
    .filter(Boolean)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

// ═══════════════════════════════════════════════════════════════
// MENU (seeded from Kafka on startup; fallback to static data)
// ═══════════════════════════════════════════════════════════════

const STATIC_CATEGORIES = [
  { id: 1, name: "Starters", display_order: 1 },
  { id: 2, name: "Dosa", display_order: 2 },
  { id: 3, name: "Breakfast", display_order: 3 },
  { id: 4, name: "Dinner", display_order: 4 },
  { id: 5, name: "Beverages", display_order: 5 }
];

const STATIC_ITEMS = [
  { id: 1, category_id: 1, name: "Gobi Manchurian", price: 120, is_available: true },
  { id: 2, category_id: 1, name: "Paneer Tikka", price: 160, is_available: true },
  { id: 3, category_id: 2, name: "Plain Dosa", price: 60, is_available: true },
  { id: 4, category_id: 2, name: "Masala Dosa", price: 80, is_available: true },
  { id: 5, category_id: 3, name: "Idli (2 pcs)", price: 40, is_available: true },
  { id: 6, category_id: 3, name: "Vada (2 pcs)", price: 50, is_available: true },
  { id: 7, category_id: 4, name: "Veg Fried Rice", price: 140, is_available: true },
  { id: 8, category_id: 4, name: "Paneer Butter Masala", price: 180, is_available: true },
  { id: 9, category_id: 5, name: "Filter Coffee", price: 30, is_available: true },
  { id: 10, category_id: 5, name: "Masala Tea", price: 25, is_available: true }
];

async function getMenuCategories() {
  return state.menuCategories.length > 0 ? state.menuCategories : STATIC_CATEGORIES;
}

async function getMenuItems(categoryId = null) {
  const items = state.menuItems.length > 0 ? state.menuItems : STATIC_ITEMS;
  if (categoryId) return items.filter(i => i.category_id === categoryId && i.is_available !== false);
  return items.filter(i => i.is_available !== false);
}

async function getFullMenu() {
  const categories = await getMenuCategories();
  const items = await getMenuItems();
  return categories.map(cat => ({
    ...cat,
    items: items.filter(item => item.category_id === cat.id)
  }));
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

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
