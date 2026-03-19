const { Pool } = require("pg");
const bcrypt = require("bcrypt");

const pool = new Pool({
  host: process.env.PG_HOST || "localhost",
  port: process.env.PG_PORT || 5432,
  database: process.env.PG_DATABASE || "restaurant",
  user: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "password",

  max: parseInt(process.env.PG_POOL_SIZE) || 10,
  idleTimeoutMillis: 30000,       // Close idle connections after 30s
  connectionTimeoutMillis: 15000,  // Fail fast if can't connect in 5s

});

let isConnected = false;

// ═══════════════════════════════════════════════════════════════
// CONNECTION
// ═══════════════════════════════════════════════════════════════

async function connect() {
  try {
    await pool.query("SELECT 1");
    isConnected = true;
    console.log("✅ PostgreSQL connected");
  } catch (err) {
    console.error("❌ PostgreSQL connection failed:", err.message);
  }
}

async function disconnect() {
  await pool.end();
  isConnected = false;
  console.log("PostgreSQL disconnected");
}

function isReady() {
  return isConnected;
}

// ═══════════════════════════════════════════════════════════════
// CUSTOMERS
// ═══════════════════════════════════════════════════════════════

async function createCustomer(customer) {
  const hashedPassword = await bcrypt.hash(customer.password, 10);

  const result = await pool.query(
    `INSERT INTO customers (phone, name, email, password, address, city)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, phone, name, email, loyalty_points, address, city, created_at`,
    [
      customer.phone,
      customer.name || null,
      customer.email || null,
      hashedPassword,
      customer.address || null,
      customer.city || null
    ]
  );

  return result.rows[0];
}

async function loginCustomer(phone, password) {
  const result = await pool.query(
    `SELECT id, phone, name, email, password, loyalty_points, address, city, created_at
     FROM customers WHERE phone = $1`,
    [phone]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const customer = result.rows[0];
  const valid = await bcrypt.compare(password, customer.password);

  if (!valid) {
    return null;
  }

  delete customer.password;
  return customer;
}

async function getCustomerById(id) {
  const result = await pool.query(
    `SELECT id, phone, name, email, loyalty_points, address, city, created_at
     FROM customers WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function updateCustomer(id, updates) {
  const result = await pool.query(
    `UPDATE customers
     SET name = COALESCE($2, name),
         email = COALESCE($3, email),
         address = COALESCE($4, address),
         city = COALESCE($5, city)
     WHERE id = $1
     RETURNING id, phone, name, email, loyalty_points, address, city, created_at`,
    [id, updates.name, updates.email, updates.address, updates.city]
  );
  return result.rows[0];
}

async function addLoyaltyPoints(customerId, points) {
  const result = await pool.query(
    `UPDATE customers SET loyalty_points = loyalty_points + $2 WHERE id = $1 RETURNING loyalty_points`,
    [customerId, points]
  );
  return result.rows[0];
}

// ═══════════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════════

async function saveOrder(order) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Insert order
    const result = await client.query(
      `INSERT INTO orders (order_id, customer_id, table_number, total_amount, status, customer_name)
       VALUES ($1, $2, $3, $4, 'NEW', $5) RETURNING id`,
      [order.orderId, order.customerId || null, order.tableNumber, order.totalAmount, order.customerName]
    );

    const dbId = result.rows[0].id;

    // BATCH INSERT - single query for all items
    if (order.items.length > 0) {
      const values = [];
      const params = [];
      let paramIndex = 1;

      for (const item of order.items) {
        values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
        params.push(dbId, item.name, item.price, item.qty);
      }

      await client.query(
        `INSERT INTO order_items (order_id, item_name, price, quantity) VALUES ${values.join(', ')}`,
        params
      );
    }

    // Add loyalty points if customer logged in
    if (order.customerId) {
      const points = Math.floor(order.totalAmount / 10);
      if (points > 0) {
        await client.query(
          `UPDATE customers SET loyalty_points = loyalty_points + $2 WHERE id = $1`,
          [order.customerId, points]
        );
      }
    }

    await client.query("COMMIT");
    return { id: dbId, orderId: order.orderId };

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function getOrderStatus(orderId) {
  const result = await pool.query(
    `SELECT order_id, status, total_amount, table_number, customer_name, created_at, updated_at
     FROM orders WHERE order_id = $1`,
    [orderId]
  );
  return result.rows[0] || null;
}

async function getOrderById(id) {
  const result = await pool.query(
    `SELECT o.*, json_agg(json_build_object('name', oi.item_name, 'price', oi.price, 'qty', oi.quantity)) as items
     FROM orders o
     JOIN order_items oi ON o.id = oi.order_id
     WHERE o.id = $1
     GROUP BY o.id`,
    [id]
  );
  return result.rows[0] || null;
}

async function getPendingOrders() {
  const result = await pool.query(
    `SELECT o.id, o.order_id, o.status, o.table_number, o.total_amount, o.customer_name, o.created_at,
            json_agg(json_build_object('name', oi.item_name, 'price', oi.price, 'qty', oi.quantity)) as items
     FROM orders o
     JOIN order_items oi ON o.id = oi.order_id
     WHERE o.status IN ('NEW', 'CONFIRMED', 'PREPARING', 'READY')
     GROUP BY o.id
     ORDER BY o.created_at`
  );
  return result.rows;
}

async function updateOrderStatus(orderId, status) {
  await pool.query(
    `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
    [status, orderId]
  );

  await pool.query(
    `INSERT INTO order_status_history (order_id, status) VALUES ($1, $2)`,
    [orderId, status]
  );
}

async function getCustomerOrders(customerId) {
  const result = await pool.query(
    `SELECT o.id, o.order_id, o.status, o.total_amount, o.table_number, o.created_at,
            json_agg(json_build_object('name', oi.item_name, 'price', oi.price, 'qty', oi.quantity)) as items
     FROM orders o
     JOIN order_items oi ON o.id = oi.order_id
     WHERE o.customer_id = $1
     GROUP BY o.id
     ORDER BY o.created_at DESC`,
    [customerId]
  );
  return result.rows;
}

// ═══════════════════════════════════════════════════════════════
// MENU
// ═══════════════════════════════════════════════════════════════

async function getMenuCategories() {
  const result = await pool.query(
    `SELECT * FROM menu_categories ORDER BY display_order`
  );
  return result.rows;
}

async function getMenuItems(categoryId = null) {
  let query = `
    SELECT mi.*, mc.name as category_name
    FROM menu_items mi
    JOIN menu_categories mc ON mi.category_id = mc.id
    WHERE mi.is_available = true
  `;

  const params = [];
  if (categoryId) {
    query += ` AND mi.category_id = $1`;
    params.push(categoryId);
  }

  query += ` ORDER BY mc.display_order, mi.name`;

  const result = await pool.query(query, params);
  return result.rows;
}

async function getFullMenu() {
  const categories = await getMenuCategories();
  const items = await getMenuItems();

  return categories.map(cat => ({
    ...cat,
    items: items.filter(item => item.category_id === cat.id)
  }));
}

async function autoCompleteOrders(minutes = 2) {
  const result = await pool.query(
    `UPDATE orders 
     SET status = 'DELIVERED', updated_at = NOW()
     WHERE status IN ('NEW', 'CONFIRMED', 'PREPARING', 'READY')
     AND created_at < NOW() - INTERVAL '${minutes} minutes'
     RETURNING id, order_id`
  );
  
  // Log status history for each completed order
  for (const order of result.rows) {
    await pool.query(
      `INSERT INTO order_status_history (order_id, status) VALUES ($1, 'DELIVERED')`,
      [order.id]
    );
  }
  
  return result.rows;
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
