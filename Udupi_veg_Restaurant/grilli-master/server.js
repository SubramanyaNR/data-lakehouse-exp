const metrics = require('./metrics');
const express = require("express");
const path = require("path");
const os = require("os");
const db = require("./db");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// Metrics middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const route = req.route ? req.route.path : req.path;
    metrics.httpRequestDuration.labels(req.method, route, res.statusCode).observe(duration);
    metrics.httpRequestTotal.labels(req.method, route, res.statusCode).inc();
  });
  next();
});

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', metrics.register.contentType);
  res.end(await metrics.register.metrics());
});

// ═══════════════════════════════════════════════════════════════
// SESSION MANAGEMENT (In-memory, use Redis in production)
// ═══════════════════════════════════════════════════════════════

const sessions = {};

function generateToken() {
  return Math.random().toString(36).substr(2) + Date.now().toString(36);
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token || !sessions[token]) {
    return res.status(401).json({ success: false, error: "Not logged in" });
  }
  req.customer = sessions[token];
  next();
}

function optionalAuth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token && sessions[token]) {
    req.customer = sessions[token];
  }
  next();
}

// ═══════════════════════════════════════════════════════════════
// CONNECT TO DATABASE
// ═══════════════════════════════════════════════════════════════

db.connect();

// Auto-complete orders after 2 minutes
setInterval(async () => {
  try {
    const completed = await db.autoCompleteOrders(2);
    if (completed.length > 0) {
      console.log(`✅ Auto-completed ${completed.length} orders:`, completed.map(o => o.order_id).join(', '));
    }
  } catch (err) {
    // Ignore if function doesn't exist (Kafka adapter)
  }
}, 30000); // Check every 30 seconds

// ═══════════════════════════════════════════════════════════════
// PAGE ROUTES
// ═══════════════════════════════════════════════════════════════

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/menu", (req, res) => {
  res.sendFile(path.join(__dirname, "togglemenu.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "login.html"));
});

app.get("/profile", (req, res) => {
  res.sendFile(path.join(__dirname, "profile.html"));
});

app.get("/kitchen", (req, res) => {
  res.sendFile(path.join(__dirname, "kitchen.html"));
});

app.get("/track", (req, res) => {
  res.sendFile(path.join(__dirname, "order-status.html"));
});

// ═══════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════

app.post("/auth/register", async (req, res) => {
  const { phone, name, email, password } = req.body;

  if (!phone || !password) {
    return res.status(400).json({ success: false, error: "Phone and password required" });
  }

  try {
    const customer = await db.createCustomer({ phone, name, email, password });
    const token = generateToken();
    sessions[token] = customer;

    res.json({ success: true, token, customer });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({ success: false, error: "Phone already registered" });
    }
    console.error("Register error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/auth/login", async (req, res) => {
  const { phone, password } = req.body;

  if (!phone || !password) {
    return res.status(400).json({ success: false, error: "Phone and password required" });
  }

  try {
    const customer = await db.loginCustomer(phone, password);

    if (!customer) {
      return res.status(401).json({ success: false, error: "Invalid phone or password" });
    }

    const token = generateToken();
    sessions[token] = customer;

    res.json({ success: true, token, customer });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/auth/logout", authMiddleware, (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  delete sessions[token];
  res.json({ success: true });
});

app.get("/auth/profile", authMiddleware, async (req, res) => {
  try {
    const customer = await db.getCustomerById(req.customer.id);
    res.json({ success: true, customer });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put("/auth/profile", authMiddleware, async (req, res) => {
  const { name, email, address, city } = req.body;

  try {
    const customer = await db.updateCustomer(req.customer.id, { name, email, address, city });
    const token = req.headers.authorization.replace("Bearer ", "");
    sessions[token] = customer;
    res.json({ success: true, customer });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/auth/orders", authMiddleware, async (req, res) => {
  try {
    const orders = await db.getCustomerOrders(req.customer.id);
    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// MENU ROUTES
// ═══════════════════════════════════════════════════════════════

app.get("/api/menu", async (req, res) => {
  try {
    const menu = await db.getFullMenu();
    res.json({ success: true, menu });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ORDER ROUTES
// ═══════════════════════════════════════════════════════════════

app.post("/place-order", optionalAuth, async (req, res) => {
  const { items, tableNumber, customerName } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ success: false, error: "No items in order" });
  }

  const order = {
    orderId: `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`,
    tableNumber: tableNumber || 0,
    customerName: req.customer ? req.customer.name : (customerName || "Walk-in"),
    customerId: req.customer ? req.customer.id : null,
    items: items,
    totalAmount: items.reduce((sum, i) => sum + (i.price * i.qty), 0)
  };

  try {
    const start = Date.now();
    await db.saveOrder(order);
    metrics.dbQueryDuration.labels('saveOrder').observe((Date.now() - start) / 1000);
    metrics.ordersTotal.labels('success').inc();
    
    console.log("🍽️ Order:", order.orderId);
    res.json({ success: true, orderId: order.orderId });
  } catch (err) {
    metrics.ordersTotal.labels('failed').inc();
    console.error("❌ Order error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/order-status/:orderId", async (req, res) => {
  try {
    const order = await db.getOrderStatus(req.params.orderId);
    if (!order) {
      return res.status(404).json({ success: false, error: "Order not found" });
    }
    res.json(order);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// KITCHEN ROUTES
// ═══════════════════════════════════════════════════════════════

app.get("/kitchen/orders", async (req, res) => {
  try {
    const orders = await db.getPendingOrders();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/kitchen/update-status", async (req, res) => {
  const { orderId, status } = req.body;

  const validStatuses = ["NEW", "CONFIRMED", "PREPARING", "READY", "DELIVERED", "CANCELLED"];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ success: false, error: "Invalid status" });
  }

  try {
    await db.updateOrderStatus(orderId, status);
    console.log("📋 Order", orderId, "→", status);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    db: db.isReady(),
    adapter: process.env.DB_ADAPTER || "postgres",
    timestamp: new Date().toISOString()
  });
});

// ═══════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════

function getIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "localhost";
}

const PORT = process.env.PORT || 3001;

app.listen(PORT, "0.0.0.0", () => {
  const ip = getIP();
  console.log("");
  console.log("═══════════════════════════════════════════════════");
  console.log("  🍽️  Guruprasad Udupi Restaurant");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Home:     http://${ip}:${PORT}`);
  console.log(`  Menu:     http://${ip}:${PORT}/menu`);
  console.log(`  Login:    http://${ip}:${PORT}/login`);
  console.log(`  Profile:  http://${ip}:${PORT}/profile`);
  console.log(`  Kitchen:  http://${ip}:${PORT}/kitchen`);
  console.log(`  Track:    http://${ip}:${PORT}/track`);
  console.log("═══════════════════════════════════════════════════");
  console.log("");
});

// ═══════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════

process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  await db.disconnect();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("Shutting down...");
  await db.disconnect();
  process.exit(0);
});
