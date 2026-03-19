kconst { Kafka } = require("kafkajs");

const kafka = new Kafka({
  clientId: "restaurant-app",
  brokers: [process.env.KAFKA_BROKER || "localhost:9092"]
});

const producer = kafka.producer();
let isConnected = false;

// ═══════════════════════════════════════════════════════════════
// CONNECTION
// ═══════════════════════════════════════════════════════════════

async function connect() {
  try {
    await producer.connect();
    isConnected = true;
    console.log("✅ Kafka connected");
  } catch (err) {
    console.error("❌ Kafka connection failed:", err.message);
  }
}

async function disconnect() {
  await producer.disconnect();
  isConnected = false;
  console.log("Kafka disconnected");
}

function isReady() {
  return isConnected;
}

async function autoCompleteOrders(minutes = 2) {
  // Kafka doesn't auto-complete - handled by stream processor
  return [];
}


// ═══════════════════════════════════════════════════════════════
// CUSTOMERS (Kafka + external store needed)
// ═══════════════════════════════════════════════════════════════

async function createCustomer(customer) {
  // With Kafka, you'd publish to a topic and have a consumer write to a DB
  await producer.send({
    topic: "customer-events",
    messages: [{
      key: customer.phone,
      value: JSON.stringify({ event: "CUSTOMER_CREATED", data: customer, timestamp: new Date().toISOString() })
    }]
  });
  // Return mock - in production, read from materialized view/cache
  return { id: Date.now(), ...customer };
}

async function loginCustomer(phone, password) {
  // Kafka is not queryable - need external store (Redis/PostgreSQL) for reads
  throw new Error("Login requires a queryable store. Use PostgreSQL adapter or add Redis.");
}

async function getCustomerById(id) {
  throw new Error("Queries require a queryable store. Use PostgreSQL adapter or add Redis.");
}

async function updateCustomer(id, updates) {
  await producer.send({
    topic: "customer-events",
    messages: [{
      key: String(id),
      value: JSON.stringify({ event: "CUSTOMER_UPDATED", data: { id, ...updates }, timestamp: new Date().toISOString() })
    }]
  });
  return { id, ...updates };
}

async function addLoyaltyPoints(customerId, points) {
  await producer.send({
    topic: "loyalty-events",
    messages: [{
      key: String(customerId),
      value: JSON.stringify({ event: "POINTS_ADDED", customerId, points, timestamp: new Date().toISOString() })
    }]
  });
}

// ═══════════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════════

async function saveOrder(order) {
  await producer.send({
    topic: "restaurant-orders",
    messages: [{
      key: order.orderId,
      value: JSON.stringify({
        ...order,
        event: "ORDER_CREATED",
        timestamp: new Date().toISOString()
      })
    }]
  });
  console.log("📨 Order sent to Kafka:", order.orderId);
  return { orderId: order.orderId };
}

async function getOrderStatus(orderId) {
  // Need external store for queries
  throw new Error("Queries require a queryable store. Use PostgreSQL adapter or add Redis.");
}

async function getOrderById(id) {
  throw new Error("Queries require a queryable store. Use PostgreSQL adapter or add Redis.");
}

async function getPendingOrders() {
  // Need external store for queries
  throw new Error("Queries require a queryable store. Use PostgreSQL adapter or add Redis.");
}

async function updateOrderStatus(orderId, status) {
  await producer.send({
    topic: "order-status-updates",
    messages: [{
      key: String(orderId),
      value: JSON.stringify({
        event: "ORDER_STATUS_CHANGED",
        orderId,
        status,
        timestamp: new Date().toISOString()
      })
    }]
  });
}

async function getCustomerOrders(customerId) {
  throw new Error("Queries require a queryable store. Use PostgreSQL adapter or add Redis.");
}

// ═══════════════════════════════════════════════════════════════
// MENU (Usually static, can be cached or fetched from separate DB)
// ═══════════════════════════════════════════════════════════════

async function getMenuCategories() {
  // Return static menu or fetch from cache
  return [
    { id: 1, name: "Starters", display_order: 1 },
    { id: 2, name: "Dosa", display_order: 2 },
    { id: 3, name: "Breakfast", display_order: 3 },
    { id: 4, name: "Dinner", display_order: 4 },
    { id: 5, name: "Beverages", display_order: 5 }
  ];
}

async function getMenuItems(categoryId = null) {
  // Return static menu
  const items = [
    { id: 1, category_id: 1, name: "Gobi Manchurian", price: 120 },
    { id: 2, category_id: 1, name: "Paneer Tikka", price: 160 },
    { id: 3, category_id: 2, name: "Plain Dosa", price: 60 },
    { id: 4, category_id: 2, name: "Masala Dosa", price: 80 },
    { id: 5, category_id: 3, name: "Idli (2 pcs)", price: 40 },
    { id: 6, category_id: 3, name: "Vada (2 pcs)", price: 50 },
    { id: 7, category_id: 4, name: "Veg Fried Rice", price: 140 },
    { id: 8, category_id: 4, name: "Paneer Butter Masala", price: 180 },
    { id: 9, category_id: 5, name: "Filter Coffee", price: 30 },
    { id: 10, category_id: 5, name: "Masala Tea", price: 25 }
  ];

  if (categoryId) {
    return items.filter(i => i.category_id === categoryId);
  }
  return items;
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
  // Connection
  connect,
  disconnect,
  isReady,

  // Customers
  createCustomer,
  loginCustomer,
  getCustomerById,
  updateCustomer,
  addLoyaltyPoints,

  // Orders
  saveOrder,
  getOrderStatus,
  getOrderById,
  getPendingOrders,
  updateOrderStatus,
  getCustomerOrders,
  autoCompleteOrders,

  // Menu
  getMenuCategories,
  getMenuItems,
  getFullMenu
};
