const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const POOL_SIZE = process.argv[2] || "10";  // Pass as argument: node benchmark.js 25

const CONFIG = {
  name: "Restaurant App - PostgreSQL Benchmark",
  version: "3.0.0",
  adapter: "postgres",
  poolSize: parseInt(POOL_SIZE),
  
  // Target (your manually started server)
  app: {
    host: "localhost",
    port: 3001,
    endpoint: "/place-order"
  },
  
  // Database
  database: {
    namespace: "postgres",
    podName: "postgresql-0",
    user: "postgres",
    database: "postgres",
    password: "YOUR_PASSWORD_HERE"  // ← PUT YOUR PASSWORD
  },
  
  // Load levels (req/s)
  loadLevels: [10, 25, 50, 75, 100, 125, 150, 175, 200, 250, 300],
  
  // Test parameters
  runs: 3,
  warmupDuration: 20,
  testDuration: 60,
  cooldownDuration: 10,
  
  // Thresholds
  thresholds: {
    maxErrorRate: 0.01,
    maxP95Latency: 500,
    maxP99Latency: 1000
  },
  
  debug: true
};

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════════════════════

function log(msg, level = "INFO") {
  const ts = new Date().toISOString().substr(11, 8);
  const prefix = { INFO: "ℹ️", SUCCESS: "✅", WARNING: "⚠️", ERROR: "❌", STEP: "▶", RESULT: "📊" }[level] || " ";
  console.log(`[${ts}] ${prefix} ${msg}`);
}

function sleep(sec) {
  return new Promise(r => setTimeout(r, sec * 1000));
}

function execCmd(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', shell: '/bin/bash', stdio: 'pipe', timeout: 30000 }).trim();
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE CLEANUP
// ═══════════════════════════════════════════════════════════════════════════

function cleanupDatabase() {
  log("Cleaning database...", "STEP");
  const cmd = `kubectl exec ${CONFIG.database.podName} -n ${CONFIG.database.namespace} -- env PGPASSWORD='${CONFIG.database.password}' psql -U ${CONFIG.database.user} -d ${CONFIG.database.database} -c "TRUNCATE order_items, order_status_history, orders RESTART IDENTITY CASCADE;" 2>/dev/null`;
  const result = execCmd(cmd);
  if (result !== null) {
    log("Database cleaned", "SUCCESS");
    return true;
  }
  log("Database cleanup failed (continuing anyway)", "WARNING");
  return false;
}

function getOrderCount() {
  const cmd = `kubectl exec ${CONFIG.database.podName} -n ${CONFIG.database.namespace} -- env PGPASSWORD='${CONFIG.database.password}' psql -U ${CONFIG.database.user} -d ${CONFIG.database.database} -t -c "SELECT COUNT(*) FROM orders;" 2>/dev/null`;
  const result = execCmd(cmd);
  return parseInt(result) || 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// SYSTEM INFO
// ═══════════════════════════════════════════════════════════════════════════

function collectSystemInfo() {
  const cpus = os.cpus();
  return {
    timestamp: new Date().toISOString(),
    host: os.hostname(),
    platform: `${os.platform()} ${os.arch()}`,
    cpu: {
      model: cpus[0]?.model || 'Unknown',
      cores: cpus.length,
      loadAvg: os.loadavg().map(l => l.toFixed(2)).join(' / ')
    },
    memory: {
      total: (os.totalmem() / 1024 / 1024 / 1024).toFixed(2) + ' GB',
      free: (os.freemem() / 1024 / 1024 / 1024).toFixed(2) + ' GB',
      usage: ((1 - os.freemem() / os.totalmem()) * 100).toFixed(1) + '%'
    },
    node: process.version,
    poolSize: CONFIG.poolSize,
    adapter: CONFIG.adapter
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST DATA
// ═══════════════════════════════════════════════════════════════════════════

const menuItems = [
  { name: 'Masala Dosa', price: 80 },
  { name: 'Plain Dosa', price: 60 },
  { name: 'Idli', price: 40 },
  { name: 'Vada', price: 50 },
  { name: 'Filter Coffee', price: 30 },
  { name: 'Paneer Tikka', price: 160 },
  { name: 'Gobi Manchurian', price: 120 },
  { name: 'Upma', price: 45 }
];

function generateOrder() {
  const items = [];
  const count = Math.floor(Math.random() * 4) + 1;
  for (let i = 0; i < count; i++) {
    const item = menuItems[Math.floor(Math.random() * menuItems.length)];
    items.push({ name: item.name, price: item.price, qty: Math.floor(Math.random() * 3) + 1 });
  }
  return {
    items,
    tableNumber: Math.floor(Math.random() * 30) + 1,
    customerName: `Bench-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTP CLIENT
// ═══════════════════════════════════════════════════════════════════════════

let errorLogged = false;

function sendRequest() {
  return new Promise((resolve) => {
    const data = JSON.stringify(generateOrder());
    const start = process.hrtime.bigint();
    
    const req = http.request({
      hostname: CONFIG.app.host,
      port: CONFIG.app.port,
      path: CONFIG.app.endpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 30000
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        const latency = Number(process.hrtime.bigint() - start) / 1e6;
        
        if (res.statusCode !== 200 && !errorLogged && CONFIG.debug) {
          console.log(`\n[DEBUG] Error: ${res.statusCode} - ${body.substring(0, 200)}`);
          errorLogged = true;
        }
        
        resolve({ success: res.statusCode === 200, statusCode: res.statusCode, latency });
      });
    });

    req.on('error', (err) => {
      const latency = Number(process.hrtime.bigint() - start) / 1e6;
      if (!errorLogged && CONFIG.debug) {
        console.log(`\n[DEBUG] Connection error: ${err.message}`);
        errorLogged = true;
      }
      resolve({ success: false, error: err.message, latency });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'timeout', latency: 30000 });
    });

    req.write(data);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// STATISTICS
// ═══════════════════════════════════════════════════════════════════════════

function calcStats(latencies) {
  if (!latencies.length) return null;
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const variance = sorted.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / sorted.length;
  
  const pct = p => Math.round(sorted[Math.floor(sorted.length * p)] * 100) / 100;
  
  return {
    count: sorted.length,
    min: Math.round(sorted[0] * 100) / 100,
    max: Math.round(sorted[sorted.length - 1] * 100) / 100,
    mean: Math.round(mean * 100) / 100,
    stdDev: Math.round(Math.sqrt(variance) * 100) / 100,
    p50: pct(0.50),
    p90: pct(0.90),
    p95: pct(0.95),
    p99: pct(0.99)
  };
}

function calcCI(values) {
  if (!values.length) return { mean: 0, margin: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const stdDev = Math.sqrt(values.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / (values.length - 1 || 1));
  const margin = 1.96 * (stdDev / Math.sqrt(values.length));
  return { mean: Math.round(mean * 100) / 100, margin: Math.round(margin * 100) / 100 };
}

// ═══════════════════════════════════════════════════════════════════════════
// LOAD TEST
// ═══════════════════════════════════════════════════════════════════════════

async function runLoadTest(targetRps, duration) {
  const results = { success: 0, failed: 0, latencies: [], errors: {} };
  const startTime = Date.now();
  const endTime = startTime + (duration * 1000);
  const intervalMs = 1000 / targetRps;
  
  let lastReqTime = startTime;
  const pending = [];
  
  while (Date.now() < endTime) {
    const now = Date.now();
    if (now - lastReqTime >= intervalMs) {
      pending.push(sendRequest().then(r => {
        if (r.success) results.success++;
        else {
          results.failed++;
          const key = r.error || `HTTP_${r.statusCode}`;
          results.errors[key] = (results.errors[key] || 0) + 1;
        }
        results.latencies.push(r.latency);
      }));
      lastReqTime = now;
    }
    await new Promise(r => setTimeout(r, 1));
  }
  
  await Promise.all(pending);
  
  const actualDuration = (Date.now() - startTime) / 1000;
  return {
    targetRps,
    actualRps: Math.round((results.latencies.length / actualDuration) * 100) / 100,
    requests: { total: results.success + results.failed, success: results.success, failed: results.failed },
    errorRate: Math.round((results.failed / Math.max(results.success + results.failed, 1)) * 10000) / 100,
    errors: results.errors,
    latency: calcStats(results.latencies)
  };
}

async function runIteration(targetRps, iter, total) {
  process.stdout.write(`      Iteration ${iter}/${total}: warmup...`);
  await runLoadTest(targetRps, CONFIG.warmupDuration);
  
  process.stdout.write(" test...");
  errorLogged = false;  // Reset for each test
  const result = await runLoadTest(targetRps, CONFIG.testDuration);
  
  process.stdout.write(" cooldown...");
  await sleep(CONFIG.cooldownDuration);
  
  console.log(` Done (${result.requests.total} reqs, ${result.errorRate}% err, p95: ${result.latency?.p95 || 'N/A'}ms)`);
  return result;
}

async function runLoadLevel(targetRps) {
  log(`Testing ${targetRps} req/s`, "STEP");
  
  const iterations = [];
  for (let i = 1; i <= CONFIG.runs; i++) {
    iterations.push(await runIteration(targetRps, i, CONFIG.runs));
  }
  
  const aggregated = {
    targetRps,
    actualRps: calcCI(iterations.map(r => r.actualRps)),
    errorRate: calcCI(iterations.map(r => r.errorRate)),
    latency: {
      p50: calcCI(iterations.map(r => r.latency?.p50 || 0)),
      p95: calcCI(iterations.map(r => r.latency?.p95 || 0)),
      p99: calcCI(iterations.map(r => r.latency?.p99 || 0))
    },
    totals: {
      requests: iterations.reduce((s, r) => s + r.requests.total, 0),
      success: iterations.reduce((s, r) => s + r.requests.success, 0),
      failed: iterations.reduce((s, r) => s + r.requests.failed, 0)
    },
    meetsThresholds: iterations.every(r => 
      r.errorRate <= CONFIG.thresholds.maxErrorRate * 100 &&
      (r.latency?.p95 || 0) <= CONFIG.thresholds.maxP95Latency
    ),
    rawIterations: iterations
  };
  
  const status = aggregated.meetsThresholds ? "✅ PASS" : "❌ FAIL";
  log(`${targetRps} req/s: ${aggregated.actualRps.mean} rps, ${aggregated.errorRate.mean}% err, p95: ${aggregated.latency.p95.mean}ms ${status}`, "RESULT");
  
  return aggregated;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const startTime = new Date();
  
  console.log('\n' + '═'.repeat(70));
  console.log('  ' + CONFIG.name);
  console.log('═'.repeat(70));
  console.log(`  Pool Size:    ${CONFIG.poolSize}`);
  console.log(`  Target:       http://${CONFIG.app.host}:${CONFIG.app.port}${CONFIG.app.endpoint}`);
  console.log(`  Load Levels:  ${CONFIG.loadLevels.join(', ')} req/s`);
  console.log(`  Runs/Level:   ${CONFIG.runs}`);
  console.log('═'.repeat(70));
  
  // Collect system info
  const sysInfo = collectSystemInfo();
  console.log(`\n  System: ${sysInfo.cpu.model} (${sysInfo.cpu.cores} cores)`);
  console.log(`  Memory: ${sysInfo.memory.total} total, ${sysInfo.memory.usage} used`);
  console.log(`  Load:   ${sysInfo.cpu.loadAvg}`);
  
  // Cleanup database
  console.log('');
  cleanupDatabase();
  const ordersBefore = getOrderCount();
  log(`Orders in DB: ${ordersBefore}`, "INFO");
  
  // Pre-flight check
  log("Pre-flight check...", "STEP");
  const testResult = await sendRequest();
  if (!testResult.success) {
    log("Pre-flight FAILED - is server.js running?", "ERROR");
    console.log(`\n  Make sure you started the server:`);
    console.log(`  PG_HOST=localhost PG_PORT=5432 PG_POOL_SIZE=${CONFIG.poolSize} PG_PASSWORD=xxx DB_ADAPTER=postgres node server.js`);
    process.exit(1);
  }
  log("Pre-flight PASSED", "SUCCESS");
  
  // Run tests
  const results = { loadLevels: {}, maxSustainableRps: 0, breakingPoint: null };
  
  for (const rps of CONFIG.loadLevels) {
    const result = await runLoadLevel(rps);
    results.loadLevels[rps] = result;
    
    if (result.meetsThresholds) {
      results.maxSustainableRps = rps;
    } else if (!results.breakingPoint) {
      results.breakingPoint = { rps, errorRate: result.errorRate.mean, p95: result.latency.p95.mean };
    }
    
    if (result.errorRate.mean > 50) {
      log(`Error rate > 50%, stopping`, "WARNING");
      break;
    }
    
    await sleep(5);
  }
  
  const endTime = new Date();
  const duration = Math.round((endTime - startTime) / 1000 / 60);
  
  // Final cleanup and count
  const ordersAfter = getOrderCount();
  log(`Orders created during test: ${ordersAfter - ordersBefore}`, "INFO");
  cleanupDatabase();
  
  // Generate report
  const report = {
    metadata: {
      name: CONFIG.name,
      timestamp: startTime.toISOString(),
      duration: `${duration} minutes`,
      adapter: CONFIG.adapter,
      poolSize: CONFIG.poolSize
    },
    systemInfo: sysInfo,
    configuration: {
      loadLevels: CONFIG.loadLevels,
      runs: CONFIG.runs,
      warmupDuration: CONFIG.warmupDuration,
      testDuration: CONFIG.testDuration,
      thresholds: CONFIG.thresholds
    },
    results,
    analysis: {
      maxSustainableRps: results.maxSustainableRps,
      breakingPoint: results.breakingPoint,
      throughputPerHour: results.maxSustainableRps * 3600
    }
  };
  
  // Save report
  const filename = `benchmark-postgres-pool${CONFIG.poolSize}-${startTime.toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(filename, JSON.stringify(report, null, 2));
  
  // Print summary
  console.log('\n' + '═'.repeat(70));
  console.log('  RESULTS');
  console.log('═'.repeat(70));
  console.log(`\n  Pool Size:             ${CONFIG.poolSize}`);
  console.log(`  Max Sustainable RPS:   ${results.maxSustainableRps} req/s`);
  console.log(`  Breaking Point:        ${results.breakingPoint?.rps || 'N/A'} req/s`);
  console.log(`  Throughput/Hour:       ${(results.maxSustainableRps * 3600).toLocaleString()} orders`);
  console.log(`\n  Report saved: ${filename}`);
  console.log('═'.repeat(70));
}

main().catch(err => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
