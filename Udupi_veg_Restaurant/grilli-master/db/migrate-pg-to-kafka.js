#!/usr/bin/env node
/**
 * migrate-pg-to-kafka.js
 *
 * One-time migration: reads all existing data from PostgreSQL and
 * publishes it as events to the appropriate Kafka topics.
 *
 * Topics written:
 *   restaurant.customers     — one CUSTOMER_CREATED per customer row
 *   restaurant.orders        — one ORDER_CREATED per order (with items)
 *   restaurant.order-status  — one ORDER_STATUS_CHANGED per final status
 *   restaurant.menu          — MENU_CATEGORY_UPSERTED + MENU_ITEM_UPSERTED
 *
 * Usage:
 *   PG_HOST=... PG_PASSWORD=... KAFKA_BROKER=... node db/migrate-pg-to-kafka.js
 *
 * The script is idempotent: topics use log compaction, so re-running
 * overwrites existing keys with the latest migrated value.
 */

"use strict";

const { Pool } = require("pg");
const { Kafka } = require("kafkajs");

// ── Config ────────────────────────────────────────────────────────────────────

const pool = new Pool({
  host:     process.env.PG_HOST     || "localhost",
  port:     parseInt(process.env.PG_PORT) || 5432,
  database: process.env.PG_DATABASE || "restaurant",
  user:     process.env.PG_USER     || "postgres",
  password: process.env.PG_PASSWORD || "password"
});

const kafka = new Kafka({
  clientId: "pg-to-kafka-migrator",
  brokers: [process.env.KAFKA_BROKER || "my-cluster-kafka-bootstrap.kafka.svc.cluster.local:9092"],
  retry: { initialRetryTime: 300, retries: 10 }
});

const producer = kafka.producer({ allowAutoTopicCreation: false });

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sendBatch(topic, messages) {
  // Kafka producer sendBatch with topic messages
  await producer.send({ topic, messages });
  console.log(`  → Published ${messages.length} message(s) to ${topic}`);
}

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// ── Migration steps ───────────────────────────────────────────────────────────

async function migrateMenuCategories() {
  console.log("\n📦 Migrating menu_categories...");
  const { rows } = await pool.query(
    "SELECT id, name, display_order FROM menu_categories ORDER BY display_order"
  );

  if (rows.length === 0) {
    console.log("  (no rows found — skipping)");
    return 0;
  }

  const messages = rows.map(cat => ({
    key: String(cat.id),
    value: JSON.stringify({
      event: "MENU_CATEGORY_UPSERTED",
      data: cat,
      timestamp: new Date().toISOString()
    })
  }));

  await sendBatch("restaurant.menu", messages);
  console.log(`  ✅ ${rows.length} categories migrated`);
  return rows.length;
}

async function migrateMenuItems() {
  console.log("\n📦 Migrating menu_items...");
  const { rows } = await pool.query(
    "SELECT id, category_id, name, price, is_available FROM menu_items ORDER BY id"
  );

  if (rows.length === 0) {
    console.log("  (no rows found — skipping)");
    return 0;
  }

  const messages = rows.map(item => ({
    key: String(item.id),
    value: JSON.stringify({
      event: "MENU_ITEM_UPSERTED",
      data: item,
      timestamp: new Date().toISOString()
    })
  }));

  await sendBatch("restaurant.menu", messages);
  console.log(`  ✅ ${rows.length} menu items migrated`);
  return rows.length;
}

async function migrateMenuFromOrderItems() {
  console.log("\n📦 Deriving menu from order_items (no menu_categories table)...");

  // Extract distinct items — use MIN(price) in case of minor price drift across orders
  const { rows } = await pool.query(`
    SELECT item_name, MIN(price) AS price
    FROM order_items
    GROUP BY item_name
    ORDER BY item_name
  `);

  if (rows.length === 0) {
    console.log("  (no order_items found — skipping)");
    return;
  }

  const now = new Date().toISOString();

  // Publish a single synthetic category that wraps all items
  await sendBatch("restaurant.menu", [{
    key: "cat-derived-1",
    value: JSON.stringify({
      event: "MENU_CATEGORY_UPSERTED",
      data: { id: "cat-derived-1", name: "Our Menu", display_order: 1 },
      timestamp: now
    })
  }]);

  // Publish one MENU_ITEM_UPSERTED per distinct item
  const itemMessages = rows.map((item, idx) => ({
    key: `item-derived-${idx + 1}`,
    value: JSON.stringify({
      event: "MENU_ITEM_UPSERTED",
      data: {
        id: `item-derived-${idx + 1}`,
        category_id: "cat-derived-1",
        name: item.item_name,
        price: parseFloat(item.price),
        is_available: true
      },
      timestamp: now
    })
  }));

  await sendBatch("restaurant.menu", itemMessages);
  console.log(`  ✅ ${rows.length} menu items derived from order history and published to restaurant.menu`);
}

async function migrateMenu() {
  // Try the normalised menu tables first; fall back to deriving from order_items
  try {
    const catCount  = await migrateMenuCategories();
    const itemCount = await migrateMenuItems();
    if (catCount === 0 && itemCount === 0) {
      console.log("  ⚠️  menu_categories and menu_items are empty — falling back to order_items derivation");
      await migrateMenuFromOrderItems();
    }
  } catch (err) {
    if (err.code === "42P01") {
      // 42P01 = undefined_table — expected when menu tables were never created
      console.log("  ⚠️  menu_categories/menu_items tables not found — deriving menu from order_items");
      await migrateMenuFromOrderItems();
    } else {
      throw err;
    }
  }
}

async function migrateCustomers() {
  console.log("\n👤 Migrating customers...");
  const { rows } = await pool.query(
    `SELECT id, phone, name, email, password, loyalty_points, address, city, created_at
     FROM customers ORDER BY id`
  );

  if (rows.length === 0) {
    console.log("  (no rows found — skipping)");
    return;
  }

  const messages = rows.map(c => ({
    key: c.phone,              // Compaction key: latest record per phone wins
    value: JSON.stringify({
      event: "CUSTOMER_CREATED",
      data: {
        id:             c.id,
        phone:          c.phone,
        name:           c.name,
        email:          c.email,
        password:       c.password,  // Already bcrypt-hashed in PG
        loyalty_points: c.loyalty_points,
        address:        c.address,
        city:           c.city,
        created_at:     c.created_at
      },
      timestamp: c.created_at || new Date().toISOString()
    })
  }));

  // Send in batches of 100 to avoid large request payloads
  for (const batch of chunk(messages, 100)) {
    await sendBatch("restaurant.customers", batch);
  }
  console.log(`  ✅ ${rows.length} customers migrated`);
}

async function migrateOrders() {
  console.log("\n🍽️  Migrating orders...");

  // Fetch all orders with their items in one join
  const { rows } = await pool.query(`
    SELECT
      o.id          AS db_id,
      o.order_id,
      o.customer_id,
      o.table_number,
      o.total_amount,
      o.status,
      o.customer_name,
      o.created_at,
      o.updated_at,
      COALESCE(
        json_agg(
          json_build_object(
            'name',  oi.item_name,
            'price', oi.price,
            'qty',   oi.quantity
          )
        ) FILTER (WHERE oi.id IS NOT NULL),
        '[]'
      ) AS items
    FROM orders o
    LEFT JOIN order_items oi ON o.id = oi.order_id
    GROUP BY o.id
    ORDER BY o.created_at
  `);

  if (rows.length === 0) {
    console.log("  (no rows found — skipping)");
    return;
  }

  const orderMessages = [];
  const statusMessages = [];

  for (const row of rows) {
    const ts = row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString();
    const updTs = row.updated_at ? new Date(row.updated_at).toISOString() : ts;

    // ORDER_CREATED always published — initial state is NEW
    orderMessages.push({
      key: row.order_id,
      value: JSON.stringify({
        event: "ORDER_CREATED",
        data: {
          orderId:      row.order_id,
          customerId:   row.customer_id,
          tableNumber:  row.table_number,
          customerName: row.customer_name,
          totalAmount:  parseFloat(row.total_amount),
          items:        row.items,
          status:       "NEW",
          timestamp:    ts
        },
        timestamp: ts
      })
    });

    // If status is not NEW, publish a status-change event to reach final state
    if (row.status && row.status !== "NEW") {
      statusMessages.push({
        key: row.order_id,
        value: JSON.stringify({
          event: "ORDER_STATUS_CHANGED",
          data: {
            orderId:   row.order_id,
            status:    row.status,
            timestamp: updTs
          },
          timestamp: updTs
        })
      });
    }
  }

  for (const batch of chunk(orderMessages, 50)) {
    await sendBatch("restaurant.orders", batch);
  }

  if (statusMessages.length > 0) {
    for (const batch of chunk(statusMessages, 50)) {
      await sendBatch("restaurant.order-status", batch);
    }
  }

  console.log(`  ✅ ${rows.length} orders migrated (${statusMessages.length} with non-NEW status)`);
}

async function publishMigrationComplete(stats) {
  await producer.send({
    topic: "restaurant.migrations",
    messages: [{
      key: "migration-pg-to-kafka",
      value: JSON.stringify({
        event: "MIGRATION_COMPLETED",
        source: "postgresql",
        target: "kafka",
        stats,
        timestamp: new Date().toISOString()
      })
    }]
  });
  console.log("\n📝 Migration completion event published to restaurant.migrations");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PostgreSQL → Kafka Migration");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  PG:    ${process.env.PG_HOST || "localhost"}:${process.env.PG_PORT || 5432}/${process.env.PG_DATABASE || "restaurant"}`);
  console.log(`  Kafka: ${process.env.KAFKA_BROKER || "my-cluster-kafka-bootstrap.kafka.svc.cluster.local:9092"}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  try {
    // Test PG connection
    await pool.query("SELECT 1");
    console.log("✅ PostgreSQL connected");

    await producer.connect();
    console.log("✅ Kafka producer connected");

    const stats = {};

    // Count rows before migration for stats
    for (const table of ["menu_categories", "menu_items", "customers", "orders"]) {
      try {
        const { rows } = await pool.query(`SELECT COUNT(*) FROM ${table}`);
        stats[table] = parseInt(rows[0].count);
      } catch {
        stats[table] = 0;
      }
    }

    console.log("\n📊 Rows to migrate:", stats);

    await migrateMenu();
    await migrateCustomers();
    await migrateOrders();
    await publishMigrationComplete(stats);

    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("  ✅ Migration complete!");
    console.log("  You can now set DB_ADAPTER=kafka and restart the app.");
    console.log("═══════════════════════════════════════════════════════════\n");

  } catch (err) {
    console.error("\n❌ Migration failed:", err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    await producer.disconnect().catch(() => {});
    await pool.end().catch(() => {});
  }
}

main();
