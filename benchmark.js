const http = require('http');

const CONFIG = {
  host: process.env.TARGET_HOST || 'localhost',
  port: process.env.TARGET_PORT || 3001,
  phases: [
    { duration: 30, rps: 10, name: 'Warm-up' },
    { duration: 60, rps: 50, name: 'Light' },
    { duration: 60, rps: 100, name: 'Medium' },
    { duration: 60, rps: 200, name: 'Heavy' },
    { duration: 60, rps: 300, name: 'Stress' },
    { duration: 30, rps: 10, name: 'Cool-down' }
  ]
};

const menuItems = [
  { name: 'Masala Dosa', price: 80 },
  { name: 'Plain Dosa', price: 60 },
  { name: 'Idli', price: 40 },
  { name: 'Filter Coffee', price: 30 }
];

let stats = { total: 0, success: 0, failed: 0, times: [] };

function placeOrder() {
  return new Promise((resolve) => {
    const items = [];
    for (let i = 0; i < Math.floor(Math.random() * 3) + 1; i++) {
      const item = menuItems[Math.floor(Math.random() * menuItems.length)];
      items.push({ name: item.name, price: item.price, qty: Math.floor(Math.random() * 2) + 1 });
    }

    const data = JSON.stringify({
      items,
      tableNumber: Math.floor(Math.random() * 20) + 1,
      customerName: 'LoadTest-' + Date.now()
    });

    const start = Date.now();

    const req = http.request({
      hostname: CONFIG.host,
      port: CONFIG.port,
      path: '/place-order',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        stats.total++;
        stats.times.push(Date.now() - start);
        res.statusCode === 200 ? stats.success++ : stats.failed++;
        resolve();
      });
    });

    req.on('error', () => { stats.total++; stats.failed++; resolve(); });
    req.write(data);
    req.end();
  });
}

async function runPhase(phase) {
  console.log(`\n▶ ${phase.name}: ${phase.rps} req/s for ${phase.duration}s`);
  
  const phaseStats = { total: 0, success: 0, failed: 0, times: [] };
  const startTime = Date.now();
  const endTime = startTime + phase.duration * 1000;
  const interval = 1000 / phase.rps;
  
  let lastReq = startTime;
  
  while (Date.now() < endTime) {
    if (Date.now() - lastReq >= interval) {
      const before = stats.total;
      placeOrder().then(() => {
        phaseStats.total++;
        if (stats.success > before) phaseStats.success++;
        else phaseStats.failed++;
      });
      lastReq = Date.now();
    }
    await new Promise(r => setTimeout(r, 1));
  }
  
  await new Promise(r => setTimeout(r, 2000));
  
  const phaseTimes = stats.times.slice(-phaseStats.total);
  const sorted = [...phaseTimes].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
  const actualRps = (phaseStats.total / phase.duration).toFixed(1);
  const errorRate = ((phaseStats.failed / phaseStats.total) * 100).toFixed(2);
  
  console.log(`  ✓ ${phaseStats.total} requests | ${actualRps} req/s | ${errorRate}% errors | p95: ${p95}ms | p99: ${p99}ms`);
  
  return { phase: phase.name, rps: actualRps, errors: errorRate, p95, p99 };
}

async function run() {
  console.log('════════════════════════════════════════');
  console.log('  PostgreSQL Benchmark');
  console.log(`  Target: ${CONFIG.host}:${CONFIG.port}`);
  console.log('════════════════════════════════════════');
  
  const results = [];
  for (const phase of CONFIG.phases) {
    results.push(await runPhase(phase));
  }
  
  console.log('\n════════════════════════════════════════');
  console.log('  Results Summary');
  console.log('════════════════════════════════════════');
  console.log(`  Total: ${stats.total} | Success: ${stats.success} | Failed: ${stats.failed}`);
  console.log(`  Error Rate: ${((stats.failed / stats.total) * 100).toFixed(2)}%`);
  
  const sorted = [...stats.times].sort((a, b) => a - b);
  console.log(`  p50: ${sorted[Math.floor(sorted.length * 0.5)]}ms`);
  console.log(`  p95: ${sorted[Math.floor(sorted.length * 0.95)]}ms`);
  console.log(`  p99: ${sorted[Math.floor(sorted.length * 0.99)]}ms`);
  
  const breaking = results.find(r => parseFloat(r.errors) > 5 || r.p95 > 1000);
  if (breaking) {
    console.log(`\n⚠️  Breaking point: ${breaking.phase} (${breaking.rps} req/s)`);
  }
  
  require('fs').writeFileSync('benchmark-results.json', JSON.stringify({ stats, results }, null, 2));
  console.log('\nSaved to benchmark-results.json');
}

run();
