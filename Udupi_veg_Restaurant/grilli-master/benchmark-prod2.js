const http = require('http');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  name: "Restaurant App - PostgreSQL Benchmark",
  version: "3.0.0",
  adapter: "postgres",
  
  // Target application
  app: {
    script: "server.js",
    host: "localhost",
    port: 3001,
    healthEndpoint: "/health",
    testEndpoint: "/place-order"
  },
  
  // Database - UPDATED FOR RESTAURANT DB
  database: {
    namespace: "postgres",
    podName: "postgresql-0",
    serviceName: "postgresql",
    user: "postgres",
    database: "restaurant",              // ← Changed to restaurant
    password: "password"       // ← PUT YOUR PASSWORD HERE
  },
  
  // Pool sizes to test
  poolSizes: [10, 25, 50],
  
  // Load levels (req/s)
  loadLevels: [10, 25, 50, 100, 200, 300],
  
  // Test parameters
  runs: 3,
  warmupDuration: 20,
  testDuration: 60,
  cooldownDuration: 10,
  appStartupWait: 8,
  
  // Thresholds
  thresholds: {
    maxErrorRate: 0.05,
    maxP95Latency: 1000,
    maxP99Latency: 2000
  },
  
  debug: true
};

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════════════

let appProcess = null;
let systemInfo = null;
const allResults = {};
let errorLogged = false;

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function log(msg, level = "INFO") {
  const ts = new Date().toISOString().substr(11, 8);
  const prefix = {
    "INFO": "ℹ️ ",
    "SUCCESS": "✅",
    "WARNING": "⚠️ ",
    "ERROR": "❌",
    "STEP": "▶ ",
    "RESULT": "📊",
    "SYSTEM": "🖥️ ",
    "DEBUG": "🔍"
  }[level] || "  ";
  console.log(`[${ts}] ${prefix} ${msg}`);
}

function debug(msg, data = null) {
  if (!CONFIG.debug) return;
  console.log(`[DEBUG] ${msg}`, data ? JSON.stringify(data).substring(0, 200) : '');
}

function sleep(sec) {
  return new Promise(r => setTimeout(r, sec * 1000));
}

function execCmd(cmd, silent = true) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      shell: '/bin/bash',
      stdio: silent ? 'pipe' : 'inherit',
      timeout: 30000
    }).trim();
  } catch (e) {
    debug(`Command failed: ${cmd}`, e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SYSTEM INFO
// ═══════════════════════════════════════════════════════════════════════════

function collectSystemInfo() {
  log("Collecting system information...", "SYSTEM");
  
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  
  let physicalCores = cpus.length;
  if (os.platform() === 'linux') {
    const result = execCmd('grep "^core id" /proc/cpuinfo | sort -u | wc -l');
    if (result) physicalCores = parseInt(result) || cpus.length;
  }
  
  let diskInfo = {};
  if (os.platform() === 'linux' || os.platform() === 'darwin') {
    const df = execCmd('df -h / | tail -1');
    if (df) {
      const parts = df.split(/\s+/);
      diskInfo = { size: parts[1], available: parts[3], usage: parts[4] };
    }
    const rotational = execCmd('cat /sys/block/sda/queue/rotational 2>/dev/null');
    diskInfo.type = rotational === '0' ? 'SSD' : (rotational === '1' ? 'HDD' : 'Unknown');
  }
  
  let osInfo = { type: os.type(), platform: os.platform(), release: os.release() };
  if (os.platform() === 'linux') {
    const name = execCmd('cat /etc/os-release | grep "^NAME=" | cut -d= -f2 | tr -d \'"\'');
    const version = execCmd('cat /etc/os-release | grep "^VERSION=" | cut -d= -f2 | tr -d \'"\'');
    if (name) osInfo.name = name;
    if (version) osInfo.version = version;
    osInfo.kernel = execCmd('uname -r');
  }
  
  let k8sInfo = { available: false };
  const k8sVersion = execCmd('kubectl version -o json 2>/dev/null');
  if (k8sVersion) {
    try {
      const v = JSON.parse(k8sVersion);
      k8sInfo.available = true;
      k8sInfo.serverVersion = v.serverVersion?.gitVersion;
    } catch (e) {}
  }
  
  let dbInfo = { type: 'PostgreSQL', available: false };
  const dbVersion = execCmd(`kubectl exec ${CONFIG.database.podName} -n ${CONFIG.database.namespace} -- env PGPASSWORD='${CONFIG.database.password}' psql -U ${CONFIG.database.user} -d ${CONFIG.database.database} -t -c "SELECT version();" 2>/dev/null`);
  if (dbVersion) {
    dbInfo.available = true;
    dbInfo.version = dbVersion.trim().split(',')[0];
  }
  const maxConn = execCmd(`kubectl exec ${CONFIG.database.podName} -n ${CONFIG.database.namespace} -- env PGPASSWORD='${CONFIG.database.password}' psql -U ${CONFIG.database.user} -d ${CONFIG.database.database} -t -c "SHOW max_connections;" 2>/dev/null`);
  if (maxConn) dbInfo.maxConnections = maxConn.trim();
  
  return {
    collectedAt: new Date().toISOString(),
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptime: Math.floor(os.uptime() / 3600) + 'h'
    },
    cpu: {
      model: cpus[0]?.model || 'Unknown',
      speed: `${cpus[0]?.speed || 0} MHz`,
      cores: { physical: physicalCores, logical: cpus.length },
      loadAverage: os.loadavg().map(l => l.toFixed(2)).join(' / ')
    },
    memory: {
      total: (totalMem / 1024 / 1024 / 1024).toFixed(2) + ' GB',
      free: (freeMem / 1024 / 1024 / 1024).toFixed(2) + ' GB',
      usage: ((1 - freeMem / totalMem) * 100).toFixed(1) + '%'
    },
    disk: diskInfo,
    os: osInfo,
    runtime: { node: process.version, npm: execCmd('npm --version') || 'Unknown' },
    kubernetes: k8sInfo,
    database: dbInfo
  };
}

function printSystemInfo(info) {
  console.log('\n' + '═'.repeat(70));
  console.log('  SYSTEM INFORMATION');
  console.log('═'.repeat(70));
  console.log(`\n  Host:       ${info.host.hostname} (${info.host.platform} ${info.host.arch})`);
  console.log(`  CPU:        ${info.cpu.model}`);
  console.log(`  Cores:      ${info.cpu.cores.physical} physical / ${info.cpu.cores.logical} logical`);
  console.log(`  Memory:     ${info.memory.total} total, ${info.memory.usage} used`);
  console.log(`  Disk:       ${info.disk.size || 'Unknown'} (${info.disk.type || 'Unknown'})`);
  console.log(`  OS:         ${info.os.name || info.os.type} ${info.os.version || info.os.release}`);
  console.log(`  Node.js:    ${info.runtime.node}`);
  if (info.kubernetes.available) {
    console.log(`  Kubernetes: ${info.kubernetes.serverVersion}`);
  }
  if (info.database.available) {
    console.log(`  PostgreSQL: ${info.database.version}`);
    console.log(`  Max Conns:  ${info.database.maxConnections || 'Unknown'}`);
  }
  console.log('═'.repeat(70));
}

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

function cleanupDatabase() {
  log("Cleaning database...", "STEP");
  const cmd = `kubectl exec ${CONFIG.database.podName} -n ${CONFIG.database.namespace} -- env PGPASSWORD='${CONFIG.database.password}' psql -U ${CONFIG.database.user} -d ${CONFIG.database.database} -c "TRUNCATE order_items, order_status_history, orders RESTART IDENTITY CASCADE;" 2>/dev/null`;
  const result = execCmd(cmd);
  if (result !== null) {
    log("Database cleaned", "SUCCESS");
    return true;
  }
  log("Database cleanup failed", "WARNING");
  return false;
}

function ensureTablesExist() {
  log("Ensuring tables exist...", "STEP");
  
  // First ensure database exists
  execCmd(`kubectl exec ${CONFIG.database.podName} -n ${CONFIG.database.namespace} -- env PGPASSWORD='${CONFIG.database.password}' psql -U ${CONFIG.database.user} -c "CREATE DATABASE ${CONFIG.database.database};" 2>/dev/null`);
  
  // Create tables
  const createTables = `
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(15) UNIQUE NOT NULL,
      name VARCHAR(100),
      email VARCHAR(100),
      password VARCHAR(255),
      address TEXT,
      city VARCHAR(50),
      loyalty_points INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
    
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_id VARCHAR(50) UNIQUE NOT NULL,
      customer_id INT REFERENCES customers(id),
      customer_name VARCHAR(100),
      status VARCHAR(20) DEFAULT 'NEW',
      total_amount DECIMAL(10,2),
      table_number INT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INT REFERENCES orders(id),
      item_name VARCHAR(100),
      price DECIMAL(10,2),
      quantity INT
    );
    
    CREATE TABLE IF NOT EXISTS order_status_history (
      id SERIAL PRIMARY KEY,
      order_id INT REFERENCES orders(id),
      status VARCHAR(20),
      changed_at TIMESTAMP DEFAULT NOW()
    );
    
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
  `;
  
  const cmd = `kubectl exec ${CONFIG.database.podName} -n ${CONFIG.database.namespace} -- env PGPASSWORD='${CONFIG.database.password}' psql -U ${CONFIG.database.user} -d ${CONFIG.database.database} -c "${createTables.replace(/\n/g, ' ')}" 2>/dev/null`;
  execCmd(cmd);
  log("Tables ready", "SUCCESS");
}

// ═══════════════════════════════════════════════════════════════════════════
// APPLICATION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

async function startApp(poolSize) {
  log(`Starting application with pool size: ${poolSize}`, "STEP");
  
  // Kill any existing
  execCmd(`lsof -ti:${CONFIG.app.port} | xargs kill -9 2>/dev/null || true`);
  await sleep(2);
  
  const env = {
    ...process.env,
    PORT: CONFIG.app.port.toString(),
    PG_HOST: "localhost",
    PG_PORT: "5432",
    PG_DATABASE: CONFIG.database.database,
    PG_USER: CONFIG.database.user,
    PG_PASSWORD: CONFIG.database.password,
    PG_POOL_SIZE: poolSize.toString(),
    DB_ADAPTER: CONFIG.adapter
  };
  
  debug("Starting app with env", { PORT: env.PORT, PG_DATABASE: env.PG_DATABASE, PG_POOL_SIZE: env.PG_POOL_SIZE });
  
  return new Promise((resolve, reject) => {
    appProcess = spawn('node', [CONFIG.app.script], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });
    
    let started = false;
    let output = '';
    
    appProcess.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      debug("App stdout", text.trim().substring(0, 100));
      
      if (text.includes('PostgreSQL connected') || text.includes('listening') || text.includes('http://')) {
        if (!started) {
          started = true;
          log(`Application started on port ${CONFIG.app.port}`, "SUCCESS");
          setTimeout(() => resolve(true), 2000);
        }
      }
    });
    
    appProcess.stderr.on('data', (data) => {
      const text = data.toString();
      debug("App stderr", text.trim().substring(0, 100));
      
      if (text.includes('EADDRINUSE')) {
        log("Port in use, retrying...", "WARNING");
        execCmd(`lsof -ti:${CONFIG.app.port} | xargs kill -9 2>/dev/null || true`);
        setTimeout(() => startApp(poolSize).then(resolve).catch(reject), 3000);
      }
    });
    
    appProcess.on('error', (err) => {
      log("Failed to start: " + err.message, "ERROR");
      reject(err);
    });
    
    setTimeout(() => {
      if (!started) {
        log("Timeout, checking health...", "WARNING");
        checkHealth().then(healthy => {
          if (healthy) {
            started = true;
            resolve(true);
          } else {
            debug("App output was", output.substring(0, 500));
            reject(new Error("App failed to start"));
          }
        });
      }
    }, CONFIG.appStartupWait * 1000);
  });
}

function stopApp() {
  log("Stopping application...", "STEP");
  if (appProcess) {
    appProcess.kill('SIGTERM');
    appProcess = null;
  }
  execCmd(`lsof -ti:${CONFIG.app.port} | xargs kill -9 2>/dev/null || true`);
  log("Application stopped", "SUCCESS");
}

async function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: CONFIG.app.host,
      port: CONFIG.app.port,
      path: CONFIG.app.healthEndpoint,
      timeout: 5000
    }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
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

function sendRequest() {
  return new Promise((resolve) => {
    const data = JSON.stringify(generateOrder());
    const start = process.hrtime.bigint();
    
    const req = http.request({
      hostname: CONFIG.app.host,
      port: CONFIG.app.port,
      path: CONFIG.app.testEndpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 30000
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        const latency = Number(process.hrtime.bigint() - start) / 1e6;
        
        if (res.statusCode !== 200 && !errorLogged && CONFIG.debug) {
          console.log(`\n[DEBUG ERROR] Status: ${res.statusCode}, Body: ${body.substring(0, 300)}`);
          errorLogged = true;
        }
        
        resolve({ success: res.statusCode === 200, statusCode: res.statusCode, latency });
      });
    });

    req.on('error', (err) => {
      const latency = Number(process.hrtime.bigint() - start) / 1e6;
      if (!errorLogged && CONFIG.debug) {
        console.log(`\n[DEBUG ERROR] Connection: ${err.message}`);
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
  errorLogged = false;
  const result = await runLoadTest(targetRps, CONFIG.testDuration);
  
  process.stdout.write(" cooldown...");
  await sleep(CONFIG.cooldownDuration);
  
  console.log(` Done (${result.requests.total} reqs, ${result.errorRate}% err, p95: ${result.latency?.p95 || 'N/A'}ms)`);
  return result;
}

async function runLoadLevel(targetRps, poolSize) {
  log(`Testing ${targetRps} req/s`, "STEP");
  
  const iterations = [];
  for (let i = 1; i <= CONFIG.runs; i++) {
    iterations.push(await runIteration(targetRps, i, CONFIG.runs));
  }
  
  const aggregated = {
    targetRps,
    poolSize,
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
    errors: Object.assign({}, ...iterations.map(r => r.errors)),
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
// POOL SIZE TEST
// ═══════════════════════════════════════════════════════════════════════════

async function runPoolSizeTests(poolSize) {
  console.log('\n' + '═'.repeat(70));
  log(`TESTING POOL SIZE: ${poolSize}`, "INFO");
  console.log('═'.repeat(70));
  
  // Cleanup
  cleanupDatabase();
  
  // Start app
  try {
    await startApp(poolSize);
  } catch (err) {
    log(`Failed to start app: ${err.message}`, "ERROR");
    return null;
  }
  
  await sleep(3);
  
  // Pre-flight check
  log("Pre-flight check...", "STEP");
  errorLogged = false;
  const testResult = await sendRequest();
  if (!testResult.success) {
    log("Pre-flight FAILED", "ERROR");
    stopApp();
    return null;
  }
  log("Pre-flight PASSED", "SUCCESS");
  
  // Run tests
  const results = {
    poolSize,
    loadLevels: {},
    maxSustainableRps: 0,
    breakingPoint: null
  };
  
  let previousFailed = false;
  
  for (const rps of CONFIG.loadLevels) {
    if (previousFailed) {
      log(`Skipping ${rps} req/s (previous failed)`, "WARNING");
      break;
    }
    
    errorLogged = false;
    const result = await runLoadLevel(rps, poolSize);
    results.loadLevels[rps] = result;
    
    if (result.meetsThresholds) {
      results.maxSustainableRps = rps;
    } else if (!results.breakingPoint) {
      results.breakingPoint = { rps, errorRate: result.errorRate.mean, p95: result.latency.p95.mean };
    }
    
    if (result.errorRate.mean > 50) {
      log(`Error rate > 50%, stopping`, "WARNING");
      previousFailed = true;
    }
    
    await sleep(5);
  }
  
  // Cleanup
  stopApp();
  cleanupDatabase();
  
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════════

function generateReport(allResults, startTime, endTime) {
  let bestConfig = { poolSize: 0, maxRps: 0 };
  for (const [poolSize, data] of Object.entries(allResults)) {
    if (data && data.maxSustainableRps > bestConfig.maxRps) {
      bestConfig = { poolSize: parseInt(poolSize), maxRps: data.maxSustainableRps };
    }
  }
  
  return {
    metadata: {
      name: CONFIG.name,
      version: CONFIG.version,
      adapter: CONFIG.adapter,
      timestamp: startTime.toISOString(),
      endTime: endTime.toISOString(),
      duration: `${Math.round((endTime - startTime) / 1000 / 60)} minutes`
    },
    systemInfo,
    configuration: {
      poolSizesTested: CONFIG.poolSizes,
      loadLevelsTested: CONFIG.loadLevels,
      runs: CONFIG.runs,
      warmupDuration: CONFIG.warmupDuration,
      testDuration: CONFIG.testDuration,
      cooldownDuration: CONFIG.cooldownDuration,
      thresholds: CONFIG.thresholds
    },
    results: allResults,
    analysis: {
      bestConfiguration: bestConfig,
      comparisonByPoolSize: Object.entries(allResults).map(([poolSize, data]) => ({
        poolSize: parseInt(poolSize),
        maxSustainableRps: data?.maxSustainableRps || 0,
        breakingPoint: data?.breakingPoint || null,
        throughputPerHour: (data?.maxSustainableRps || 0) * 3600
      }))
    }
  };
}

function saveReport(report) {
  const ts = report.metadata.timestamp.replace(/[:.]/g, '-');
  const jsonFile = `benchmark-postgres-${ts}.json`;
  const mdFile = `benchmark-postgres-${ts}.md`;
  
  fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2));
  log(`JSON saved: ${jsonFile}`, "SUCCESS");
  
  // Generate markdown
  let md = `# ${report.metadata.name}

## Summary

| Metric | Value |
|--------|-------|
| **Best Pool Size** | ${report.analysis.bestConfiguration.poolSize} |
| **Max Throughput** | ${report.analysis.bestConfiguration.maxRps} req/s |
| **Hourly Capacity** | ${(report.analysis.bestConfiguration.maxRps * 3600).toLocaleString()} orders |
| **Test Duration** | ${report.metadata.duration} |

## System

| Component | Value |
|-----------|-------|
| CPU | ${report.systemInfo.cpu.model} (${report.systemInfo.cpu.cores.logical} cores) |
| Memory | ${report.systemInfo.memory.total} |
| OS | ${report.systemInfo.os.name || report.systemInfo.os.type} |
| PostgreSQL | ${report.systemInfo.database.version || 'Unknown'} |

## Results by Pool Size

| Pool Size | Max RPS | Breaking Point | Hourly |
|-----------|---------|----------------|--------|
`;

  for (const row of report.analysis.comparisonByPoolSize) {
    md += `| ${row.poolSize} | ${row.maxSustainableRps} req/s | ${row.breakingPoint?.rps || 'N/A'} req/s | ${row.throughputPerHour.toLocaleString()} |\n`;
  }

  for (const [poolSize, data] of Object.entries(report.results)) {
    if (!data) continue;
    md += `\n## Pool Size: ${poolSize}\n\n| Load | Actual RPS | Error % | p95 | Status |\n|------|------------|---------|-----|--------|\n`;
    for (const [rps, r] of Object.entries(data.loadLevels)) {
      const st = r.meetsThresholds ? '✅' : '❌';
      md += `| ${rps} | ${r.actualRps.mean} ± ${r.actualRps.margin} | ${r.errorRate.mean}% | ${r.latency.p95.mean}ms | ${st} |\n`;
    }
  }

  md += `\n---\n*Generated: ${report.metadata.timestamp}*\n`;
  
  fs.writeFileSync(mdFile, md);
  log(`Markdown saved: ${mdFile}`, "SUCCESS");
  
  return { jsonFile, mdFile };
}

function printSummary(report) {
  console.log('\n' + '═'.repeat(70));
  console.log('  BENCHMARK COMPLETE');
  console.log('═'.repeat(70));
  
  console.log('\n  Results by Pool Size:');
  console.log('  ' + '─'.repeat(50));
  
  for (const row of report.analysis.comparisonByPoolSize) {
    const bar = '█'.repeat(Math.min(Math.round(row.maxSustainableRps / 10), 30));
    console.log(`  Pool ${row.poolSize.toString().padStart(2)}: ${row.maxSustainableRps.toString().padStart(3)} req/s ${bar}`);
  }
  
  console.log('\n  ' + '─'.repeat(50));
  console.log(`  🏆 Best: Pool Size ${report.analysis.bestConfiguration.poolSize}`);
  console.log(`     Throughput: ${report.analysis.bestConfiguration.maxRps} req/s`);
  console.log(`     Hourly: ${(report.analysis.bestConfiguration.maxRps * 3600).toLocaleString()} orders`);
  console.log('\n' + '═'.repeat(70));
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const startTime = new Date();
  
  console.log('\n' + '═'.repeat(70));
  console.log('  ' + CONFIG.name);
  console.log('═'.repeat(70));
  console.log(`  Adapter:      ${CONFIG.adapter}`);
  console.log(`  Database:     ${CONFIG.database.database}`);
  console.log(`  Port:         ${CONFIG.app.port}`);
  console.log(`  Pool sizes:   ${CONFIG.poolSizes.join(', ')}`);
  console.log(`  Load levels:  ${CONFIG.loadLevels.join(', ')} req/s`);
  console.log(`  Runs/level:   ${CONFIG.runs}`);
  console.log(`  Est. time:    ~${Math.round(CONFIG.poolSizes.length * CONFIG.loadLevels.length * CONFIG.runs * (CONFIG.warmupDuration + CONFIG.testDuration + CONFIG.cooldownDuration) / 60)} minutes`);
  console.log('═'.repeat(70));
  
  // System info
  systemInfo = collectSystemInfo();
  printSystemInfo(systemInfo);
  
  // Ensure tables exist
  ensureTablesExist();
  
  // Run all pool sizes
  for (const poolSize of CONFIG.poolSizes) {
    const result = await runPoolSizeTests(poolSize);
    if (result) {
      allResults[poolSize] = result;
    }
    
    log("Pausing before next pool size...", "INFO");
    await sleep(10);
  }
  
  const endTime = new Date();
  
  // Generate report
  log("Generating report...", "STEP");
  const report = generateReport(allResults, startTime, endTime);
  saveReport(report);
  printSummary(report);
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\nInterrupted! Cleaning up...');
  stopApp();
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('\n\nTerminated! Cleaning up...');
  stopApp();
  process.exit(1);
});

// Run
main().catch(err => {
  console.error("Benchmark failed:", err);
  stopApp();
  process.exit(1);
});
