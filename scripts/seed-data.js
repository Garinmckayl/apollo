/**
 * seed-data.js
 *
 * Generates and indexes synthetic observability data into Elasticsearch:
 * - app-logs: Application logs with varying error rates and latencies
 * - app-metrics: Time-series metrics (CPU, memory, request rates, error counts)
 * - deployments: Deployment history records
 * - incidents: Past incident reports for pattern matching
 * - runbooks: Operational runbooks for remediation guidance
 *
 * The data simulates a realistic incident scenario:
 * 1. 24 hours of normal operation
 * 2. A deployment at T-30min
 * 3. An error spike starting 5 minutes after the deploy
 */

import { Client } from "@elastic/elasticsearch";
import dotenv from "dotenv";

dotenv.config();

const client = new Client({
  node: process.env.ELASTIC_URL,
  auth: { apiKey: process.env.ELASTIC_API_KEY },
});

// ---------------------------------------------------------------------------
// Index Mappings
// ---------------------------------------------------------------------------

const INDEX_MAPPINGS = {
  "app-logs": {
    mappings: {
      properties: {
        "@timestamp": { type: "date" },
        service: { type: "keyword" },
        level: { type: "keyword" },
        message: { type: "text" },
        status_code: { type: "integer" },
        latency_ms: { type: "float" },
        request_path: { type: "keyword" },
        trace_id: { type: "keyword" },
        host: { type: "keyword" },
        environment: { type: "keyword" },
      },
    },
  },
  "app-metrics": {
    mappings: {
      properties: {
        "@timestamp": { type: "date" },
        service: { type: "keyword" },
        host: { type: "keyword" },
        cpu_percent: { type: "float" },
        memory_percent: { type: "float" },
        request_rate: { type: "float" },
        error_rate: { type: "float" },
        p99_latency_ms: { type: "float" },
        active_connections: { type: "integer" },
        environment: { type: "keyword" },
      },
    },
  },
  deployments: {
    mappings: {
      properties: {
        "@timestamp": { type: "date" },
        service: { type: "keyword" },
        version: { type: "keyword" },
        deployer: { type: "keyword" },
        commit_sha: { type: "keyword" },
        commit_message: { type: "text" },
        environment: { type: "keyword" },
        status: { type: "keyword" },
        changes: { type: "text" },
        rollback_version: { type: "keyword" },
      },
    },
  },
  incidents: {
    mappings: {
      properties: {
        "@timestamp": { type: "date" },
        title: { type: "text" },
        severity: { type: "keyword" },
        service: { type: "keyword" },
        root_cause: { type: "text" },
        resolution: { type: "text" },
        duration_minutes: { type: "integer" },
        triggered_by: { type: "keyword" },
        status: { type: "keyword" },
        tags: { type: "keyword" },
      },
    },
  },
  runbooks: {
    mappings: {
      properties: {
        title: { type: "text" },
        service: { type: "keyword" },
        category: { type: "keyword" },
        symptoms: { type: "text" },
        diagnosis_steps: { type: "text" },
        remediation_steps: { type: "text" },
        tags: { type: "keyword" },
        last_updated: { type: "date" },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Data Generation Helpers
// ---------------------------------------------------------------------------

const SERVICES = [
  "checkout-api",
  "payment-service",
  "inventory-service",
  "user-service",
  "gateway",
];
const HOSTS = ["prod-01", "prod-02", "prod-03"];
const PATHS = [
  "/api/v1/checkout",
  "/api/v1/payment/process",
  "/api/v1/inventory/check",
  "/api/v1/users/profile",
  "/health",
];
const DEPLOYERS = [
  "alice@company.com",
  "bob@company.com",
  "charlie@company.com",
];

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateTraceId() {
  return [...Array(32)]
    .map(() => Math.floor(Math.random() * 16).toString(16))
    .join("");
}

function generateCommitSha() {
  return [...Array(7)]
    .map(() => Math.floor(Math.random() * 16).toString(16))
    .join("");
}

/**
 * Generate log entries for a given time range.
 * @param {Date} start - Start time
 * @param {Date} end - End time
 * @param {number} errorRate - Error rate (0-1) for this window
 * @param {number} baseLatency - Base latency in ms
 * @param {number} logsPerMinute - How many logs to generate per minute
 */
function generateLogs(start, end, errorRate, baseLatency, logsPerMinute = 10) {
  const logs = [];
  const current = new Date(start);

  while (current < end) {
    for (let i = 0; i < logsPerMinute; i++) {
      const isError = Math.random() < errorRate;
      const service = isError ? "checkout-api" : randomChoice(SERVICES);
      const statusCode = isError
        ? randomChoice([500, 502, 503])
        : randomChoice([200, 200, 200, 201, 204, 301]);
      const latency = isError
        ? baseLatency * randomBetween(3, 10)
        : baseLatency * randomBetween(0.5, 2);

      const errorMessages = [
        "NullPointerException in PaymentProcessor.processTransaction()",
        "Connection timeout to payment gateway after 30000ms",
        "Database connection pool exhausted: max connections (50) reached",
        "Failed to serialize checkout response: invalid UTF-8 sequence",
        "Circuit breaker OPEN for payment-service: 10 failures in 60s",
      ];

      const okMessages = [
        "Request processed successfully",
        "Health check passed",
        "Cache hit for user profile",
        "Inventory check completed",
        "Session validated",
      ];

      logs.push({
        "@timestamp": new Date(
          current.getTime() + Math.random() * 60000
        ).toISOString(),
        service,
        level: isError ? "ERROR" : "INFO",
        message: isError ? randomChoice(errorMessages) : randomChoice(okMessages),
        status_code: statusCode,
        latency_ms: Math.round(latency * 100) / 100,
        request_path: randomChoice(PATHS),
        trace_id: generateTraceId(),
        host: randomChoice(HOSTS),
        environment: "production",
      });
    }
    current.setMinutes(current.getMinutes() + 1);
  }
  return logs;
}

/**
 * Generate metric snapshots for a given time range.
 */
function generateMetrics(
  start,
  end,
  errorRate,
  baseCpu,
  intervalMinutes = 1
) {
  const metrics = [];
  const current = new Date(start);

  while (current < end) {
    for (const service of SERVICES) {
      const isAffected = service === "checkout-api" && errorRate > 0.05;
      metrics.push({
        "@timestamp": new Date(current).toISOString(),
        service,
        host: randomChoice(HOSTS),
        cpu_percent: isAffected
          ? Math.min(95, baseCpu * randomBetween(2, 4))
          : baseCpu * randomBetween(0.8, 1.2),
        memory_percent: isAffected
          ? randomBetween(75, 95)
          : randomBetween(40, 60),
        request_rate: isAffected
          ? randomBetween(50, 100)
          : randomBetween(200, 500),
        error_rate: isAffected ? errorRate * 100 : randomBetween(0, 0.5),
        p99_latency_ms: isAffected
          ? randomBetween(2000, 8000)
          : randomBetween(50, 200),
        active_connections: isAffected
          ? Math.floor(randomBetween(45, 50))
          : Math.floor(randomBetween(5, 25)),
        environment: "production",
      });
    }
    current.setMinutes(current.getMinutes() + intervalMinutes);
  }
  return metrics;
}

/**
 * Generate deployment records including the "bad" deployment.
 */
function generateDeployments(incidentTime) {
  const deploys = [];

  // A few normal deployments over the past week
  for (let daysAgo = 7; daysAgo >= 1; daysAgo--) {
    const ts = new Date(incidentTime);
    ts.setDate(ts.getDate() - daysAgo);
    ts.setHours(Math.floor(randomBetween(9, 17)), 0, 0, 0);

    deploys.push({
      "@timestamp": ts.toISOString(),
      service: randomChoice(SERVICES),
      version: `1.${20 - daysAgo}.${Math.floor(randomBetween(0, 10))}`,
      deployer: randomChoice(DEPLOYERS),
      commit_sha: generateCommitSha(),
      commit_message: randomChoice([
        "chore: update dependencies",
        "feat: add caching layer for user profiles",
        "fix: resolve race condition in inventory lock",
        "refactor: extract payment gateway client",
        "docs: update API documentation",
      ]),
      environment: "production",
      status: "success",
      changes: randomChoice([
        "Updated 3 files, +45 -12 lines",
        "Updated 1 file, +8 -2 lines",
        "Updated 7 files, +230 -89 lines",
      ]),
      rollback_version: `1.${20 - daysAgo - 1}.0`,
    });
  }

  // The BAD deployment -- 30 minutes before the incident
  const badDeployTime = new Date(incidentTime);
  badDeployTime.setMinutes(badDeployTime.getMinutes() - 30);

  deploys.push({
    "@timestamp": badDeployTime.toISOString(),
    service: "checkout-api",
    version: "1.21.0",
    deployer: "bob@company.com",
    commit_sha: "a3f7c2d",
    commit_message:
      "feat: migrate checkout flow to new payment gateway SDK v3",
    environment: "production",
    status: "success",
    changes:
      "Updated 12 files, +847 -234 lines. Major refactor of PaymentProcessor class to use new SDK. Updated connection pool configuration.",
    rollback_version: "1.20.9",
  });

  return deploys;
}

/**
 * Generate past incidents for pattern matching.
 */
function generatePastIncidents() {
  return [
    {
      "@timestamp": "2026-01-15T03:22:00Z",
      title: "checkout-api: Payment processing failures due to connection pool exhaustion",
      severity: "P1",
      service: "checkout-api",
      root_cause:
        "Connection pool max_connections was set to 50 but new payment SDK opened 3 connections per transaction instead of 1. Under load, pool exhausted in <5 minutes.",
      resolution:
        "Rolled back to previous payment SDK version. Increased connection pool to 150 and updated SDK configuration to use connection multiplexing. Deployed hotfix v1.18.3.",
      duration_minutes: 47,
      triggered_by: "deployment",
      status: "resolved",
      tags: ["payment", "connection-pool", "sdk-migration", "checkout"],
    },
    {
      "@timestamp": "2025-12-03T14:10:00Z",
      title: "inventory-service: Cascading timeouts causing checkout failures",
      severity: "P2",
      service: "inventory-service",
      root_cause:
        "Database query plan regression after index was dropped during maintenance. Full table scans on inventory_items caused 30s+ query times.",
      resolution:
        "Recreated missing index on inventory_items(product_id, warehouse_id). Query times returned to <50ms.",
      duration_minutes: 23,
      triggered_by: "maintenance",
      status: "resolved",
      tags: ["database", "timeout", "query-performance", "index"],
    },
    {
      "@timestamp": "2025-11-20T09:45:00Z",
      title: "gateway: SSL certificate expiry causing 502 errors",
      severity: "P1",
      service: "gateway",
      root_cause:
        "Wildcard SSL certificate for *.api.company.com expired. Auto-renewal failed silently due to DNS validation misconfiguration.",
      resolution:
        "Manually renewed certificate via Let's Encrypt. Fixed DNS CNAME record for validation. Added certificate expiry monitoring alert.",
      duration_minutes: 35,
      triggered_by: "certificate",
      status: "resolved",
      tags: ["ssl", "certificate", "gateway", "502"],
    },
    {
      "@timestamp": "2025-10-08T21:30:00Z",
      title: "checkout-api: Memory leak in payment transaction logging",
      severity: "P2",
      service: "checkout-api",
      root_cause:
        "New structured logging library cached transaction objects without TTL. Memory grew linearly until OOM kill after ~6 hours under load.",
      resolution:
        "Configured log cache TTL to 60s and max entries to 10000. Added memory usage alerting at 80% threshold.",
      duration_minutes: 62,
      triggered_by: "deployment",
      status: "resolved",
      tags: ["memory-leak", "logging", "oom", "checkout"],
    },
  ];
}

/**
 * Generate operational runbooks.
 */
function generateRunbooks() {
  return [
    {
      title: "Checkout API: High Error Rate Runbook",
      service: "checkout-api",
      category: "incident-response",
      symptoms:
        "Error rate exceeds 5% on checkout-api. HTTP 500/502/503 responses increasing. P99 latency above 2000ms. Customer-facing checkout failures reported.",
      diagnosis_steps:
        "1. Check error rate trend in last 30 minutes using: FROM app-metrics | WHERE service == 'checkout-api' | STATS avg(error_rate) BY BUCKET(@timestamp, 5 min)\n2. Review recent deployments: any checkout-api deploys in the last 2 hours?\n3. Check connection pool utilization: active_connections near max (50)?\n4. Review error logs for specific exception types\n5. Check downstream dependency health (payment-service, inventory-service)",
      remediation_steps:
        "IF deployment-related:\n  1. Rollback to previous version using: kubectl rollout undo deployment/checkout-api\n  2. Verify error rate drops within 5 minutes\n  3. Investigate root cause in staging\n\nIF connection pool exhaustion:\n  1. Increase pool size: kubectl set env deployment/checkout-api MAX_POOL_SIZE=150\n  2. Check for connection leaks in recent code changes\n\nIF downstream dependency:\n  1. Enable circuit breaker: kubectl set env deployment/checkout-api CIRCUIT_BREAKER_ENABLED=true\n  2. Investigate downstream service independently",
      tags: ["checkout", "error-rate", "500", "payment", "connection-pool"],
      last_updated: "2026-02-01T10:00:00Z",
    },
    {
      title: "Payment Service: Transaction Timeout Runbook",
      service: "payment-service",
      category: "incident-response",
      symptoms:
        "Payment transaction timeouts exceeding 30s. Checkout completion rate dropping. Payment gateway returning 504 errors.",
      diagnosis_steps:
        "1. Check payment gateway status page\n2. Review transaction latency percentiles\n3. Verify API credentials haven't been rotated\n4. Check if rate limits are being hit",
      remediation_steps:
        "1. If gateway is down: Enable fallback payment processor\n2. If rate limited: Implement request queuing\n3. If credential issue: Rotate and redeploy credentials from vault",
      tags: ["payment", "timeout", "transaction", "gateway"],
      last_updated: "2026-01-20T15:30:00Z",
    },
    {
      title: "General: Post-Deployment Verification Checklist",
      service: "all",
      category: "deployment",
      symptoms: "Any anomaly detected within 2 hours of a deployment.",
      diagnosis_steps:
        "1. Identify the most recent deployment to the affected service\n2. Compare error rates: 30 min before deploy vs 30 min after\n3. Check commit changes for risky modifications (connection configs, SDK updates, env vars)\n4. Review if similar deployments caused issues historically",
      remediation_steps:
        "1. If error rate increased >5x after deploy: ROLLBACK IMMEDIATELY\n2. Create incident ticket with deployment details\n3. Notify deployer and team lead\n4. Schedule post-mortem within 48 hours",
      tags: ["deployment", "verification", "rollback", "general"],
      last_updated: "2026-02-10T08:00:00Z",
    },
  ];
}

// ---------------------------------------------------------------------------
// Indexing Logic
// ---------------------------------------------------------------------------

async function createIndices() {
  for (const [indexName, settings] of Object.entries(INDEX_MAPPINGS)) {
    const exists = await client.indices.exists({ index: indexName });
    if (exists) {
      console.log(`  Deleting existing index: ${indexName}`);
      await client.indices.delete({ index: indexName });
    }
    console.log(`  Creating index: ${indexName}`);
    await client.indices.create({ index: indexName, body: settings });
  }
}

async function bulkIndex(indexName, documents) {
  if (documents.length === 0) return;

  const operations = documents.flatMap((doc) => [
    { index: { _index: indexName } },
    doc,
  ]);

  const { errors, items } = await client.bulk({
    refresh: true,
    operations,
  });

  if (errors) {
    const errorItems = items.filter((item) => item.index?.error);
    console.error(
      `  Errors indexing to ${indexName}:`,
      errorItems.slice(0, 3).map((i) => i.index.error)
    );
  }

  console.log(
    `  Indexed ${documents.length} documents to ${indexName}`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Incident Autopilot: Seeding Data ===\n");

  // The "incident" starts now minus 1 hour (so we have recent data)
  const now = new Date();
  const incidentTime = new Date(now);
  incidentTime.setHours(incidentTime.getHours() - 1);

  // Time windows
  const normalStart = new Date(incidentTime);
  normalStart.setHours(normalStart.getHours() - 24);

  const deployTime = new Date(incidentTime);
  deployTime.setMinutes(deployTime.getMinutes() - 30);

  const anomalyStart = new Date(incidentTime);
  anomalyStart.setMinutes(anomalyStart.getMinutes() - 25); // 5 min after deploy

  console.log("Timeline:");
  console.log(`  Normal period:  ${normalStart.toISOString()} to ${deployTime.toISOString()}`);
  console.log(`  Deployment:     ${deployTime.toISOString()}`);
  console.log(`  Anomaly start:  ${anomalyStart.toISOString()}`);
  console.log(`  Current time:   ${now.toISOString()}\n`);

  // Step 1: Create indices
  console.log("Step 1: Creating indices...");
  await createIndices();
  console.log();

  // Step 2: Generate and index normal logs (24h of healthy data, sampled)
  console.log("Step 2: Seeding normal-period logs (sampled every 10 min)...");
  const normalLogs = generateLogs(normalStart, deployTime, 0.001, 80, 5);
  await bulkIndex("app-logs", normalLogs);

  // Step 3: Generate anomaly logs (25 min of errors)
  console.log("Step 3: Seeding anomaly-period logs...");
  const anomalyLogs = generateLogs(anomalyStart, now, 0.15, 150, 15);
  await bulkIndex("app-logs", anomalyLogs);

  // Step 4: Generate and index metrics
  console.log("Step 4: Seeding normal-period metrics...");
  const normalMetrics = generateMetrics(normalStart, deployTime, 0.001, 25, 10);
  await bulkIndex("app-metrics", normalMetrics);

  console.log("Step 5: Seeding anomaly-period metrics...");
  const anomalyMetrics = generateMetrics(anomalyStart, now, 0.15, 25, 1);
  await bulkIndex("app-metrics", anomalyMetrics);

  // Step 5: Generate and index deployments
  console.log("Step 6: Seeding deployment history...");
  const deploys = generateDeployments(incidentTime);
  await bulkIndex("deployments", deploys);

  // Step 6: Index past incidents
  console.log("Step 7: Seeding past incidents...");
  const incidents = generatePastIncidents();
  await bulkIndex("incidents", incidents);

  // Step 7: Index runbooks
  console.log("Step 8: Seeding runbooks...");
  const runbooks = generateRunbooks();
  await bulkIndex("runbooks", runbooks);

  console.log("\n=== Data seeding complete! ===");
  console.log(`
Summary:
  app-logs:     ${normalLogs.length + anomalyLogs.length} documents
  app-metrics:  ${normalMetrics.length + anomalyMetrics.length} documents
  deployments:  ${deploys.length} documents
  incidents:    ${incidents.length} documents
  runbooks:     ${runbooks.length} documents
`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
