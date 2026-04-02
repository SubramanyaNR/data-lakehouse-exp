const http    = require('http');
const { spawn, execSync } = require('child_process');
const fs      = require('fs');
const os      = require('os');

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  name:    "Restaurant App - Kafka Benchmark",
  version: "1.0.0",
  adapter: "kafka",

  app: {
    script:         "server.js",
    host:           "localhost",
    port:           3001,
    testEndpoint:   "/place-order",
    startupTimeout: 90   // seconds — consumer needs to replay topics
  },

  kafka: {
    broker:        process.env.KAFKA_BROKER || "localhost:9092",
    pod:           "my-cluster-dual-role-0",
    namespace:     "kafka",
    consumerGroup: "restaurant-python-consumer",
    orderTopics:   ["restaurant.orders", "restaurant.order-status"]
  },

  // Same load levels as the PostgreSQL benchmark for direct comparison
  loadLevels: [10, 25, 50, 100, 200, 300],

  // Same test parameters as PG benchmark
  runs:             3,
  warmupDuration:   20,  // seconds
  testDuration:     60,  // seconds
  cooldownDuration: 10,  // seconds

  // Same thresholds as PG benchmark
  thresholds: {
    maxErrorRate:   0.05,   // 5%
    maxP95Latency:  1000,   // ms
    maxP99Latency:  2000    // ms
  },

  debug: true
};

// ═══════════════════════════════════════════════════════════════════════════
// GLOBALS
// ═══════════════════════════════════════════════════════════════════════════

let appProcess  = null;
let systemInfo  = null;
let errorLogged = false;

// ═══════════════════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════════════════

function log(msg, level = "INFO") {
  const ts     = new Date().toISOString().substr(11, 8);
  const prefix = { INFO: "ℹ️ ", SUCCESS: "✅", WARNING: "⚠️ ", ERROR: "❌", STEP: "▶ ", RESULT: "📊" }[level] || "  ";
  console.log(`[${ts}] ${prefix} ${msg}`);
}

function sleep(sec) { return new Promise(r => setTimeout(r, sec * 1000)); }

function execCmd(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', shell: '/bin/bash', stdio: 'pipe', timeout: 30000 }).trim();
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// SYSTEM INFO
// ═══════════════════════════════════════════════════════════════════════════

function collectSystemInfo() {
  log("Collecting system info...", "STEP");
  const cpus     = os.cpus();
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();

  const df   = execCmd('df -h / | tail -1');
  const dfParts = df ? df.split(/\s+/) : [];
  const rotational = execCmd('cat /sys/block/sda/queue/rotational 2>/dev/null');

  let kafkaInfo = { available: false };
  const kv = execCmd(`kubectl exec ${CONFIG.kafka.pod} -n ${CONFIG.kafka.namespace} -- bin/kafka-topics.sh --bootstrap-server localhost:9092 --list 2>/dev/null`);
  if (kv !== null) {
    kafkaInfo.available = true;
    kafkaInfo.topics    = kv.split('\n').filter(Boolean);
  }

  return {
    collectedAt: new Date().toISOString(),
    host: { hostname: os.hostname(), platform: os.platform(), arch: os.arch() },
    cpu: {
      model:       cpus[0]?.model || 'Unknown',
      cores:       { logical: cpus.length },
      loadAverage: os.loadavg().map(l => l.toFixed(2)).join(' / ')
    },
    memory: {
      total: (totalMem / 1073741824).toFixed(2) + ' GB',
      free:  (freeMem  / 1073741824).toFixed(2) + ' GB',
      usage: ((1 - freeMem / totalMem) * 100).toFixed(1) + '%'
    },
    disk: {
      size:  dfParts[1] || 'Unknown',
      avail: dfParts[3] || 'Unknown',
      type:  rotational === '0' ? 'SSD' : rotational === '1' ? 'HDD' : 'Unknown'
    },
    runtime: { node: process.version },
    kafka: kafkaInfo
  };
}

function printSystemInfo(info) {
  console.log('\n' + '═'.repeat(70));
  console.log('  SYSTEM INFORMATION');
  console.log('═'.repeat(70));
  console.log(`  Host:    ${info.host.hostname} (${info.host.platform} ${info.host.arch})`);
  console.log(`  CPU:     ${info.cpu.model} (${info.cpu.cores.logical} cores)`);
  console.log(`  Memory:  ${info.memory.total} total, ${info.memory.usage} used`);
  console.log(`  Disk:    ${info.disk.size} (${info.disk.type})`);
  console.log(`  Node.js: ${info.runtime.node}`);
  if (info.kafka.available) console.log(`  Kafka:   ${info.kafka.topics?.length || 0} topics`);
  console.log('═'.repeat(70));
}

// ═══════════════════════════════════════════════════════════════════════════
// KAFKA CLEANUP
// Resets the consumer group offsets to --to-latest so that on next startup
// consumer.py skips all benchmark orders and only sees pre-benchmark state.
// This is the Kafka equivalent of TRUNCATE on the orders tables.
// ═══════════════════════════════════════════════════════════════════════════

function cleanupKafka() {
  log("Resetting Kafka consumer group offsets to latest (cleanup)...", "STEP");

  for (const topic of CONFIG.kafka.orderTopics) {
    const cmd = `kubectl exec ${CONFIG.kafka.pod} -n ${CONFIG.kafka.namespace} -- ` +
      `bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 ` +
      `--group ${CONFIG.kafka.consumerGroup} --topic ${topic} ` +
      `--reset-offsets --to-latest --execute 2>/dev/null`;
    const result = execCmd(cmd);
    if (result !== null) {
      log(`  ${topic} → offsets reset to latest`, "SUCCESS");
    } else {
      log(`  ${topic} → reset skipped (group may not exist yet)`, "WARNING");
    }
  }
}

function getKafkaTopicMessageCount(topic) {
  // Sum of end offsets across all partitions = total messages in topic
  const cmd = `kubectl exec ${CONFIG.kafka.pod} -n ${CONFIG.kafka.namespace} -- ` +
    `bin/kafka-get-offsets.sh --bootstrap-server localhost:9092 ` +
    `--topic ${topic} --time -1 2>/dev/null`;
  const result = execCmd(cmd);
  if (!result) return 0;
  return result.split('\n')
    .filter(Boolean)
    .reduce((sum, line) => sum + (parseInt(line.split(':')[2]) || 0), 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// APPLICATION
// ═══════════════════════════════════════════════════════════════════════════

async function startApp() {
  log("Starting server.js (will auto-spawn producer + consumer)...", "STEP");

  execCmd(`lsof -ti:${CONFIG.app.port} | xargs kill -9 2>/dev/null || true`);
  await sleep(2);

  const env = {
    ...process.env,
    PORT:         CONFIG.app.port.toString(),
    DB_ADAPTER:   "kafka",
    KAFKA_BROKER: CONFIG.kafka.broker
  };

  return new Promise((resolve, reject) => {
    appProcess = spawn('node', [CONFIG.app.script], {
      env,
      stdio:    ['ignore', 'pipe', 'pipe'],
      detached: false
    });

    let ready = false;

    appProcess.stdout.on('data', d => {
      const text = d.toString();
      if (CONFIG.debug) process.stdout.write(`  [app] ${text}`);
      if (!ready && text.includes('consumer service ready')) {
        ready = true;
        log("App ready (Kafka consumer replayed all topics)", "SUCCESS");
        setTimeout(() => resolve(true), 1000);
      }
    });

    appProcess.stderr.on('data', d => {
      const text = d.toString();
      // Only log non-kafkajs noise
      if (!text.includes('"level"') && CONFIG.debug) process.stderr.write(`  [app] ${text}`);
    });

    appProcess.on('error', err => { log("Failed to start app: " + err.message, "ERROR"); reject(err); });

    setTimeout(() => {
      if (!ready) {
        log(`App did not become ready within ${CONFIG.app.startupTimeout}s`, "ERROR");
        reject(new Error("Startup timeout"));
      }
    }, CONFIG.app.startupTimeout * 1000);
  });
}

function stopApp() {
  log("Stopping application...", "STEP");
  if (appProcess) { appProcess.kill('SIGTERM'); appProcess = null; }
  execCmd(`lsof -ti:${CONFIG.app.port} | xargs kill -9 2>/dev/null || true`);
  log("Application stopped", "SUCCESS");
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST DATA
// ═══════════════════════════════════════════════════════════════════════════

const MENU = [
  { name: 'Masala Dosa',     price: 80  },
  { name: 'Plain Dosa',      price: 60  },
  { name: 'Idli',            price: 40  },
  { name: 'Vada',            price: 50  },
  { name: 'Filter Coffee',   price: 30  },
  { name: 'Paneer Tikka',    price: 160 },
  { name: 'Gobi Manchurian', price: 120 },
  { name: 'Upma',            price: 45  }
];

function generateOrder() {
  const count = Math.floor(Math.random() * 4) + 1;
  const items = Array.from({ length: count }, () => {
    const item = MENU[Math.floor(Math.random() * MENU.length)];
    return { name: item.name, price: item.price, qty: Math.floor(Math.random() * 3) + 1 };
  });
  return {
    items,
    tableNumber:  Math.floor(Math.random() * 30) + 1,
    customerName: `Bench-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTP CLIENT
// ═══════════════════════════════════════════════════════════════════════════

function sendRequest() {
  return new Promise(resolve => {
    const data  = JSON.stringify(generateOrder());
    const start = process.hrtime.bigint();

    const req = http.request({
      hostname: CONFIG.app.host,
      port:     CONFIG.app.port,
      path:     CONFIG.app.testEndpoint,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout:  30000
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        const latency = Number(process.hrtime.bigint() - start) / 1e6;
        if (res.statusCode !== 200 && !errorLogged && CONFIG.debug) {
          console.log(`\n[DEBUG] ${res.statusCode}: ${body.substring(0, 300)}`);
          errorLogged = true;
        }
        resolve({ success: res.statusCode === 200, statusCode: res.statusCode, latency });
      });
    });

    req.on('error', err => {
      const latency = Number(process.hrtime.bigint() - start) / 1e6;
      if (!errorLogged && CONFIG.debug) { console.log(`\n[DEBUG] ${err.message}`); errorLogged = true; }
      resolve({ success: false, error: err.message, latency });
    });

    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'timeout', latency: 30000 }); });
    req.write(data);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// STATISTICS  (identical to PG benchmark)
// ═══════════════════════════════════════════════════════════════════════════

function calcStats(latencies) {
  if (!latencies.length) return null;
  const sorted = [...latencies].sort((a, b) => a - b);
  const mean   = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const pct    = p => Math.round(sorted[Math.floor(sorted.length * p)] * 100) / 100;
  return {
    count:  sorted.length,
    min:    Math.round(sorted[0] * 100) / 100,
    max:    Math.round(sorted[sorted.length - 1] * 100) / 100,
    mean:   Math.round(mean * 100) / 100,
    stdDev: Math.round(Math.sqrt(sorted.map(x => (x - mean) ** 2).reduce((a, b) => a + b, 0) / sorted.length) * 100) / 100,
    p50:    pct(0.50), p90: pct(0.90), p95: pct(0.95), p99: pct(0.99)
  };
}

function calcCI(values) {
  if (!values.length) return { mean: 0, margin: 0 };
  const mean   = values.reduce((a, b) => a + b, 0) / values.length;
  const stdDev = Math.sqrt(values.map(x => (x - mean) ** 2).reduce((a, b) => a + b, 0) / (values.length - 1 || 1));
  return { mean: Math.round(mean * 100) / 100, margin: Math.round(1.96 * stdDev / Math.sqrt(values.length) * 100) / 100 };
}

// ═══════════════════════════════════════════════════════════════════════════
// LOAD TEST
// ═══════════════════════════════════════════════════════════════════════════

async function runLoadTest(targetRps, duration) {
  const results   = { success: 0, failed: 0, latencies: [], errors: {} };
  const startTime = Date.now();
  const endTime   = startTime + duration * 1000;
  const pending   = [];
  let   lastReq   = startTime;

  while (Date.now() < endTime) {
    const now = Date.now();
    if (now - lastReq >= 1000 / targetRps) {
      pending.push(sendRequest().then(r => {
        if (r.success) results.success++;
        else { results.failed++; const k = r.error || `HTTP_${r.statusCode}`; results.errors[k] = (results.errors[k] || 0) + 1; }
        results.latencies.push(r.latency);
      }));
      lastReq = now;
    }
    await new Promise(r => setTimeout(r, 1));
  }

  await Promise.all(pending);
  const actualDuration = (Date.now() - startTime) / 1000;
  return {
    targetRps,
    actualRps: Math.round(results.latencies.length / actualDuration * 100) / 100,
    requests:  { total: results.success + results.failed, success: results.success, failed: results.failed },
    errorRate: Math.round(results.failed / Math.max(results.success + results.failed, 1) * 10000) / 100,
    errors:    results.errors,
    latency:   calcStats(results.latencies)
  };
}

async function runIteration(targetRps, iter, total) {
  process.stdout.write(`      Iter ${iter}/${total}: warmup...`);
  await runLoadTest(targetRps, CONFIG.warmupDuration);
  process.stdout.write(" test...");
  errorLogged = false;
  const result = await runLoadTest(targetRps, CONFIG.testDuration);
  process.stdout.write(" cooldown...");
  await sleep(CONFIG.cooldownDuration);
  console.log(` Done (${result.requests.total} reqs, ${result.errorRate}% err, p95: ${result.latency?.p95 ?? 'N/A'}ms)`);
  return result;
}

async function runLoadLevel(targetRps) {
  log(`Testing ${targetRps} req/s`, "STEP");
  const iterations = [];
  for (let i = 1; i <= CONFIG.runs; i++) iterations.push(await runIteration(targetRps, i, CONFIG.runs));

  const agg = {
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
      success:  iterations.reduce((s, r) => s + r.requests.success, 0),
      failed:   iterations.reduce((s, r) => s + r.requests.failed, 0)
    },
    meetsThresholds: iterations.every(r =>
      r.errorRate <= CONFIG.thresholds.maxErrorRate * 100 &&
      (r.latency?.p95 || 0) <= CONFIG.thresholds.maxP95Latency
    ),
    rawIterations: iterations
  };

  const status = agg.meetsThresholds ? "✅ PASS" : "❌ FAIL";
  log(`${targetRps} req/s → actual: ${agg.actualRps.mean} rps | err: ${agg.errorRate.mean}% | p95: ${agg.latency.p95.mean}ms  ${status}`, "RESULT");
  return agg;
}

// ═══════════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════════

function saveReport(report) {
  const ts       = report.metadata.timestamp.replace(/[:.]/g, '-');
  const jsonFile = `benchmark-kafka-${ts}.json`;
  const mdFile   = `benchmark-kafka-${ts}.md`;

  fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2));
  log(`JSON saved: ${jsonFile}`, "SUCCESS");

  let md = `# ${report.metadata.name}\n\n`;
  md += `## Summary\n\n`;
  md += `| Metric | Value |\n|--------|-------|\n`;
  md += `| **Adapter** | Kafka (event-sourced) |\n`;
  md += `| **Max Sustainable RPS** | ${report.analysis.maxSustainableRps} req/s |\n`;
  md += `| **Breaking Point** | ${report.analysis.breakingPoint?.rps ?? 'N/A'} req/s |\n`;
  md += `| **Hourly Capacity** | ${(report.analysis.maxSustainableRps * 3600).toLocaleString()} orders |\n`;
  md += `| **Test Duration** | ${report.metadata.duration} |\n\n`;

  md += `## System\n\n`;
  md += `| Component | Value |\n|-----------|-------|\n`;
  md += `| CPU | ${report.systemInfo.cpu.model} (${report.systemInfo.cpu.cores.logical} cores) |\n`;
  md += `| Memory | ${report.systemInfo.memory.total} |\n`;
  md += `| Disk | ${report.systemInfo.disk.size} (${report.systemInfo.disk.type}) |\n`;
  md += `| Kafka Broker | ${report.metadata.kafkaBroker} |\n\n`;

  md += `## Results\n\n`;
  md += `| Target RPS | Actual RPS | Error % | p50 | p95 | p99 | Status |\n`;
  md += `|------------|------------|---------|-----|-----|-----|--------|\n`;

  for (const [rps, r] of Object.entries(report.results.loadLevels)) {
    const st = r.meetsThresholds ? '✅' : '❌';
    md += `| ${rps} | ${r.actualRps.mean} ± ${r.actualRps.margin} | ${r.errorRate.mean}% | ${r.latency.p50.mean}ms | ${r.latency.p95.mean}ms | ${r.latency.p99.mean}ms | ${st} |\n`;
  }

  md += `\n---\n*Generated: ${report.metadata.timestamp}*\n`;

  fs.writeFileSync(mdFile, md);
  log(`Markdown saved: ${mdFile}`, "SUCCESS");
  return { jsonFile, mdFile };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const startTime = new Date();

  console.log('\n' + '═'.repeat(70));
  console.log('  ' + CONFIG.name);
  console.log('═'.repeat(70));
  console.log(`  Broker:       ${CONFIG.kafka.broker}`);
  console.log(`  Endpoint:     http://localhost:${CONFIG.app.port}${CONFIG.app.testEndpoint}`);
  console.log(`  Load levels:  ${CONFIG.loadLevels.join(', ')} req/s`);
  console.log(`  Runs/level:   ${CONFIG.runs} × (${CONFIG.warmupDuration}s warmup + ${CONFIG.testDuration}s test + ${CONFIG.cooldownDuration}s cooldown)`);
  console.log(`  Est. time:    ~${Math.round(CONFIG.loadLevels.length * CONFIG.runs * (CONFIG.warmupDuration + CONFIG.testDuration + CONFIG.cooldownDuration) / 60)} minutes`);
  console.log('═'.repeat(70));

  systemInfo = collectSystemInfo();
  printSystemInfo(systemInfo);

  // Start app
  try {
    await startApp();
  } catch (err) {
    log("Failed to start app: " + err.message, "ERROR");
    log("Make sure port-forward2.sh is running (Kafka on localhost:9092)", "ERROR");
    process.exit(1);
  }

  await sleep(2);

  // Pre-flight
  log("Pre-flight check...", "STEP");
  errorLogged = false;
  const pf = await sendRequest();
  if (!pf.success) {
    log("Pre-flight FAILED", "ERROR");
    stopApp();
    process.exit(1);
  }
  log(`Pre-flight PASSED (${pf.latency.toFixed(0)}ms)`, "SUCCESS");

  // Note message count before test
  const ordersBefore = getKafkaTopicMessageCount('restaurant.orders');
  log(`Messages in restaurant.orders before test: ${ordersBefore}`, "INFO");

  // Run all load levels
  const results = { loadLevels: {}, maxSustainableRps: 0, breakingPoint: null };

  for (const rps of CONFIG.loadLevels) {
    errorLogged = false;
    const result = await runLoadLevel(rps);
    results.loadLevels[rps] = result;

    if (result.meetsThresholds) results.maxSustainableRps = rps;
    else if (!results.breakingPoint) results.breakingPoint = { rps, errorRate: result.errorRate.mean, p95: result.latency.p95.mean };

    if (result.errorRate.mean > 50) { log("Error rate >50% — stopping early", "WARNING"); break; }
    await sleep(5);
  }

  const ordersAfter = getKafkaTopicMessageCount('restaurant.orders');
  log(`Messages written during test: ${ordersAfter - ordersBefore}`, "INFO");

  // Cleanup — stop app then reset consumer group offsets so benchmark
  // orders are skipped on next consumer startup
  stopApp();
  await sleep(3);  // let consumer group session expire before reset
  cleanupKafka();

  const endTime = new Date();

  // Build and save report
  const report = {
    metadata: {
      name:        CONFIG.name,
      version:     CONFIG.version,
      adapter:     CONFIG.adapter,
      kafkaBroker: CONFIG.kafka.broker,
      timestamp:   startTime.toISOString(),
      endTime:     endTime.toISOString(),
      duration:    `${Math.round((endTime - startTime) / 60000)} minutes`
    },
    systemInfo,
    configuration: {
      loadLevels:       CONFIG.loadLevels,
      runs:             CONFIG.runs,
      warmupDuration:   CONFIG.warmupDuration,
      testDuration:     CONFIG.testDuration,
      cooldownDuration: CONFIG.cooldownDuration,
      thresholds:       CONFIG.thresholds
    },
    results,
    analysis: {
      maxSustainableRps: results.maxSustainableRps,
      breakingPoint:     results.breakingPoint,
      throughputPerHour: results.maxSustainableRps * 3600
    }
  };

  const { jsonFile, mdFile } = saveReport(report);

  // Print summary
  console.log('\n' + '═'.repeat(70));
  console.log('  BENCHMARK COMPLETE');
  console.log('═'.repeat(70));
  console.log(`\n  Adapter:             Kafka (event-sourced)`);
  console.log(`  Max Sustainable RPS: ${results.maxSustainableRps} req/s`);
  console.log(`  Breaking Point:      ${results.breakingPoint?.rps ?? 'N/A'} req/s`);
  console.log(`  Hourly Capacity:     ${(results.maxSustainableRps * 3600).toLocaleString()} orders`);
  console.log(`\n  Results:`);

  for (const [rps, r] of Object.entries(results.loadLevels)) {
    const bar = '█'.repeat(Math.min(Math.round(r.actualRps.mean / 10), 30));
    const st  = r.meetsThresholds ? '✅' : '❌';
    console.log(`  ${String(rps).padStart(3)} req/s → ${String(r.actualRps.mean).padStart(6)} rps  p95: ${String(r.latency.p95.mean).padStart(6)}ms  ${st}  ${bar}`);
  }

  console.log(`\n  Reports: ${jsonFile}`);
  console.log(`           ${mdFile}`);
  console.log('═'.repeat(70));
}

process.on('SIGINT',  () => { console.log('\nInterrupted — cleaning up...'); stopApp(); process.exit(1); });
process.on('SIGTERM', () => { console.log('\nTerminated — cleaning up...'); stopApp(); process.exit(1); });

main().catch(err => { console.error("Benchmark failed:", err.message); stopApp(); process.exit(1); });
