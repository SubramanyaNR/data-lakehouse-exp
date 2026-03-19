const http = require('http');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  // Test identification
  name: "PostgreSQL Restaurant App - Comprehensive Benchmark Suite",
  version: "2.1.0",
  
  // Target application
  app: {
    script: "server.js",
    host: "localhost",
    port: 3001,
    healthEndpoint: "/health",
    testEndpoint: "/place-order"
  },
  
  // Database
  database: {
    namespace: "postgres",
    podName: "postgresql-0",
    serviceName: "postgresql",
    user: "postgres",
    database: "restaurant"
  },
  
  // Pool sizes to test
  poolSizes: [10, 25, 50],
  
  // Load levels (req/s)
  loadLevels: [10, 25, 50, 75, 100, 125, 150, 175, 200, 250, 300],
  
  // Test parameters
  runs: 3,
  warmupDuration: 20,
  testDuration: 60,
  cooldownDuration: 10,
  appStartupWait: 5,
  
  // Success thresholds (SLA)
  thresholds: {
    maxErrorRate: 0.01,
    maxP95Latency: 500,
    maxP99Latency: 1000
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════════════

let appProcess = null;
let dbPassword = null;
let systemInfo = null;
const allResults = {};

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function log(message, level = "INFO") {
  const timestamp = new Date().toISOString().substr(11, 8);
  const prefix = {
    "INFO": "ℹ️ ",
    "SUCCESS": "✅",
    "WARNING": "⚠️ ",
    "ERROR": "❌",
    "STEP": "▶ ",
    "RESULT": "📊",
    "SYSTEM": "🖥️ "
  }[level] || "  ";
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

function sleep(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

function execCommand(cmd, silent = true) {
  try {
    const result = execSync(cmd, { 
      encoding: 'utf8', 
      shell: '/bin/bash',
      stdio: silent ? 'pipe' : 'inherit',
      timeout: 30000
    });
    return result.trim();
  } catch (err) {
    return null;
  }
}

function getDbPassword() {
  if (dbPassword) return dbPassword;
  try {
    const cmd = `kubectl get secret -n ${CONFIG.database.namespace} ${CONFIG.database.serviceName} -o jsonpath="{.data.postgres-password}" | base64 -d`;
    dbPassword = execCommand(cmd);
    return dbPassword;
  } catch (err) {
    log("Failed to get database password: " + err.message, "ERROR");
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SYSTEM INFORMATION COLLECTION
// ═══════════════════════════════════════════════════════════════════════════

function collectSystemInfo() {
  log("Collecting system information...", "SYSTEM");
  
  const info = {
    collectedAt: new Date().toISOString(),
    host: collectHostInfo(),
    cpu: collectCpuInfo(),
    memory: collectMemoryInfo(),
    disk: collectDiskInfo(),
    network: collectNetworkInfo(),
    os: collectOsInfo(),
    runtime: collectRuntimeInfo(),
    kubernetes: collectKubernetesInfo(),
    postgresql: collectPostgresInfo(),
    application: collectApplicationInfo()
  };
  
  return info;
}

function collectHostInfo() {
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    uptime: formatUptime(os.uptime()),
    uptimeSeconds: os.uptime()
  };
}

function collectCpuInfo() {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model || 'Unknown';
  const cpuSpeed = cpus[0]?.speed || 0;
  
  // Get CPU load
  const loadAvg = os.loadavg();
  
  // Try to get more detailed CPU info on Linux
  let cpuDetails = {};
  if (os.platform() === 'linux') {
    const cpuinfo = execCommand('cat /proc/cpuinfo | grep -E "^(model name|cpu MHz|cache size|cpu cores)" | head -8');
    if (cpuinfo) {
      const lines = cpuinfo.split('\n');
      lines.forEach(line => {
        const [key, value] = line.split(':').map(s => s.trim());
        if (key && value) {
          cpuDetails[key.replace(/ /g, '_')] = value;
        }
      });
    }
    
    // Get CPU usage
    const mpstat = execCommand('mpstat 1 1 2>/dev/null | tail -1 | awk \'{print 100-$NF}\'');
    if (mpstat) {
      cpuDetails.currentUsagePercent = parseFloat(mpstat);
    }
  }
  
  return {
    model: cpuModel,
    speed: `${cpuSpeed} MHz`,
    cores: {
      physical: countPhysicalCores(),
      logical: cpus.length
    },
    loadAverage: {
      '1min': loadAvg[0].toFixed(2),
      '5min': loadAvg[1].toFixed(2),
      '15min': loadAvg[2].toFixed(2)
    },
    details: cpuDetails
  };
}

function countPhysicalCores() {
  if (os.platform() === 'linux') {
    const result = execCommand('grep "^core id" /proc/cpuinfo | sort -u | wc -l');
    if (result) return parseInt(result) || os.cpus().length;
  }
  if (os.platform() === 'darwin') {
    const result = execCommand('sysctl -n hw.physicalcpu');
    if (result) return parseInt(result);
  }
  return os.cpus().length;
}

function collectMemoryInfo() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  
  let memDetails = {};
  
  if (os.platform() === 'linux') {
    const meminfo = execCommand('cat /proc/meminfo | head -10');
    if (meminfo) {
      const lines = meminfo.split('\n');
      lines.forEach(line => {
        const match = line.match(/^(\w+):\s+(\d+)/);
        if (match) {
          memDetails[match[1]] = formatBytes(parseInt(match[2]) * 1024);
        }
      });
    }
    
    // Get swap info
    const swap = execCommand('free -b | grep Swap | awk \'{print $2, $3, $4}\'');
    if (swap) {
      const [total, used, free] = swap.split(' ').map(Number);
      memDetails.swap = {
        total: formatBytes(total),
        used: formatBytes(used),
        free: formatBytes(free)
      };
    }
  }
  
  return {
    total: formatBytes(totalMem),
    totalBytes: totalMem,
    used: formatBytes(usedMem),
    usedBytes: usedMem,
    free: formatBytes(freeMem),
    freeBytes: freeMem,
    usagePercent: ((usedMem / totalMem) * 100).toFixed(2) + '%',
    details: memDetails
  };
}

function collectDiskInfo() {
  let diskInfo = { available: 'Unknown' };
  
  if (os.platform() === 'linux' || os.platform() === 'darwin') {
    const df = execCommand('df -h / | tail -1');
    if (df) {
      const parts = df.split(/\s+/);
      diskInfo = {
        filesystem: parts[0],
        size: parts[1],
        used: parts[2],
        available: parts[3],
        usagePercent: parts[4],
        mountpoint: parts[5]
      };
    }
    
    // Check if SSD or HDD
    const rootDevice = execCommand('df / | tail -1 | awk \'{print $1}\' | xargs basename 2>/dev/null | sed "s/[0-9]*$//"');
    if (rootDevice) {
      const rotational = execCommand(`cat /sys/block/${rootDevice}/queue/rotational 2>/dev/null`);
      diskInfo.type = rotational === '0' ? 'SSD' : (rotational === '1' ? 'HDD' : 'Unknown');
    }
    
    // Get I/O scheduler
    if (rootDevice) {
      const scheduler = execCommand(`cat /sys/block/${rootDevice}/queue/scheduler 2>/dev/null`);
      if (scheduler) {
        const active = scheduler.match(/\[(\w+)\]/);
        diskInfo.ioScheduler = active ? active[1] : scheduler;
      }
    }
  }
  
  return diskInfo;
}

function collectNetworkInfo() {
  const interfaces = os.networkInterfaces();
  const networkInfo = {
    interfaces: {}
  };
  
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (name === 'lo') continue;
    
    const ipv4 = addrs.find(a => a.family === 'IPv4' && !a.internal);
    const ipv6 = addrs.find(a => a.family === 'IPv6' && !a.internal);
    
    if (ipv4 || ipv6) {
      networkInfo.interfaces[name] = {
        ipv4: ipv4?.address,
        ipv6: ipv6?.address,
        mac: ipv4?.mac || ipv6?.mac
      };
    }
  }
  
  // Get primary IP
  const primaryIp = execCommand('hostname -I 2>/dev/null | awk \'{print $1}\'');
  if (primaryIp) {
    networkInfo.primaryIp = primaryIp;
  }
  
  return networkInfo;
}

function collectOsInfo() {
  const osInfo = {
    type: os.type(),
    platform: os.platform(),
    release: os.release(),
    version: os.version ? os.version() : 'N/A'
  };
  
  // Get distribution info on Linux
  if (os.platform() === 'linux') {
    const osRelease = execCommand('cat /etc/os-release 2>/dev/null | grep -E "^(NAME|VERSION|ID)=" | head -3');
    if (osRelease) {
      const lines = osRelease.split('\n');
      lines.forEach(line => {
        const match = line.match(/^(\w+)="?([^"]*)"?/);
        if (match) {
          osInfo[match[1].toLowerCase()] = match[2];
        }
      });
    }
    
    // Get kernel info
    const kernel = execCommand('uname -r');
    if (kernel) osInfo.kernel = kernel;
  }
  
  return osInfo;
}

function collectRuntimeInfo() {
  return {
    node: {
      version: process.version,
      v8: process.versions.v8,
      openssl: process.versions.openssl,
      platform: process.platform,
      arch: process.arch
    },
    npm: {
      version: execCommand('npm --version') || 'Unknown'
    },
    environment: {
      nodeEnv: process.env.NODE_ENV || 'development',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: Intl.DateTimeFormat().resolvedOptions().locale
    }
  };
}

function collectKubernetesInfo() {
  const k8sInfo = {
    available: false
  };
  
  // Check if kubectl is available
  const kubectlVersion = execCommand('kubectl version --client -o json 2>/dev/null');
  if (!kubectlVersion) return k8sInfo;
  
  try {
    const versionInfo = JSON.parse(kubectlVersion);
    k8sInfo.available = true;
    k8sInfo.clientVersion = versionInfo.clientVersion?.gitVersion || 'Unknown';
  } catch (e) {}
  
  // Get server version
  const serverVersion = execCommand('kubectl version -o json 2>/dev/null');
  if (serverVersion) {
    try {
      const info = JSON.parse(serverVersion);
      k8sInfo.serverVersion = info.serverVersion?.gitVersion || 'Unknown';
    } catch (e) {}
  }
  
  // Get cluster info
  const clusterInfo = execCommand('kubectl cluster-info 2>/dev/null | head -1');
  if (clusterInfo) {
    k8sInfo.clusterEndpoint = clusterInfo.replace(/\x1b\[[0-9;]*m/g, ''); // Remove ANSI colors
  }
  
  // Get node info
  const nodeInfo = execCommand('kubectl get nodes -o json 2>/dev/null');
  if (nodeInfo) {
    try {
      const nodes = JSON.parse(nodeInfo);
      k8sInfo.nodes = nodes.items.map(node => ({
        name: node.metadata.name,
        status: node.status.conditions.find(c => c.type === 'Ready')?.status === 'True' ? 'Ready' : 'NotReady',
        kubeletVersion: node.status.nodeInfo.kubeletVersion,
        os: node.status.nodeInfo.osImage,
        kernel: node.status.nodeInfo.kernelVersion,
        containerRuntime: node.status.nodeInfo.containerRuntimeVersion,
        cpu: node.status.capacity.cpu,
        memory: node.status.capacity.memory,
        pods: node.status.capacity.pods
      }));
    } catch (e) {}
  }
  
  // Get PostgreSQL pod info
  const pgPodInfo = execCommand(`kubectl get pod ${CONFIG.database.podName} -n ${CONFIG.database.namespace} -o json 2>/dev/null`);
  if (pgPodInfo) {
    try {
      const pod = JSON.parse(pgPodInfo);
      k8sInfo.postgresqlPod = {
        name: pod.metadata.name,
        namespace: pod.metadata.namespace,
        nodeName: pod.spec.nodeName,
        status: pod.status.phase,
        containers: pod.spec.containers.map(c => ({
          name: c.name,
          image: c.image,
          resources: c.resources
        })),
        startTime: pod.status.startTime
      };
    } catch (e) {}
  }
  
  return k8sInfo;
}

function collectPostgresInfo() {
  const pgInfo = {
    available: false
  };
  
  const password = getDbPassword();
  if (!password) return pgInfo;
  
  // Get PostgreSQL version
  const version = execCommand(`kubectl exec ${CONFIG.database.podName} -n ${CONFIG.database.namespace} -- env PGPASSWORD='${password}' psql -U ${CONFIG.database.user} -d ${CONFIG.database.database} -t -c "SELECT version();" 2>/dev/null`);
  if (version) {
    pgInfo.available = true;
    pgInfo.version = version.trim();
  }
  
  // Get key PostgreSQL settings
  const settings = [
    'max_connections',
    'shared_buffers',
    'effective_cache_size',
    'work_mem',
    'maintenance_work_mem',
    'checkpoint_completion_target',
    'wal_buffers',
    'default_statistics_target',
    'random_page_cost',
    'effective_io_concurrency',
    'max_wal_size',
    'min_wal_size'
  ];
  
  pgInfo.settings = {};
  
  for (const setting of settings) {
    const value = execCommand(`kubectl exec ${CONFIG.database.podName} -n ${CONFIG.database.namespace} -- env PGPASSWORD='${password}' psql -U ${CONFIG.database.user} -d ${CONFIG.database.database} -t -c "SHOW ${setting};" 2>/dev/null`);
    if (value) {
      pgInfo.settings[setting] = value.trim();
    }
  }
  
  // Get connection stats
  const connStats = execCommand(`kubectl exec ${CONFIG.database.podName} -n ${CONFIG.database.namespace} -- env PGPASSWORD='${password}' psql -U ${CONFIG.database.user} -d ${CONFIG.database.database} -t -c "SELECT count(*) as total, count(*) FILTER (WHERE state = 'active') as active, count(*) FILTER (WHERE state = 'idle') as idle FROM pg_stat_activity WHERE datname = '${CONFIG.database.database}';" 2>/dev/null`);
  if (connStats) {
    const [total, active, idle] = connStats.trim().split('|').map(s => parseInt(s.trim()));
    pgInfo.connections = { total, active, idle };
  }
  
  // Get table sizes
  const tableSizes = execCommand(`kubectl exec ${CONFIG.database.podName} -n ${CONFIG.database.namespace} -- env PGPASSWORD='${password}' psql -U ${CONFIG.database.user} -d ${CONFIG.database.database} -t -c "SELECT relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid)) FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 10;" 2>/dev/null`);
  if (tableSizes) {
    pgInfo.tables = tableSizes.trim().split('\n').map(line => {
      const [name, rows, size] = line.split('|').map(s => s.trim());
      return { name, rows: parseInt(rows) || 0, size };
    }).filter(t => t.name);
  }
  
  // Get indexes
  const indexes = execCommand(`kubectl exec ${CONFIG.database.podName} -n ${CONFIG.database.namespace} -- env PGPASSWORD='${password}' psql -U ${CONFIG.database.user} -d ${CONFIG.database.database} -t -c "SELECT indexname, tablename FROM pg_indexes WHERE schemaname = 'public';" 2>/dev/null`);
  if (indexes) {
    pgInfo.indexes = indexes.trim().split('\n').map(line => {
      const [indexname, tablename] = line.split('|').map(s => s.trim());
      return { indexname, tablename };
    }).filter(i => i.indexname);
  }
  
  return pgInfo;
}

function collectApplicationInfo() {
  const appInfo = {
    script: CONFIG.app.script,
    port: CONFIG.app.port,
    endpoints: {
      health: CONFIG.app.healthEndpoint,
      test: CONFIG.app.testEndpoint
    }
  };
  
  // Read package.json if exists
  try {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    appInfo.package = {
      name: packageJson.name,
      version: packageJson.version,
      dependencies: packageJson.dependencies
    };
  } catch (e) {}
  
  // Check for optimizations
  appInfo.optimizations = [];
  
  // Check if batching is enabled (look in db/postgres.js)
  try {
    const postgresDb = fs.readFileSync('db/postgres.js', 'utf8');
    if (postgresDb.includes('VALUES ${values.join')) {
      appInfo.optimizations.push('batch_inserts');
    }
    if (postgresDb.includes('max:')) {
      const poolMatch = postgresDb.match(/max:\s*(\d+)/);
      if (poolMatch) {
        appInfo.defaultPoolSize = parseInt(poolMatch[1]);
      }
    }
  } catch (e) {}
  
  // Check for indexes
  if (systemInfo?.postgresql?.indexes?.length > 0) {
    appInfo.optimizations.push('database_indexes');
  }
  
  return appInfo;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  
  return parts.join(' ') || '< 1m';
}

function printSystemInfo(info) {
  console.log('\n' + '═'.repeat(70));
  console.log('  SYSTEM INFORMATION');
  console.log('═'.repeat(70));
  
  console.log('\n  Host:');
  console.log(`    Hostname:     ${info.host.hostname}`);
  console.log(`    Platform:     ${info.host.platform} (${info.host.arch})`);
  console.log(`    Uptime:       ${info.host.uptime}`);
  
  console.log('\n  CPU:');
  console.log(`    Model:        ${info.cpu.model}`);
  console.log(`    Cores:        ${info.cpu.cores.physical} physical, ${info.cpu.cores.logical} logical`);
  console.log(`    Speed:        ${info.cpu.speed}`);
  console.log(`    Load Avg:     ${info.cpu.loadAverage['1min']} / ${info.cpu.loadAverage['5min']} / ${info.cpu.loadAverage['15min']}`);
  
  console.log('\n  Memory:');
  console.log(`    Total:        ${info.memory.total}`);
  console.log(`    Used:         ${info.memory.used} (${info.memory.usagePercent})`);
  console.log(`    Free:         ${info.memory.free}`);
  
  console.log('\n  Disk:');
  console.log(`    Size:         ${info.disk.size || 'Unknown'}`);
  console.log(`    Available:    ${info.disk.available || 'Unknown'}`);
  console.log(`    Type:         ${info.disk.type || 'Unknown'}`);
  
  console.log('\n  Operating System:');
  console.log(`    Name:         ${info.os.name || info.os.type}`);
  console.log(`    Version:      ${info.os.version || info.os.release}`);
  if (info.os.kernel) console.log(`    Kernel:       ${info.os.kernel}`);
  
  console.log('\n  Runtime:');
  console.log(`    Node.js:      ${info.runtime.node.version}`);
  console.log(`    npm:          ${info.runtime.npm.version}`);
  
  if (info.kubernetes.available) {
    console.log('\n  Kubernetes:');
    console.log(`    Server:       ${info.kubernetes.serverVersion}`);
    if (info.kubernetes.nodes) {
      info.kubernetes.nodes.forEach(node => {
        console.log(`    Node:         ${node.name} (${node.status})`);
        console.log(`      CPU:        ${node.cpu} cores`);
        console.log(`      Memory:     ${node.memory}`);
      });
    }
  }
  
  if (info.postgresql.available) {
    console.log('\n  PostgreSQL:');
    console.log(`    Version:      ${info.postgresql.version?.split(',')[0] || 'Unknown'}`);
    console.log(`    Max Conns:    ${info.postgresql.settings?.max_connections || 'Unknown'}`);
    console.log(`    Shared Buf:   ${info.postgresql.settings?.shared_buffers || 'Unknown'}`);
    console.log(`    Work Mem:     ${info.postgresql.settings?.work_mem || 'Unknown'}`);
    if (info.postgresql.connections) {
      console.log(`    Connections:  ${info.postgresql.connections.active} active, ${info.postgresql.connections.idle} idle`);
    }
  }
  
  console.log('\n  Application:');
  console.log(`    Name:         ${info.application.package?.name || 'Unknown'}`);
  console.log(`    Version:      ${info.application.package?.version || 'Unknown'}`);
  console.log(`    Optimizations: ${info.application.optimizations?.join(', ') || 'None detected'}`);
  
  console.log('\n' + '═'.repeat(70));
}

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

function cleanupDatabase() {
  log("Cleaning up database...", "STEP");
  try {
    const password = getDbPassword();
    const cmd = `kubectl exec ${CONFIG.database.podName} -n ${CONFIG.database.namespace} -- env PGPASSWORD='${password}' psql -U ${CONFIG.database.user} -d ${CONFIG.database.database} -c "TRUNCATE order_items, order_status_history, orders RESTART IDENTITY CASCADE;" 2>/dev/null`;
    execCommand(cmd);
    log("Database cleaned successfully", "SUCCESS");
    return true;
  } catch (err) {
    log("Database cleanup failed: " + err.message, "WARNING");
    return false;
  }
}

function getOrderCount() {
  try {
    const password = getDbPassword();
    const cmd = `kubectl exec ${CONFIG.database.podName} -n ${CONFIG.database.namespace} -- env PGPASSWORD='${password}' psql -U ${CONFIG.database.user} -d ${CONFIG.database.database} -t -c "SELECT COUNT(*) FROM orders;" 2>/dev/null`;
    const result = execCommand(cmd);
    return parseInt(result) || 0;
  } catch (err) {
    return -1;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// APPLICATION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

async function startApp(poolSize) {
  log(`Starting application with pool size: ${poolSize}`, "STEP");
  
  const env = {
    ...process.env,
    PORT: CONFIG.app.port.toString(),
    PG_HOST: "localhost",
    PG_PORT: "5432",
    PG_DATABASE: CONFIG.database.database,
    PG_USER: CONFIG.database.user,
    PG_PASSWORD: getDbPassword(),
    PG_POOL_SIZE: poolSize.toString(),
    DB_ADAPTER: "postgres"
  };
  
  return new Promise((resolve, reject) => {
    appProcess = spawn('node', [CONFIG.app.script], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });
    
    let started = false;
    
    appProcess.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('PostgreSQL connected') || output.includes('listening')) {
        if (!started) {
          started = true;
          log(`Application started on port ${CONFIG.app.port}`, "SUCCESS");
          setTimeout(() => resolve(true), 2000);
        }
      }
    });
    
    appProcess.stderr.on('data', (data) => {
      const err = data.toString();
      if (err.includes('EADDRINUSE')) {
        log("Port already in use, killing existing process...", "WARNING");
        execCommand(`lsof -ti:${CONFIG.app.port} | xargs kill -9 2>/dev/null || true`);
        setTimeout(() => startApp(poolSize).then(resolve).catch(reject), 2000);
      }
    });
    
    appProcess.on('error', (err) => {
      log("Failed to start application: " + err.message, "ERROR");
      reject(err);
    });
    
    setTimeout(() => {
      if (!started) {
        log("Application startup timeout, checking health...", "WARNING");
        checkHealth().then(healthy => {
          if (healthy) {
            started = true;
            resolve(true);
          } else {
            reject(new Error("Application failed to start"));
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
  try {
    execCommand(`lsof -ti:${CONFIG.app.port} | xargs kill -9 2>/dev/null || true`);
  } catch (e) {}
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
// TEST DATA GENERATION
// ═══════════════════════════════════════════════════════════════════════════

const menuItems = [
  { name: 'Masala Dosa', price: 80 },
  { name: 'Plain Dosa', price: 60 },
  { name: 'Idli', price: 40 },
  { name: 'Vada', price: 50 },
  { name: 'Filter Coffee', price: 30 },
  { name: 'Paneer Tikka', price: 160 },
  { name: 'Gobi Manchurian', price: 120 },
  { name: 'Upma', price: 45 },
  { name: 'Rava Dosa', price: 85 },
  { name: 'Butter Masala Dosa', price: 100 }
];

function generateOrder() {
  const items = [];
  const count = Math.floor(Math.random() * 4) + 1;
  for (let i = 0; i < count; i++) {
    const item = menuItems[Math.floor(Math.random() * menuItems.length)];
    items.push({
      name: item.name,
      price: item.price,
      qty: Math.floor(Math.random() * 3) + 1
    });
  }
  return {
    items,
    tableNumber: Math.floor(Math.random() * 30) + 1,
    customerName: `BenchmarkCustomer-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`
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
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 30000
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const latency = Number(process.hrtime.bigint() - start) / 1e6;
        resolve({
          success: res.statusCode === 200,
          statusCode: res.statusCode,
          latency
        });
      });
    });

    req.on('error', (err) => {
      const latency = Number(process.hrtime.bigint() - start) / 1e6;
      resolve({ success: false, error: err.message, latency });
    });

    req.on('timeout', () => {
      req.destroy();
      const latency = Number(process.hrtime.bigint() - start) / 1e6;
      resolve({ success: false, error: 'timeout', latency });
    });

    req.write(data);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// STATISTICS
// ═══════════════════════════════════════════════════════════════════════════

function calculateStats(latencies) {
  if (!latencies || latencies.length === 0) return null;
  
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  
  const squaredDiffs = sorted.map(x => Math.pow(x - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / sorted.length;
  const stdDev = Math.sqrt(variance);
  
  return {
    count: sorted.length,
    min: Math.round(sorted[0] * 100) / 100,
    max: Math.round(sorted[sorted.length - 1] * 100) / 100,
    mean: Math.round(mean * 100) / 100,
    stdDev: Math.round(stdDev * 100) / 100,
    p50: Math.round(sorted[Math.floor(sorted.length * 0.50)] * 100) / 100,
    p75: Math.round(sorted[Math.floor(sorted.length * 0.75)] * 100) / 100,
    p90: Math.round(sorted[Math.floor(sorted.length * 0.90)] * 100) / 100,
    p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 100) / 100,
    p99: Math.round(sorted[Math.floor(sorted.length * 0.99)] * 100) / 100,
    p999: Math.round((sorted[Math.floor(sorted.length * 0.999)] || sorted[sorted.length - 1]) * 100) / 100
  };
}

function calculateConfidenceInterval(values, confidence = 0.95) {
  if (!values || values.length === 0) return { mean: 0, lower: 0, upper: 0, margin: 0 };
  
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const stdDev = Math.sqrt(values.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / (n - 1 || 1));
  const z = confidence === 0.95 ? 1.96 : 2.576;
  const margin = z * (stdDev / Math.sqrt(n));
  
  return {
    mean: Math.round(mean * 100) / 100,
    lower: Math.round((mean - margin) * 100) / 100,
    upper: Math.round((mean + margin) * 100) / 100,
    margin: Math.round(margin * 100) / 100
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LOAD TEST RUNNER
// ═══════════════════════════════════════════════════════════════════════════

async function runLoadTest(targetRps, duration, isWarmup = false) {
  const results = { success: 0, failed: 0, latencies: [], errors: {} };
  const startTime = Date.now();
  const endTime = startTime + (duration * 1000);
  const intervalMs = 1000 / targetRps;
  
  let lastRequestTime = startTime;
  const pending = [];
  
  while (Date.now() < endTime) {
    const now = Date.now();
    if (now - lastRequestTime >= intervalMs) {
      pending.push(sendRequest().then(result => {
        if (result.success) {
          results.success++;
        } else {
          results.failed++;
          const errKey = result.error || `HTTP_${result.statusCode}`;
          results.errors[errKey] = (results.errors[errKey] || 0) + 1;
        }
        results.latencies.push(result.latency);
      }));
      lastRequestTime = now;
    }
    await new Promise(r => setTimeout(r, 1));
  }
  
  await Promise.all(pending);
  
  const actualDuration = (Date.now() - startTime) / 1000;
  const actualRps = results.latencies.length / actualDuration;
  const errorRate = results.failed / Math.max(results.success + results.failed, 1);
  const stats = calculateStats(results.latencies);
  
  return {
    targetRps,
    actualRps: Math.round(actualRps * 100) / 100,
    duration: Math.round(actualDuration * 100) / 100,
    requests: {
      total: results.success + results.failed,
      successful: results.success,
      failed: results.failed
    },
    errorRate: Math.round(errorRate * 10000) / 100,
    errors: results.errors,
    latency: stats,
    isWarmup
  };
}

async function runSingleIteration(targetRps, iteration, totalIterations) {
  process.stdout.write(`      Iteration ${iteration}/${totalIterations}: `);
  
  process.stdout.write("warmup...");
  await runLoadTest(targetRps, CONFIG.warmupDuration, true);
  
  process.stdout.write(" testing...");
  const result = await runLoadTest(targetRps, CONFIG.testDuration, false);
  
  process.stdout.write(" cooldown...");
  await sleep(CONFIG.cooldownDuration);
  
  console.log(` Done (${result.requests.total} reqs, ${result.errorRate}% err, p95: ${result.latency?.p95 || 'N/A'}ms)`);
  
  return result;
}

async function runLoadLevelTests(targetRps, poolSize) {
  log(`Testing ${targetRps} req/s with pool size ${poolSize}`, "STEP");
  
  const iterations = [];
  
  for (let i = 1; i <= CONFIG.runs; i++) {
    const result = await runSingleIteration(targetRps, i, CONFIG.runs);
    iterations.push(result);
  }
  
  const actualRpsValues = iterations.map(r => r.actualRps);
  const errorRates = iterations.map(r => r.errorRate);
  const p50Values = iterations.map(r => r.latency?.p50 || 0);
  const p95Values = iterations.map(r => r.latency?.p95 || 0);
  const p99Values = iterations.map(r => r.latency?.p99 || 0);
  const meanLatencies = iterations.map(r => r.latency?.mean || 0);
  const totalRequests = iterations.reduce((sum, r) => sum + r.requests.total, 0);
  const totalSuccess = iterations.reduce((sum, r) => sum + r.requests.successful, 0);
  const totalFailed = iterations.reduce((sum, r) => sum + r.requests.failed, 0);
  
  const aggregated = {
    targetRps,
    poolSize,
    iterations: CONFIG.runs,
    actualRps: calculateConfidenceInterval(actualRpsValues),
    errorRate: calculateConfidenceInterval(errorRates),
    latency: {
      mean: calculateConfidenceInterval(meanLatencies),
      p50: calculateConfidenceInterval(p50Values),
      p95: calculateConfidenceInterval(p95Values),
      p99: calculateConfidenceInterval(p99Values)
    },
    totals: {
      requests: totalRequests,
      successful: totalSuccess,
      failed: totalFailed
    },
    rawIterations: iterations,
    meetsThresholds: checkThresholds(errorRates, p95Values, p99Values)
  };
  
  const status = aggregated.meetsThresholds ? "✅ PASS" : "❌ FAIL";
  log(`${targetRps} req/s: ${aggregated.actualRps.mean} rps, ${aggregated.errorRate.mean}% err, p95: ${aggregated.latency.p95.mean}ms ${status}`, "RESULT");
  
  return aggregated;
}

function checkThresholds(errorRates, p95Values, p99Values) {
  const avgErrorRate = errorRates.reduce((a, b) => a + b, 0) / errorRates.length;
  const avgP95 = p95Values.reduce((a, b) => a + b, 0) / p95Values.length;
  const avgP99 = p99Values.reduce((a, b) => a + b, 0) / p99Values.length;
  
  return (
    avgErrorRate <= CONFIG.thresholds.maxErrorRate * 100 &&
    avgP95 <= CONFIG.thresholds.maxP95Latency &&
    avgP99 <= CONFIG.thresholds.maxP99Latency
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// POOL SIZE TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════

async function runPoolSizeTests(poolSize) {
  console.log('\n' + '═'.repeat(70));
  log(`TESTING POOL SIZE: ${poolSize}`, "INFO");
  console.log('═'.repeat(70));
  
  cleanupDatabase();
  
  try {
    await startApp(poolSize);
  } catch (err) {
    log(`Failed to start app with pool size ${poolSize}: ${err.message}`, "ERROR");
    return null;
  }
  
  await sleep(2);
  const healthy = await checkHealth();
  if (!healthy) {
    log("Application health check failed", "ERROR");
    stopApp();
    return null;
  }
  
  const results = {
    poolSize,
    loadLevels: {},
    maxSustainableRps: 0,
    breakingPoint: null
  };
  
  let previousFailed = false;
  
  for (const targetRps of CONFIG.loadLevels) {
    if (previousFailed) {
      log(`Skipping ${targetRps} req/s (previous level failed)`, "WARNING");
      break;
    }
    
    const loadResult = await runLoadLevelTests(targetRps, poolSize);
    results.loadLevels[targetRps] = loadResult;
    
    if (loadResult.meetsThresholds) {
      results.maxSustainableRps = targetRps;
    } else if (!results.breakingPoint) {
      results.breakingPoint = {
        rps: targetRps,
        errorRate: loadResult.errorRate.mean,
        p95: loadResult.latency.p95.mean
      };
    }
    
    if (loadResult.errorRate.mean > 50) {
      log(`Error rate > 50% at ${targetRps} req/s, stopping tests for pool size ${poolSize}`, "WARNING");
      previousFailed = true;
    }
    
    await sleep(5);
  }
  
  stopApp();
  cleanupDatabase();
  
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// REPORT GENERATION
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
      timestamp: startTime.toISOString(),
      endTime: endTime.toISOString(),
      totalDuration: `${Math.round((endTime - startTime) / 1000 / 60)} minutes`
    },
    systemInfo: systemInfo,
    configuration: {
      poolSizesTested: CONFIG.poolSizes,
      loadLevelsTested: CONFIG.loadLevels,
      runsPerLoadLevel: CONFIG.runs,
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
    },
    recommendations: generateRecommendations(allResults, bestConfig)
  };
}

function generateRecommendations(results, bestConfig) {
  const recommendations = [];
  
  if (bestConfig.maxRps >= 100) {
    recommendations.push({
      type: "success",
      message: `Pool size ${bestConfig.poolSize} achieved ${bestConfig.maxRps} req/s, sufficient for most use cases`
    });
  }
  
  const poolSizeComparison = Object.entries(results)
    .filter(([_, data]) => data)
    .map(([poolSize, data]) => ({ poolSize: parseInt(poolSize), maxRps: data.maxSustainableRps }))
    .sort((a, b) => b.maxRps - a.maxRps);
  
  if (poolSizeComparison.length >= 2) {
    const best = poolSizeComparison[0];
    const worst = poolSizeComparison[poolSizeComparison.length - 1];
    if (worst.maxRps > 0) {
      const improvement = ((best.maxRps - worst.maxRps) / worst.maxRps * 100).toFixed(1);
      recommendations.push({
        type: "insight",
        message: `Pool size ${best.poolSize} outperformed pool size ${worst.poolSize} by ${improvement}%`
      });
    }
  }
  
  if (bestConfig.maxRps < 50) {
    recommendations.push({
      type: "warning",
      message: "Consider additional optimizations: PgBouncer, PostgreSQL tuning, or hardware upgrade"
    });
  }
  
  return recommendations;
}

function saveReport(report) {
  const timestamp = report.metadata.timestamp.replace(/[:.]/g, '-');
  const jsonFile = `benchmark-suite-${timestamp}.json`;
  const mdFile = `benchmark-suite-${timestamp}.md`;
  
  fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2));
  log(`JSON report saved: ${jsonFile}`, "SUCCESS");
  
  const markdown = generateMarkdownReport(report);
  fs.writeFileSync(mdFile, markdown);
  log(`Markdown report saved: ${mdFile}`, "SUCCESS");
  
  return { jsonFile, mdFile };
}

function generateMarkdownReport(report) {
  const si = report.systemInfo;
  
  let md = `# ${report.metadata.name}

## Executive Summary

| Metric | Value |
|--------|-------|
| **Best Pool Size** | ${report.analysis.bestConfiguration.poolSize} |
| **Max Sustainable Throughput** | ${report.analysis.bestConfiguration.maxRps} req/s |
| **Hourly Capacity** | ${(report.analysis.bestConfiguration.maxRps * 3600).toLocaleString()} requests |
| **Daily Capacity** | ${(report.analysis.bestConfiguration.maxRps * 86400).toLocaleString()} requests |
| **Test Duration** | ${report.metadata.totalDuration} |
| **Test Date** | ${report.metadata.timestamp} |

## Test Environment

### Hardware

| Component | Specification |
|-----------|--------------|
| **Hostname** | ${si.host.hostname} |
| **CPU Model** | ${si.cpu.model} |
| **CPU Cores** | ${si.cpu.cores.physical} physical / ${si.cpu.cores.logical} logical |
| **CPU Speed** | ${si.cpu.speed} |
| **Total Memory** | ${si.memory.total} |
| **Available Memory** | ${si.memory.free} (${si.memory.usagePercent} used) |
| **Disk Type** | ${si.disk.type || 'Unknown'} |
| **Disk Size** | ${si.disk.size || 'Unknown'} |
| **Disk Available** | ${si.disk.available || 'Unknown'} |

### Operating System

| Component | Details |
|-----------|---------|
| **OS** | ${si.os.name || si.os.type} |
| **Version** | ${si.os.version || si.os.release} |
| **Kernel** | ${si.os.kernel || 'N/A'} |
| **Architecture** | ${si.host.arch} |
| **Uptime** | ${si.host.uptime} |

### Runtime Environment

| Component | Version |
|-----------|---------|
| **Node.js** | ${si.runtime.node.version} |
| **V8 Engine** | ${si.runtime.node.v8} |
| **npm** | ${si.runtime.npm.version} |
| **Timezone** | ${si.runtime.environment.timezone} |
`;

  if (si.kubernetes.available) {
    md += `
### Kubernetes Cluster

| Component | Details |
|-----------|---------|
| **Server Version** | ${si.kubernetes.serverVersion} |
`;
    if (si.kubernetes.nodes) {
      si.kubernetes.nodes.forEach(node => {
        md += `| **Node: ${node.name}** | ${node.cpu} CPU, ${node.memory} RAM, ${node.status} |
`;
      });
    }
    if (si.kubernetes.postgresqlPod) {
      md += `| **PostgreSQL Pod** | ${si.kubernetes.postgresqlPod.name} on ${si.kubernetes.postgresqlPod.nodeName} |
`;
    }
  }

  if (si.postgresql.available) {
    md += `
### PostgreSQL Configuration

| Setting | Value |
|---------|-------|
| **Version** | ${si.postgresql.version?.split(',')[0] || 'Unknown'} |
| **Max Connections** | ${si.postgresql.settings?.max_connections || 'Unknown'} |
| **Shared Buffers** | ${si.postgresql.settings?.shared_buffers || 'Unknown'} |
| **Effective Cache Size** | ${si.postgresql.settings?.effective_cache_size || 'Unknown'} |
| **Work Mem** | ${si.postgresql.settings?.work_mem || 'Unknown'} |
| **Maintenance Work Mem** | ${si.postgresql.settings?.maintenance_work_mem || 'Unknown'} |
`;
    if (si.postgresql.indexes?.length > 0) {
      md += `
**Indexes:** ${si.postgresql.indexes.map(i => i.indexname).join(', ')}
`;
    }
  }

  md += `
### Application

| Component | Details |
|-----------|---------|
| **Name** | ${si.application.package?.name || 'Unknown'} |
| **Version** | ${si.application.package?.version || 'Unknown'} |
| **Optimizations** | ${si.application.optimizations?.join(', ') || 'None detected'} |

## Test Configuration

| Parameter | Value |
|-----------|-------|
| Pool Sizes Tested | ${report.configuration.poolSizesTested.join(', ')} |
| Load Levels Tested | ${report.configuration.loadLevelsTested.join(', ')} req/s |
| Runs per Load Level | ${report.configuration.runsPerLoadLevel} |
| Test Duration | ${report.configuration.testDuration}s |
| Warmup Duration | ${report.configuration.warmupDuration}s |
| Cooldown Duration | ${report.configuration.cooldownDuration}s |

## Success Thresholds (SLA)

| Metric | Threshold |
|--------|-----------|
| Max Error Rate | ${report.configuration.thresholds.maxErrorRate * 100}% |
| Max p95 Latency | ${report.configuration.thresholds.maxP95Latency}ms |
| Max p99 Latency | ${report.configuration.thresholds.maxP99Latency}ms |

## Results Comparison by Pool Size

| Pool Size | Max Sustainable RPS | Breaking Point | Hourly Capacity |
|-----------|---------------------|----------------|-----------------|
`;

  for (const row of report.analysis.comparisonByPoolSize) {
    md += `| ${row.poolSize} | ${row.maxSustainableRps} req/s | ${row.breakingPoint?.rps || 'N/A'} req/s | ${row.throughputPerHour.toLocaleString()} |
`;
  }

  for (const [poolSize, data] of Object.entries(report.results)) {
    if (!data) continue;
    
    md += `
## Pool Size: ${poolSize}

**Max Sustainable RPS:** ${data.maxSustainableRps} req/s
`;
    
    if (data.breakingPoint) {
      md += `**Breaking Point:** ${data.breakingPoint.rps} req/s (Error: ${data.breakingPoint.errorRate}%, p95: ${data.breakingPoint.p95}ms)
`;
    }
    
    md += `
| Load (req/s) | Actual RPS | Error Rate | p95 Latency | p99 Latency | Status |
|--------------|------------|------------|-------------|-------------|--------|
`;
    
    for (const [rps, loadData] of Object.entries(data.loadLevels)) {
      const status = loadData.meetsThresholds ? '✅ PASS' : '❌ FAIL';
      md += `| ${rps} | ${loadData.actualRps.mean} ± ${loadData.actualRps.margin} | ${loadData.errorRate.mean}% | ${loadData.latency.p95.mean}ms | ${loadData.latency.p99.mean}ms | ${status} |
`;
    }
  }

  md += `
## Recommendations

`;
  for (const rec of report.recommendations) {
    const icon = rec.type === 'success' ? '✅' : rec.type === 'warning' ? '⚠️' : '💡';
    md += `${icon} ${rec.message}

`;
  }

  md += `
## Methodology

1. **Multiple Runs**: Each load level tested ${report.configuration.runsPerLoadLevel} times for statistical validity
2. **Warmup Phase**: ${report.configuration.warmupDuration}s warmup before each test (results discarded)
3. **Cooldown Phase**: ${report.configuration.cooldownDuration}s cooldown between tests
4. **Database Cleanup**: Database truncated between pool size tests
5. **Confidence Intervals**: Results reported with 95% confidence intervals
6. **Automatic Environment Detection**: System information collected automatically

---
*Report generated: ${report.metadata.timestamp}*
*Benchmark Suite Version: ${report.metadata.version}*
`;
  
  return md;
}

// ═══════════════════════════════════════════════════════════════════════════
// FINAL SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

function printFinalSummary(report) {
  console.log('\n' + '═'.repeat(70));
  console.log('  BENCHMARK SUITE COMPLETE');
  console.log('═'.repeat(70));
  
  console.log('\n  Results by Pool Size:');
  console.log('  ' + '─'.repeat(50));
  
  for (const row of report.analysis.comparisonByPoolSize) {
    const bar = '█'.repeat(Math.min(Math.round(row.maxSustainableRps / 10), 30));
    console.log(`  Pool ${row.poolSize.toString().padStart(2)}: ${row.maxSustainableRps.toString().padStart(3)} req/s ${bar}`);
  }
  
  console.log('\n  ' + '─'.repeat(50));
  console.log(`  🏆 Best Configuration: Pool Size ${report.analysis.bestConfiguration.poolSize}`);
  console.log(`     Max Throughput: ${report.analysis.bestConfiguration.maxRps} req/s`);
  console.log(`     Hourly Capacity: ${(report.analysis.bestConfiguration.maxRps * 3600).toLocaleString()} orders`);
  
  console.log('\n  Recommendations:');
  for (const rec of report.recommendations) {
    const icon = rec.type === 'success' ? '  ✅' : rec.type === 'warning' ? '  ⚠️' : '  💡';
    console.log(`${icon} ${rec.message}`);
  }
  
  console.log('\n' + '═'.repeat(70));
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════

async function runBenchmarkSuite() {
  const startTime = new Date();
  
  console.log('\n' + '═'.repeat(70));
  console.log('  ' + CONFIG.name);
  console.log('═'.repeat(70));
  console.log(`  Started:      ${startTime.toISOString()}`);
  console.log(`  Pool sizes:   ${CONFIG.poolSizes.join(', ')}`);
  console.log(`  Load levels:  ${CONFIG.loadLevels.join(', ')} req/s`);
  console.log(`  Runs/level:   ${CONFIG.runs}`);
  console.log(`  Est. duration: ~${Math.round(CONFIG.poolSizes.length * CONFIG.loadLevels.length * CONFIG.runs * (CONFIG.warmupDuration + CONFIG.testDuration + CONFIG.cooldownDuration) / 60)} minutes`);
  console.log('═'.repeat(70));
  
  // Collect system information
  systemInfo = collectSystemInfo();
  printSystemInfo(systemInfo);
  
  // Run tests for each pool size
  for (const poolSize of CONFIG.poolSizes) {
    const result = await runPoolSizeTests(poolSize);
    if (result) {
      allResults[poolSize] = result;
    }
    
    log("Pausing before next pool size test...", "INFO");
    await sleep(10);
  }
  
  const endTime = new Date();
  
  console.log('\n' + '═'.repeat(70));
  log("Generating report...", "STEP");
  
  const report = generateReport(allResults, startTime, endTime);
  const files = saveReport(report);
  
  printFinalSummary(report);
  
  return report;
}

// ═══════════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// RUN
// ═══════════════════════════════════════════════════════════════════════════

runBenchmarkSuite()
  .then(() => {
    log("Benchmark suite completed successfully", "SUCCESS");
    process.exit(0);
  })
  .catch((err) => {
    log("Benchmark suite failed: " + err.message, "ERROR");
    console.error(err);
    stopApp();
    process.exit(1);
  });
