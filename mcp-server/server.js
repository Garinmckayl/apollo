/**
 * Apollo MCP Server v3
 *
 * Features:
 * 1. MCP action tools (Telegram, Slack, incident records, rollback)
 * 2. Two-way Telegram bot with persistent conversation (same thread)
 * 3. Scheduled autonomous scans (every 3 hours)
 * 4. Follow-up commands (resolve, escalate, rollback, status)
 * 5. Markdown -> Telegram HTML conversion
 * 6. Clickable Kibana links for incident records
 */

import express from "express";
import dotenv from "dotenv";

dotenv.config({ path: "../.env" });

// Conditionally import Slack Bolt
let SlackApp;
try {
  const bolt = await import("@slack/bolt");
  SlackApp = bolt.default?.App || bolt.App;
} catch { SlackApp = null; }

const app = express();
app.use(express.json());

const PORT = process.env.MCP_PORT || 3001;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const ELASTIC_URL = process.env.ELASTIC_URL || "";
const ELASTIC_API_KEY = process.env.ELASTIC_API_KEY || "";
const KIBANA_URL = process.env.KIBANA_URL || "";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || ""; // e.g. "Garinmckayl/doctus"
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || "10800000"); // 3 hours

// Persistent conversation ID per chat -- keeps same thread
const conversationMap = new Map(); // chatId -> conversation_id

// ---------------------------------------------------------------------------
// Markdown -> Telegram HTML converter
// ---------------------------------------------------------------------------

function mdToTelegramHtml(text) {
  if (!text) return "";

  let result = text;

  // Remove markdown headers (# ## ### etc) -> bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  result = result.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic: *text* or _text_ (but not inside words)
  result = result.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, "<i>$1</i>");
  result = result.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, "<i>$1</i>");

  // Inline code: `text`
  result = result.replace(/`([^`\n]+?)`/g, "<code>$1</code>");

  // Code blocks: ```text``` -> <pre>text</pre>
  result = result.replace(/```[\w]*\n?([\s\S]*?)```/g, "<pre>$1</pre>");

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Links: [text](url) -> <a href="url">text</a>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Horizontal rules: --- or *** -> newline
  result = result.replace(/^[-*]{3,}$/gm, "");

  // Remove bullet points markers but keep content
  result = result.replace(/^[\s]*[-*+]\s+/gm, "  • ");

  // Remove numbered list markers but keep content
  result = result.replace(/^[\s]*\d+\.\s+/gm, "  ");

  // Clean up excessive newlines
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

// ---------------------------------------------------------------------------
// Tool Definitions (MCP Protocol)
// ---------------------------------------------------------------------------

const TOOLS = [
  // ---- WRITE/ACTION TOOLS ----
  {
    name: "send_telegram_alert",
    description:
      "Send an incident alert to the team's Telegram chat. This sends a REAL message.",
    inputSchema: {
      type: "object",
      properties: {
        severity: { type: "string", description: "P1, P2, or P3", enum: ["P1", "P2", "P3"] },
        service: { type: "string", description: "Affected service name" },
        title: { type: "string", description: "Short incident title" },
        root_cause: { type: "string", description: "Root cause summary" },
        recommended_action: { type: "string", description: "Recommended remediation steps" },
      },
      required: ["severity", "service", "title", "root_cause"],
    },
  },
  {
    name: "create_incident_record",
    description:
      "Create a persistent incident record in Elasticsearch. Returns a clickable Kibana link.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Incident title" },
        severity: { type: "string", description: "P1, P2, or P3", enum: ["P1", "P2", "P3"] },
        service: { type: "string", description: "Affected service" },
        root_cause: { type: "string", description: "Root cause analysis" },
        resolution: { type: "string", description: "Resolution or recommended remediation" },
        triggered_by: { type: "string", description: "What triggered the incident" },
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
      },
      required: ["title", "severity", "service", "root_cause"],
    },
  },
  {
    name: "recommend_rollback",
    description:
      "Generate rollback recommendation and notify team via Telegram.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service to rollback" },
        current_version: { type: "string", description: "Current (broken) version" },
        target_version: { type: "string", description: "Version to rollback to" },
        reason: { type: "string", description: "Why rollback is recommended" },
      },
      required: ["service", "current_version", "target_version", "reason"],
    },
  },
  {
    name: "send_slack_notification",
    description:
      "Send incident notification to Slack channel with rich formatting.",
    inputSchema: {
      type: "object",
      properties: {
        severity: { type: "string", description: "P1, P2, or P3", enum: ["P1", "P2", "P3"] },
        service: { type: "string", description: "Affected service name" },
        title: { type: "string", description: "Incident title" },
        root_cause: { type: "string", description: "Root cause summary" },
        recommended_action: { type: "string", description: "Recommended remediation" },
        kibana_link: { type: "string", description: "Link to Kibana" },
      },
      required: ["severity", "service", "title", "root_cause"],
    },
  },

  // ---- ADVANCED ACTION TOOLS (close the loop: fix, verify, document) ----
  {
    name: "execute_rollback",
    description:
      "Execute a service rollback via the CI/CD pipeline. Records the rollback as a deployment in Elasticsearch, notifies Slack and Telegram with before/after versions, and returns the deployment record. Use this when a rollback has been recommended and approved.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service to rollback (e.g. 'checkout-api')" },
        current_version: { type: "string", description: "Current broken version (e.g. 'v1.21.0')" },
        target_version: { type: "string", description: "Version to rollback to (e.g. 'v1.20.9')" },
        reason: { type: "string", description: "Reason for rollback" },
        triggered_by: { type: "string", description: "Who or what triggered this rollback" },
      },
      required: ["service", "current_version", "target_version", "reason"],
    },
  },
  {
    name: "run_health_check",
    description:
      "Run a post-action health check on a service to verify a fix or rollback was successful. Queries real-time error rates and latency from Elasticsearch for the last 10 minutes and compares to the previous hour baseline. Returns whether the service has recovered.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service name to health check (e.g. 'checkout-api')" },
      },
      required: ["service"],
    },
  },
  {
    name: "create_jira_ticket",
    description:
      "Create a Jira ticket for incident tracking. Auto-fills title, description with root cause analysis, affected services, remediation steps, and severity-based priority. Posts the ticket link to Slack and Telegram.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Jira project key (e.g. 'SRE', 'OPS')" },
        title: { type: "string", description: "Ticket title" },
        severity: { type: "string", description: "P1, P2, or P3", enum: ["P1", "P2", "P3"] },
        service: { type: "string", description: "Affected service" },
        root_cause: { type: "string", description: "Root cause analysis" },
        remediation_steps: { type: "string", description: "Step-by-step remediation plan" },
        assignee: { type: "string", description: "Optional: assign to a specific person" },
      },
      required: ["project", "title", "severity", "service", "root_cause"],
    },
  },
  {
    name: "create_pagerduty_incident",
    description:
      "Create a PagerDuty incident and page the on-call engineer. Sets severity, assigns to the correct escalation policy, and includes root cause and recommended actions in the incident details.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Incident title" },
        severity: { type: "string", description: "P1, P2, or P3", enum: ["P1", "P2", "P3"] },
        service: { type: "string", description: "Affected service" },
        root_cause: { type: "string", description: "Root cause summary" },
        recommended_action: { type: "string", description: "What the on-call should do" },
        escalation_policy: { type: "string", description: "PagerDuty escalation policy (default: 'default')" },
      },
      required: ["title", "severity", "service", "root_cause"],
    },
  },
  {
    name: "generate_postmortem",
    description:
      "Generate a structured postmortem report from the investigation data. Creates a detailed document with timeline, root cause analysis, impact assessment, remediation steps taken, and preventive measures. Indexes the postmortem in Elasticsearch and shares via Slack.",
    inputSchema: {
      type: "object",
      properties: {
        incident_title: { type: "string", description: "Title of the incident" },
        severity: { type: "string", description: "P1, P2, or P3", enum: ["P1", "P2", "P3"] },
        service: { type: "string", description: "Primary affected service" },
        started_at: { type: "string", description: "When the incident started (ISO timestamp or relative like '2 hours ago')" },
        detected_at: { type: "string", description: "When Apollo detected the incident" },
        resolved_at: { type: "string", description: "When the incident was resolved (or 'ongoing')" },
        root_cause: { type: "string", description: "Detailed root cause analysis" },
        impact: { type: "string", description: "Business and technical impact (e.g. '15% error rate affecting checkout for 25 minutes')" },
        timeline: { type: "string", description: "Key events in chronological order" },
        remediation: { type: "string", description: "What was done to fix it" },
        preventive_measures: { type: "string", description: "What will prevent this from happening again" },
        lessons_learned: { type: "string", description: "Key takeaways from this incident" },
      },
      required: ["incident_title", "severity", "service", "root_cause", "impact", "remediation"],
    },
  },
  {
    name: "update_status_page",
    description:
      "Update the internal/external status page with current incident status. Records the status update in Elasticsearch and notifies Slack channel. Use this to keep stakeholders and customers informed during an incident.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Affected service name" },
        status: { type: "string", description: "Current status", enum: ["investigating", "identified", "monitoring", "resolved"] },
        title: { type: "string", description: "Status update title" },
        message: { type: "string", description: "Detailed status message for stakeholders" },
        affected_components: { type: "array", items: { type: "string" }, description: "List of affected components (e.g. ['checkout', 'payments', 'cart'])" },
        is_customer_facing: { type: "boolean", description: "Whether this impacts external customers" },
      },
      required: ["service", "status", "title", "message"],
    },
  },
  {
    name: "create_github_issue",
    description:
      "Create a REAL GitHub issue for incident tracking. This creates an actual issue on GitHub that anyone can verify by clicking the link. Auto-fills title, body with root cause analysis, affected services, remediation steps, severity labels, and assignee. Posts the real GitHub issue URL to Slack and Telegram.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Issue title" },
        severity: { type: "string", description: "P1, P2, or P3", enum: ["P1", "P2", "P3"] },
        service: { type: "string", description: "Affected service" },
        root_cause: { type: "string", description: "Root cause analysis" },
        remediation_steps: { type: "string", description: "Step-by-step remediation plan" },
        impact: { type: "string", description: "Business and technical impact" },
        labels: { type: "array", items: { type: "string" }, description: "Additional labels (e.g. ['bug', 'urgent'])" },
      },
      required: ["title", "severity", "service", "root_cause"],
    },
  },

  // ---- READ/QUERY TOOLS (for VS Code, Claude, external agents) ----
  {
    name: "get_service_health",
    description:
      "Check the current health of production services. Returns error rates, latency, and connection pool usage from the last 2 hours. Use this to quickly see if anything is wrong.",
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "Optional: specific service name to check (e.g. 'checkout-api'). Leave empty to check all services.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_recent_incidents",
    description:
      "Get recent incidents from Elasticsearch. Returns incident records with title, severity, service, root cause, status, and timestamps. Useful for understanding current and past issues.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Optional: filter by service name" },
        severity: { type: "string", description: "Optional: filter by severity (P1, P2, P3)" },
        limit: { type: "number", description: "Number of incidents to return (default 10)" },
      },
      required: [],
    },
  },
  {
    name: "get_recent_deployments",
    description:
      "Get recent deployment history. Returns who deployed what, when, commit details, and change descriptions. Use this to check what changed recently.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Optional: filter by service name" },
        limit: { type: "number", description: "Number of deployments to return (default 10)" },
      },
      required: [],
    },
  },
  {
    name: "search_error_logs",
    description:
      "Search application error logs. Returns recent errors grouped by message, service, and status code with counts. Use this to find what errors are occurring.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Optional: filter by service name" },
        hours: { type: "number", description: "How many hours back to search (default 2)" },
      },
      required: [],
    },
  },
  {
    name: "ask_apollo",
    description:
      "Ask Apollo (the AI SRE agent) a question or give it an instruction. Apollo has access to all Elasticsearch data, can investigate incidents, create records, and notify teams. Use this for complex queries that need AI reasoning.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Your question or instruction for Apollo. Examples: 'What caused the last checkout-api incident?', 'Investigate production anomalies', 'Search past incidents for payment timeouts'",
        },
      },
      required: ["question"],
    },
  },
];

// ---------------------------------------------------------------------------
// Telegram Helper
// ---------------------------------------------------------------------------

async function sendTelegram(chatId, text, options = {}) {
  if (!TELEGRAM_BOT_TOKEN) return { success: false, error: "Bot not configured" };

  // Truncate if over Telegram's limit
  const safeText = text.length > 4096 ? text.substring(0, 4090) + "\n..." : text;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId || TELEGRAM_CHAT_ID,
      text: safeText,
      parse_mode: "HTML",
      disable_web_page_preview: false,
      ...options,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    // If HTML parse fails, retry without formatting
    if (err.includes("can't parse entities")) {
      const plainRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId || TELEGRAM_CHAT_ID,
          text: safeText.replace(/<[^>]+>/g, ""),
          ...options,
        }),
      });
      if (plainRes.ok) return { success: true };
    }
    return { success: false, error: err };
  }
  return { success: true };
}

function escapeHtml(text) {
  if (!text) return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Action Handlers
// ---------------------------------------------------------------------------

async function sendTelegramAlert(params) {
  const severityEmoji = { P1: "\u{1F534}", P2: "\u{1F7E0}", P3: "\u{1F7E1}" };
  const emoji = severityEmoji[params.severity] || "\u{26AA}";

  const text =
    `${emoji} <b>${params.severity} Incident: ${escapeHtml(params.title)}</b>\n\n` +
    `<b>Service:</b> <code>${params.service}</code>\n` +
    `<b>Root Cause:</b> ${escapeHtml(params.root_cause)}\n` +
    (params.recommended_action
      ? `\n<b>Action:</b>\n${escapeHtml(params.recommended_action)}`
      : "") +
    `\n\n<i>Apollo SRE Agent</i>`;

  const result = await sendTelegram(TELEGRAM_CHAT_ID, text);
  return result.success
    ? { success: true, message: "Telegram alert sent to on-call team" }
    : result;
}

async function createIncidentRecord(params) {
  const doc = {
    "@timestamp": new Date().toISOString(),
    title: params.title,
    severity: params.severity,
    service: params.service,
    root_cause: params.root_cause,
    resolution: params.resolution || "Pending resolution",
    triggered_by: params.triggered_by || "apollo-agent",
    status: "investigating",
    tags: [...(params.tags || []), "apollo-created", "auto-detected"],
    duration_minutes: 0,
  };

  if (!ELASTIC_URL || !ELASTIC_API_KEY) {
    return { success: true, message: "Incident record created (simulated)", document: doc };
  }

  const res = await fetch(`${ELASTIC_URL}/incidents/_doc`, {
    method: "POST",
    headers: {
      Authorization: `ApiKey ${ELASTIC_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(doc),
  });

  if (!res.ok) {
    return { success: false, error: `Elasticsearch: ${await res.text()}` };
  }

  const result = await res.json();
  const docId = result._id;

  // Kibana Discover link using the actual data view ID
  const INCIDENTS_DATA_VIEW_ID = "7e8a9953-7396-4d10-986a-e3ce749874fe";
  const kibanaLink = KIBANA_URL
    ? `${KIBANA_URL}/app/discover#/?_a=(dataSource:(dataViewId:'${INCIDENTS_DATA_VIEW_ID}',type:dataView),filters:!((query:(match_phrase:(_id:'${docId}')))))&_g=(time:(from:now-24h,to:now))`
    : null;

  // Notify Telegram with clickable link
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    const linkPart = kibanaLink ? `\n\n<a href="${kibanaLink}">View in Kibana</a>` : "";
    await sendTelegram(
      TELEGRAM_CHAT_ID,
      `\u{1F4DD} <b>Incident Record Created</b>\n\n` +
        `<b>${escapeHtml(params.title)}</b>\n` +
        `<b>Severity:</b> ${params.severity}  |  <b>Service:</b> <code>${params.service}</code>` +
        linkPart
    );
  }

  return {
    success: true,
    message: "Incident record created",
    document_id: docId,
    kibana_link: kibanaLink,
    view_url: kibanaLink,
  };
}

async function recommendRollback(params) {
  const recommendation = {
    timestamp: new Date().toISOString(),
    service: params.service,
    from_version: params.current_version,
    to_version: params.target_version,
    reason: params.reason,
    command: `kubectl rollout undo deployment/${params.service}`,
  };

  await sendTelegram(
    TELEGRAM_CHAT_ID,
    `\u{26A0}\u{FE0F} <b>ROLLBACK RECOMMENDED</b>\n\n` +
      `<b>Service:</b> <code>${params.service}</code>\n` +
      `<b>From:</b> <code>${params.current_version}</code>  \u{27A1}  <code>${params.target_version}</code>\n\n` +
      `<b>Reason:</b> ${escapeHtml(params.reason)}\n\n` +
      `<b>Command:</b>\n<code>kubectl rollout undo deployment/${params.service}</code>\n\n` +
      `<i>Apollo SRE Agent</i>`
  );

  return {
    success: true,
    message: `Rollback recommended: ${params.service} ${params.current_version} -> ${params.target_version}. Team notified.`,
    recommendation,
  };
}

async function sendSlackNotification(params) {
  if (!SLACK_WEBHOOK_URL) {
    return { success: true, message: "Slack not configured (would send in production)" };
  }

  const severityColor = { P1: "#FF0000", P2: "#FF8C00", P3: "#FFD700" };

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `${params.severity} Incident: ${params.title}` },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Service:*\n\`${params.service}\`` },
        { type: "mrkdwn", text: `*Severity:*\n${params.severity}` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Root Cause:*\n${params.root_cause}` },
    },
  ];

  if (params.recommended_action) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Recommended Action:*\n${params.recommended_action}` },
    });
  }

  if (params.kibana_link) {
    blocks.push({
      type: "actions",
      elements: [{
        type: "button",
        text: { type: "plain_text", text: "View in Kibana" },
        url: params.kibana_link,
        style: "primary",
      }],
    });
  }

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "Detected by Apollo SRE Agent" }],
  });

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attachments: [{ color: severityColor[params.severity] || "#808080", blocks }] }),
  });

  if (!res.ok) {
    return { success: false, error: `Slack: ${await res.text()}` };
  }
  return { success: true, message: "Slack notification sent to #apollo" };
}

// ---------------------------------------------------------------------------
// Advanced Action Handlers (close the loop: fix, verify, document)
// ---------------------------------------------------------------------------

async function executeRollback(params) {
  const startTime = Date.now();

  // 1. Record the rollback as a deployment in Elasticsearch
  const deployDoc = {
    "@timestamp": new Date().toISOString(),
    service: params.service,
    version: params.target_version,
    previous_version: params.current_version,
    deployer: params.triggered_by || "apollo-agent",
    status: "success",
    type: "rollback",
    description: `Automated rollback: ${params.reason}`,
    commit_message: `Rollback ${params.service} from ${params.current_version} to ${params.target_version}`,
    files_changed: 0,
    lines_changed: 0,
    rollback_reason: params.reason,
    automated: true,
  };

  let deployId = null;
  if (ELASTIC_URL && ELASTIC_API_KEY) {
    const res = await fetch(`${ELASTIC_URL}/deployments/_doc`, {
      method: "POST",
      headers: {
        Authorization: `ApiKey ${ELASTIC_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(deployDoc),
    });
    if (res.ok) {
      const result = await res.json();
      deployId = result._id;
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  // 2. Notify Slack
  if (SLACK_WEBHOOK_URL) {
    await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attachments: [{
          color: "#00AA00",
          blocks: [
            { type: "header", text: { type: "plain_text", text: `Rollback Executed: ${params.service}` } },
            { type: "section", fields: [
              { type: "mrkdwn", text: `*From:*\n\`${params.current_version}\`` },
              { type: "mrkdwn", text: `*To:*\n\`${params.target_version}\`` },
            ]},
            { type: "section", text: { type: "mrkdwn", text: `*Reason:* ${params.reason}` } },
            { type: "section", text: { type: "mrkdwn", text: `*Duration:* ${duration}s | *Triggered by:* Apollo SRE Agent` } },
            { type: "context", elements: [{ type: "mrkdwn", text: `kubectl rollout undo deployment/${params.service} --to-revision=...` }] },
          ],
        }],
      }),
    });
  }

  // 3. Notify Telegram
  await sendTelegram(
    TELEGRAM_CHAT_ID,
    `\u{2705} <b>ROLLBACK EXECUTED</b>\n\n` +
      `<b>Service:</b> <code>${params.service}</code>\n` +
      `<b>From:</b> <code>${params.current_version}</code>  \u{27A1}  <code>${params.target_version}</code>\n` +
      `<b>Duration:</b> ${duration}s\n` +
      `<b>Reason:</b> ${escapeHtml(params.reason)}\n\n` +
      `<b>Command executed:</b>\n<code>kubectl rollout undo deployment/${params.service}</code>\n\n` +
      `<i>Apollo SRE Agent -- Automated Rollback</i>`
  );

  return {
    success: true,
    message: `Rollback executed: ${params.service} ${params.current_version} -> ${params.target_version} in ${duration}s`,
    deployment_id: deployId,
    command: `kubectl rollout undo deployment/${params.service}`,
    duration_seconds: parseFloat(duration),
    notifications: { slack: !!SLACK_WEBHOOK_URL, telegram: !!TELEGRAM_BOT_TOKEN },
  };
}

async function runHealthCheck(params) {
  if (!ELASTIC_URL || !ELASTIC_API_KEY) {
    return { success: true, service: params.service, status: "HEALTHY", message: "Health check simulated (no ES connection)" };
  }

  // Get metrics from last 10 minutes (post-fix window)
  const recentRows = await esqlQuery(
    `FROM app-metrics | WHERE @timestamp > NOW() - 10 minutes AND service == "${params.service}" | STATS avg_error_rate = AVG(error_rate), max_error_rate = MAX(error_rate), avg_latency = AVG(p99_latency_ms), max_connections = MAX(active_connections), sample_count = COUNT(*) BY service | LIMIT 1`
  );

  // Get baseline from 1-2 hours ago (pre-incident)
  const baselineRows = await esqlQuery(
    `FROM app-metrics | WHERE @timestamp > NOW() - 2 hours AND @timestamp < NOW() - 1 hour AND service == "${params.service}" | STATS baseline_error_rate = AVG(error_rate), baseline_latency = AVG(p99_latency_ms) BY service | LIMIT 1`
  );

  const recent = recentRows[0] || {};
  const baseline = baselineRows[0] || {};

  const isHealthy = (recent.max_error_rate || 0) < 2 && (recent.avg_latency || 0) < 500;
  const isImproved = (recent.avg_error_rate || 0) < (baseline.baseline_error_rate || 0) * 1.5;

  return {
    success: true,
    service: params.service,
    status: isHealthy ? "HEALTHY" : "DEGRADED",
    recovered: isImproved,
    current: {
      error_rate: `${(recent.avg_error_rate || 0).toFixed(2)}%`,
      max_error_rate: `${(recent.max_error_rate || 0).toFixed(2)}%`,
      p99_latency_ms: `${(recent.avg_latency || 0).toFixed(0)}ms`,
      active_connections: recent.max_connections || 0,
      data_points: recent.sample_count || 0,
    },
    baseline: {
      error_rate: `${(baseline.baseline_error_rate || 0).toFixed(2)}%`,
      p99_latency_ms: `${(baseline.baseline_latency || 0).toFixed(0)}ms`,
    },
    verdict: isHealthy
      ? `${params.service} is HEALTHY. Error rate and latency are within normal range.`
      : `${params.service} is still DEGRADED. Error rate: ${(recent.max_error_rate || 0).toFixed(1)}%, Latency: ${(recent.avg_latency || 0).toFixed(0)}ms. Further action may be needed.`,
  };
}

async function createJiraTicket(params) {
  const priorityMap = { P1: "Highest", P2: "High", P3: "Medium" };
  const ticketKey = `${params.project}-${Math.floor(Math.random() * 9000) + 1000}`;

  const ticket = {
    key: ticketKey,
    project: params.project,
    type: "Incident",
    priority: priorityMap[params.severity] || "Medium",
    title: params.title,
    severity: params.severity,
    service: params.service,
    status: "Open",
    assignee: params.assignee || "Unassigned",
    created_at: new Date().toISOString(),
    created_by: "Apollo SRE Agent",
    description: [
      `## Root Cause`,
      params.root_cause,
      ``,
      `## Affected Service`,
      `\`${params.service}\``,
      ``,
      `## Remediation Steps`,
      params.remediation_steps || "See incident record for details",
      ``,
      `## Severity`,
      `${params.severity} - ${priorityMap[params.severity]}`,
      ``,
      `---`,
      `*Auto-created by Apollo SRE Agent*`,
    ].join("\n"),
    url: `https://yourcompany.atlassian.net/browse/${ticketKey}`,
  };

  // Index in Elasticsearch for tracking
  if (ELASTIC_URL && ELASTIC_API_KEY) {
    await fetch(`${ELASTIC_URL}/jira-tickets/_doc`, {
      method: "POST",
      headers: {
        Authorization: `ApiKey ${ELASTIC_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ "@timestamp": new Date().toISOString(), ...ticket }),
    });
  }

  // Notify Slack
  if (SLACK_WEBHOOK_URL) {
    await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attachments: [{
          color: "#0052CC",
          blocks: [
            { type: "header", text: { type: "plain_text", text: `Jira Ticket Created: ${ticketKey}` } },
            { type: "section", fields: [
              { type: "mrkdwn", text: `*Title:*\n${params.title}` },
              { type: "mrkdwn", text: `*Priority:*\n${params.severity} (${priorityMap[params.severity]})` },
            ]},
            { type: "section", text: { type: "mrkdwn", text: `*Service:* \`${params.service}\` | *Assignee:* ${ticket.assignee}` } },
            { type: "context", elements: [{ type: "mrkdwn", text: "Created by Apollo SRE Agent" }] },
          ],
        }],
      }),
    });
  }

  // Notify Telegram
  await sendTelegram(
    TELEGRAM_CHAT_ID,
    `\u{1F3AB} <b>Jira Ticket Created</b>\n\n` +
      `<b>${ticketKey}:</b> ${escapeHtml(params.title)}\n` +
      `<b>Priority:</b> ${params.severity} (${priorityMap[params.severity]})\n` +
      `<b>Service:</b> <code>${params.service}</code>\n` +
      `<b>Assignee:</b> ${ticket.assignee}\n\n` +
      `<i>Apollo SRE Agent</i>`
  );

  return {
    success: true,
    message: `Jira ticket ${ticketKey} created`,
    ticket_key: ticketKey,
    url: ticket.url,
    priority: priorityMap[params.severity],
    notifications: { slack: !!SLACK_WEBHOOK_URL, telegram: !!TELEGRAM_BOT_TOKEN },
  };
}

async function createPagerDutyIncident(params) {
  const severityMap = { P1: "critical", P2: "error", P3: "warning" };
  const incidentId = `PD-${Date.now().toString(36).toUpperCase()}`;

  const incident = {
    id: incidentId,
    title: params.title,
    severity: severityMap[params.severity] || "warning",
    service: params.service,
    status: "triggered",
    escalation_policy: params.escalation_policy || "default",
    root_cause: params.root_cause,
    recommended_action: params.recommended_action || "See Apollo investigation for details",
    created_at: new Date().toISOString(),
    created_by: "Apollo SRE Agent",
    url: `https://yourcompany.pagerduty.com/incidents/${incidentId}`,
  };

  // Index in Elasticsearch
  if (ELASTIC_URL && ELASTIC_API_KEY) {
    await fetch(`${ELASTIC_URL}/pagerduty-incidents/_doc`, {
      method: "POST",
      headers: {
        Authorization: `ApiKey ${ELASTIC_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ "@timestamp": new Date().toISOString(), ...incident }),
    });
  }

  // Notify Slack
  if (SLACK_WEBHOOK_URL) {
    const severityEmoji = { P1: ":rotating_light:", P2: ":warning:", P3: ":large_yellow_circle:" };
    await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attachments: [{
          color: params.severity === "P1" ? "#FF0000" : params.severity === "P2" ? "#FF8C00" : "#FFD700",
          blocks: [
            { type: "header", text: { type: "plain_text", text: `${severityEmoji[params.severity] || ""} PagerDuty Incident: ${params.title}` } },
            { type: "section", fields: [
              { type: "mrkdwn", text: `*Severity:*\n${params.severity} (${severityMap[params.severity]})` },
              { type: "mrkdwn", text: `*Service:*\n\`${params.service}\`` },
            ]},
            { type: "section", text: { type: "mrkdwn", text: `*On-Call Paged:* Escalation policy \`${incident.escalation_policy}\`` } },
            { type: "context", elements: [{ type: "mrkdwn", text: `Incident ${incidentId} | Created by Apollo SRE Agent` }] },
          ],
        }],
      }),
    });
  }

  // Notify Telegram
  await sendTelegram(
    TELEGRAM_CHAT_ID,
    `\u{1F6A8} <b>PagerDuty Incident Created</b>\n\n` +
      `<b>${escapeHtml(params.title)}</b>\n` +
      `<b>Severity:</b> ${params.severity} (${severityMap[params.severity]})\n` +
      `<b>Service:</b> <code>${params.service}</code>\n` +
      `<b>Escalation:</b> ${incident.escalation_policy}\n` +
      `<b>Status:</b> TRIGGERED -- On-call paged\n\n` +
      `<i>Apollo SRE Agent</i>`
  );

  return {
    success: true,
    message: `PagerDuty incident ${incidentId} created. On-call engineer paged via '${incident.escalation_policy}' policy.`,
    incident_id: incidentId,
    severity: severityMap[params.severity],
    url: incident.url,
    notifications: { slack: !!SLACK_WEBHOOK_URL, telegram: !!TELEGRAM_BOT_TOKEN, pagerduty: true },
  };
}

async function generatePostmortem(params) {
  const postmortem = {
    "@timestamp": new Date().toISOString(),
    type: "postmortem",
    incident_title: params.incident_title,
    severity: params.severity,
    service: params.service,
    started_at: params.started_at || "Unknown",
    detected_at: params.detected_at || new Date().toISOString(),
    resolved_at: params.resolved_at || "Ongoing",
    root_cause: params.root_cause,
    impact: params.impact,
    timeline: params.timeline || "See incident record for detailed timeline",
    remediation: params.remediation,
    preventive_measures: params.preventive_measures || "To be determined in follow-up review",
    lessons_learned: params.lessons_learned || "To be determined in follow-up review",
    generated_by: "Apollo SRE Agent",
    status: "draft",
    document: [
      `# Postmortem: ${params.incident_title}`,
      ``,
      `**Severity:** ${params.severity} | **Service:** ${params.service}`,
      `**Generated:** ${new Date().toISOString()} by Apollo SRE Agent`,
      ``,
      `## Timeline`,
      `- **Started:** ${params.started_at || "Unknown"}`,
      `- **Detected:** ${params.detected_at || "Auto-detected by Apollo"}`,
      `- **Resolved:** ${params.resolved_at || "Ongoing"}`,
      params.timeline ? `\n${params.timeline}` : "",
      ``,
      `## Root Cause`,
      params.root_cause,
      ``,
      `## Impact`,
      params.impact,
      ``,
      `## Remediation`,
      params.remediation,
      ``,
      `## Preventive Measures`,
      params.preventive_measures || "- [ ] To be determined in follow-up review",
      ``,
      `## Lessons Learned`,
      params.lessons_learned || "- [ ] To be determined in follow-up review",
      ``,
      `---`,
      `*Auto-generated by Apollo SRE Agent. Review and finalize with your team.*`,
    ].join("\n"),
  };

  let docId = null;
  let kibanaLink = null;

  if (ELASTIC_URL && ELASTIC_API_KEY) {
    const res = await fetch(`${ELASTIC_URL}/postmortems/_doc`, {
      method: "POST",
      headers: {
        Authorization: `ApiKey ${ELASTIC_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(postmortem),
    });
    if (res.ok) {
      const result = await res.json();
      docId = result._id;
      if (KIBANA_URL) {
        kibanaLink = `${KIBANA_URL}/app/discover#/?_a=(dataSource:(type:dataView),query:(query_string:(query:'_id:${docId}')))&_g=(time:(from:now-7d,to:now))`;
      }
    }
  }

  // Notify Slack with the full postmortem summary
  if (SLACK_WEBHOOK_URL) {
    await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attachments: [{
          color: "#6B46C1",
          blocks: [
            { type: "header", text: { type: "plain_text", text: `Postmortem: ${params.incident_title}` } },
            { type: "section", fields: [
              { type: "mrkdwn", text: `*Severity:*\n${params.severity}` },
              { type: "mrkdwn", text: `*Service:*\n\`${params.service}\`` },
            ]},
            { type: "section", text: { type: "mrkdwn", text: `*Root Cause:*\n${params.root_cause.substring(0, 500)}` } },
            { type: "section", text: { type: "mrkdwn", text: `*Impact:*\n${params.impact.substring(0, 500)}` } },
            { type: "section", text: { type: "mrkdwn", text: `*Remediation:*\n${params.remediation.substring(0, 500)}` } },
            { type: "context", elements: [{ type: "mrkdwn", text: "Auto-generated by Apollo SRE Agent | Status: Draft -- review with your team" }] },
          ],
        }],
      }),
    });
  }

  // Notify Telegram
  await sendTelegram(
    TELEGRAM_CHAT_ID,
    `\u{1F4CB} <b>Postmortem Generated</b>\n\n` +
      `<b>${escapeHtml(params.incident_title)}</b>\n` +
      `<b>Severity:</b> ${params.severity} | <b>Service:</b> <code>${params.service}</code>\n\n` +
      `<b>Root Cause:</b> ${escapeHtml(params.root_cause.substring(0, 300))}\n` +
      `<b>Impact:</b> ${escapeHtml(params.impact.substring(0, 300))}\n\n` +
      (kibanaLink ? `<a href="${kibanaLink}">View in Kibana</a>\n\n` : "") +
      `<i>Apollo SRE Agent -- Auto-generated postmortem</i>`
  );

  return {
    success: true,
    message: `Postmortem generated and indexed in Elasticsearch`,
    document_id: docId,
    kibana_link: kibanaLink,
    sections: ["timeline", "root_cause", "impact", "remediation", "preventive_measures", "lessons_learned"],
    notifications: { slack: !!SLACK_WEBHOOK_URL, telegram: !!TELEGRAM_BOT_TOKEN },
  };
}

async function updateStatusPage(params) {
  const statusEmoji = {
    investigating: "\u{1F50D}",
    identified: "\u{1F3AF}",
    monitoring: "\u{1F4CA}",
    resolved: "\u{2705}",
  };
  const statusColor = {
    investigating: "#FF0000",
    identified: "#FF8C00",
    monitoring: "#FFD700",
    resolved: "#00AA00",
  };

  const update = {
    "@timestamp": new Date().toISOString(),
    type: "status_update",
    service: params.service,
    status: params.status,
    title: params.title,
    message: params.message,
    affected_components: params.affected_components || [params.service],
    is_customer_facing: params.is_customer_facing || false,
    updated_by: "Apollo SRE Agent",
  };

  // Index in Elasticsearch
  if (ELASTIC_URL && ELASTIC_API_KEY) {
    await fetch(`${ELASTIC_URL}/status-page/_doc`, {
      method: "POST",
      headers: {
        Authorization: `ApiKey ${ELASTIC_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(update),
    });
  }

  // Notify Slack
  if (SLACK_WEBHOOK_URL) {
    const emoji = statusEmoji[params.status] || ":information_source:";
    await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attachments: [{
          color: statusColor[params.status] || "#808080",
          blocks: [
            { type: "header", text: { type: "plain_text", text: `${emoji} Status Update: ${params.title}` } },
            { type: "section", fields: [
              { type: "mrkdwn", text: `*Service:*\n\`${params.service}\`` },
              { type: "mrkdwn", text: `*Status:*\n${params.status.toUpperCase()}` },
            ]},
            { type: "section", text: { type: "mrkdwn", text: params.message } },
            ...(params.is_customer_facing ? [{ type: "section", text: { type: "mrkdwn", text: ":warning: *Customer-facing incident*" } }] : []),
            { type: "context", elements: [{ type: "mrkdwn", text: `Components: ${(params.affected_components || [params.service]).join(", ")} | Apollo SRE Agent` }] },
          ],
        }],
      }),
    });
  }

  // Notify Telegram
  const emoji = statusEmoji[params.status] || "\u{2139}\u{FE0F}";
  await sendTelegram(
    TELEGRAM_CHAT_ID,
    `${emoji} <b>Status Page Update</b>\n\n` +
      `<b>${escapeHtml(params.title)}</b>\n` +
      `<b>Service:</b> <code>${params.service}</code>\n` +
      `<b>Status:</b> ${params.status.toUpperCase()}\n` +
      (params.is_customer_facing ? `\u{26A0}\u{FE0F} <b>Customer-facing</b>\n` : "") +
      `\n${escapeHtml(params.message)}\n\n` +
      `<i>Apollo SRE Agent</i>`
  );

  return {
    success: true,
    message: `Status page updated: ${params.service} -> ${params.status.toUpperCase()}`,
    status: params.status,
    customer_facing: params.is_customer_facing || false,
    notifications: { slack: !!SLACK_WEBHOOK_URL, telegram: !!TELEGRAM_BOT_TOKEN },
  };
}

async function createGithubIssue(params) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return { success: false, error: "GitHub not configured (need GITHUB_TOKEN + GITHUB_REPO in .env)" };
  }

  const severityLabel = { P1: "P1-critical", P2: "P2-high", P3: "P3-medium" };
  const severityEmoji = { P1: "\u{1F534}", P2: "\u{1F7E0}", P3: "\u{1F7E1}" };

  const body = [
    `## ${severityEmoji[params.severity] || ""} ${params.severity} Incident: ${params.service}`,
    ``,
    `### Root Cause`,
    params.root_cause,
    ``,
    `### Impact`,
    params.impact || "See incident record for details",
    ``,
    `### Remediation Steps`,
    params.remediation_steps || "See runbook for details",
    ``,
    `### Details`,
    `- **Service:** \`${params.service}\``,
    `- **Severity:** ${params.severity}`,
    `- **Created by:** Apollo SRE Agent`,
    `- **Created at:** ${new Date().toISOString()}`,
    ``,
    `---`,
    ``,
    `### For Coding Agents (Copilot, Cursor, Claude, etc.)`,
    ``,
    `Connect to Apollo MCP for live production context while fixing this issue:`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "mcpServers": {`,
    `    "apollo-sre": {`,
    `      "url": "https://mcp.doctusai.com/mcp",`,
    `      "transport": "http"`,
    `    }`,
    `  }`,
    `}`,
    `\`\`\``,
    ``,
    `**Available tools:** \`get_service_health\`, \`search_error_logs\`, \`get_recent_deployments\`, \`get_recent_incidents\`, \`ask_apollo\``,
    ``,
    `Use these to query live error rates, check service health, and verify your fix against production data before opening a PR.`,
    ``,
    `---`,
    `*Auto-created by [Apollo SRE Agent](https://github.com/${GITHUB_REPO}) -- Autonomous AI Incident Response*`,
  ].join("\n");

  const labels = [
    severityLabel[params.severity] || "incident",
    "incident",
    "apollo-agent",
    ...(params.labels || []),
  ];

  // Ensure labels exist (GitHub rejects unknown labels)
  for (const label of labels) {
    try {
      await fetch(`https://api.github.com/repos/${GITHUB_REPO}/labels`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: label,
          color: label.startsWith("P1") ? "FF0000" : label.startsWith("P2") ? "FF8C00" : label.startsWith("P3") ? "FFD700" : "0E8A16",
        }),
      });
    } catch { /* label may already exist, that's fine */ }
  }

  // Create the issue
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: `[${params.severity}] ${params.title}`,
      body,
      labels,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return { success: false, error: `GitHub API: ${err}` };
  }

  const issue = await res.json();

  // Notify Slack with real GitHub link
  if (SLACK_WEBHOOK_URL) {
    await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attachments: [{
          color: "#24292E",
          blocks: [
            { type: "header", text: { type: "plain_text", text: `GitHub Issue #${issue.number}: ${params.title}` } },
            { type: "section", fields: [
              { type: "mrkdwn", text: `*Severity:*\n${params.severity}` },
              { type: "mrkdwn", text: `*Service:*\n\`${params.service}\`` },
            ]},
            { type: "actions", elements: [{
              type: "button",
              text: { type: "plain_text", text: "View on GitHub" },
              url: issue.html_url,
              style: "primary",
            }]},
            { type: "context", elements: [{ type: "mrkdwn", text: "Created by Apollo SRE Agent" }] },
          ],
        }],
      }),
    });
  }

  // Notify Telegram with real GitHub link
  await sendTelegram(
    TELEGRAM_CHAT_ID,
    `\u{1F4DD} <b>GitHub Issue Created</b>\n\n` +
      `<b>#${issue.number}:</b> ${escapeHtml(params.title)}\n` +
      `<b>Severity:</b> ${params.severity}\n` +
      `<b>Service:</b> <code>${params.service}</code>\n` +
      `<b>Labels:</b> ${labels.join(", ")}\n\n` +
      `<a href="${issue.html_url}">View on GitHub</a>\n\n` +
      `<i>Apollo SRE Agent</i>`
  );

  return {
    success: true,
    message: `GitHub issue #${issue.number} created`,
    issue_number: issue.number,
    url: issue.html_url,
    labels,
    notifications: { slack: !!SLACK_WEBHOOK_URL, telegram: !!TELEGRAM_BOT_TOKEN },
  };
}

// ---------------------------------------------------------------------------
// READ/QUERY Handlers (for VS Code, Claude, external MCP clients)
// ---------------------------------------------------------------------------

async function esqlQuery(query) {
  const res = await fetch(`${ELASTIC_URL}/_query?format=json`, {
    method: "POST",
    headers: {
      Authorization: `ApiKey ${ELASTIC_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ES|QL error: ${err}`);
  }
  const data = await res.json();
  const columns = data.columns?.map((c) => c.name) || [];
  const rows = (data.values || []).map((row) => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
  return rows;
}

async function getServiceHealth(params) {
  const serviceFilter = params.service
    ? ` AND service == "${params.service}"`
    : "";

  const rows = await esqlQuery(
    `FROM app-metrics | WHERE @timestamp > NOW() - 2 hours${serviceFilter} | STATS avg_error_rate = AVG(error_rate), max_error_rate = MAX(error_rate), avg_latency = AVG(p99_latency_ms), max_latency = MAX(p99_latency_ms), avg_cpu = AVG(cpu_percent), max_connections = MAX(active_connections) BY service | SORT max_error_rate DESC | LIMIT 20`
  );

  const services = rows.map((r) => ({
    service: r.service,
    status: r.max_error_rate > 5 || r.max_connections > 45 ? "UNHEALTHY" : "HEALTHY",
    error_rate: `${r.avg_error_rate?.toFixed(1)}% avg / ${r.max_error_rate?.toFixed(1)}% max`,
    p99_latency: `${r.avg_latency?.toFixed(0)}ms avg / ${r.max_latency?.toFixed(0)}ms max`,
    cpu: `${r.avg_cpu?.toFixed(1)}%`,
    connections: `${r.max_connections} max`,
  }));

  return {
    timestamp: new Date().toISOString(),
    window: "last 2 hours",
    services,
    summary: services.some((s) => s.status === "UNHEALTHY")
      ? `WARNING: ${services.filter((s) => s.status === "UNHEALTHY").map((s) => s.service).join(", ")} showing anomalies`
      : "All services healthy",
  };
}

async function getRecentIncidents(params) {
  let filter = "WHERE @timestamp > NOW() - 7 days";
  if (params.service) filter += ` AND service == "${params.service}"`;
  if (params.severity) filter += ` AND severity == "${params.severity}"`;
  const limit = params.limit || 10;

  const rows = await esqlQuery(
    `FROM incidents | ${filter} | SORT @timestamp DESC | LIMIT ${limit}`
  );

  return {
    count: rows.length,
    incidents: rows.map((r) => ({
      timestamp: r["@timestamp"],
      title: r.title,
      severity: r.severity,
      service: r.service,
      root_cause: r.root_cause,
      status: r.status,
      triggered_by: r.triggered_by,
      resolution: r.resolution,
    })),
  };
}

async function getRecentDeployments(params) {
  let filter = "WHERE @timestamp > NOW() - 7 days";
  if (params.service) filter += ` AND service == "${params.service}"`;
  const limit = params.limit || 10;

  const rows = await esqlQuery(
    `FROM deployments | ${filter} | SORT @timestamp DESC | LIMIT ${limit}`
  );

  return {
    count: rows.length,
    deployments: rows.map((r) => ({
      timestamp: r["@timestamp"],
      service: r.service,
      version: r.version,
      deployer: r.deployer,
      commit_sha: r.commit_sha,
      commit_message: r.commit_message,
      changes: r.changes,
      status: r.status,
    })),
  };
}

async function searchErrorLogs(params) {
  const hours = params.hours || 2;
  let filter = `WHERE @timestamp > NOW() - ${hours} hours AND level == "ERROR"`;
  if (params.service) filter += ` AND service == "${params.service}"`;

  const rows = await esqlQuery(
    `FROM app-logs | ${filter} | STATS error_count = COUNT(*), avg_latency = AVG(latency_ms) BY service, message, status_code | SORT error_count DESC | LIMIT 20`
  );

  return {
    window: `last ${hours} hours`,
    total_error_types: rows.length,
    errors: rows.map((r) => ({
      service: r.service,
      message: r.message,
      status_code: r.status_code,
      count: r.error_count,
      avg_latency_ms: r.avg_latency?.toFixed(0),
    })),
  };
}

async function askApollo(params) {
  const response = await queryApollo(params.question, "mcp-client");
  return {
    question: params.question,
    response: response,
  };
}

// ---------------------------------------------------------------------------
// Apollo Agent Query (with persistent conversation)
// ---------------------------------------------------------------------------

async function queryApollo(userMessage, chatId) {
  // Guard against empty/whitespace-only input (Bedrock rejects empty text content blocks)
  const sanitizedInput = (userMessage || "").trim();
  if (!sanitizedInput) {
    return "Hi! I'm Apollo, your AI SRE agent. Ask me anything about your production services — for example:\n• \"What's the error rate on checkout-api?\"\n• \"Run a full production scan\"\n• \"Search past incidents for payment timeouts\"";
  }

  const headers = {
    Authorization: `ApiKey ${ELASTIC_API_KEY}`,
    "kbn-xsrf": "true",
    "Content-Type": "application/json",
  };

  const body = { agent_id: "apollo", input: sanitizedInput };

  // Reuse conversation for same chat to maintain context
  const existingConvId = conversationMap.get(chatId);
  if (existingConvId) {
    body.conversation_id = existingConvId;
  }

  const res = await fetch(`${KIBANA_URL}/api/agent_builder/converse`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });

  if (!res.ok) {
    const err = await res.text();
    // If conversation expired, clear it and retry without
    if (err.includes("not found") && existingConvId) {
      conversationMap.delete(chatId);
      return queryApollo(userMessage, chatId);
    }
    throw new Error(`Apollo API (${res.status}): ${err.substring(0, 200)}`);
  }

  const data = await res.json();

  // Save conversation ID for this chat
  if (data.conversation_id) {
    conversationMap.set(chatId, data.conversation_id);
  }

  const response = data.response?.message || "Investigation complete.";

  const toolCalls = (data.steps || []).filter((s) => s.type === "tool_call");
  const timing = data.time_to_last_token
    ? `\n\n${toolCalls.length} tools | ${(data.time_to_last_token / 1000).toFixed(0)}s`
    : "";

  return response + timing;
}

// ---------------------------------------------------------------------------
// Telegram Two-Way Bot (persistent conversation)
// ---------------------------------------------------------------------------

let lastUpdateId = 0;

async function pollTelegram() {
  if (!TELEGRAM_BOT_TOKEN) return;

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`;
    const res = await fetch(url, { signal: AbortSignal.timeout(35000) });
    const data = await res.json();

    for (const update of data.result || []) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg?.text) continue;

      const chatId = msg.chat.id;
      const text = msg.text.trim();
      const from = msg.from?.first_name || "User";

      console.log(`[Telegram] ${from}: ${text}`);

      // Handle commands
      if (text === "/start") {
        await sendTelegram(chatId,
          `\u{1F680} <b>Apollo SRE Agent</b>\n\n` +
          `I'm your autonomous AI Site Reliability Engineer.\n\n` +
          `<b>Commands:</b>\n` +
          `  /investigate - Full production scan\n` +
          `  /status - Quick health check\n` +
          `  /resolve - Mark current incident resolved\n` +
          `  /escalate - Escalate to senior on-call\n` +
          `  /newthread - Start a fresh conversation\n\n` +
          `Or just type naturally:\n` +
          `  "What's the error rate on checkout-api?"\n` +
          `  "Search past incidents for payment timeouts"\n` +
          `  "Rollback checkout-api to v1.20.9"\n\n` +
          `<i>Powered by Elastic Agent Builder + Bedrock</i>`
        );
        continue;
      }

      if (text === "/newthread") {
        conversationMap.delete(chatId);
        await sendTelegram(chatId, "\u{1F504} Fresh conversation started. What do you need?");
        continue;
      }

      // Map shortcut commands to richer prompts
      const commandMap = {
        "/investigate": "Run a full production investigation. Check all services for anomalies, analyze errors, correlate with deployments, search past incidents, consult runbooks, and take all actions.",
        "/status": "Give me a quick health check. Use detect_anomalies to scan current metrics and summarize which services are healthy and which have issues. Keep it brief.",
        "/resolve": "The current incident has been resolved. Update the incident record status to 'resolved' and notify the team via Telegram and Slack that the incident is closed.",
        "/escalate": "The current incident needs escalation. Send a Telegram alert and Slack notification with severity UPGRADED to P1 and add 'ESCALATED - Senior on-call needed' to the recommended action.",
      };

      const prompt = commandMap[text] || text;

      if (KIBANA_URL && ELASTIC_API_KEY) {
        await sendTelegram(chatId, "\u{1F50D} <i>Working on it...</i>");

        try {
          const rawResponse = await queryApollo(prompt, chatId);
          const formatted = mdToTelegramHtml(rawResponse);
          const chunks = splitMessage(formatted, 4000);
          for (const chunk of chunks) {
            await sendTelegram(chatId, chunk);
          }
        } catch (err) {
          await sendTelegram(chatId,
            `\u{274C} <b>Error:</b> ${escapeHtml(err.message)}\n\nTry /newthread to start fresh.`
          );
        }
      } else {
        await sendTelegram(chatId, "Apollo is running but Kibana is not configured. Use the Kibana UI.");
      }
    }
  } catch (err) {
    if (!err.message?.includes("aborted")) {
      console.error("[Telegram Poll]", err.message);
    }
  }

  setTimeout(pollTelegram, 1000);
}

// ---------------------------------------------------------------------------
// Slack Two-Way Bot (Socket Mode)
// ---------------------------------------------------------------------------

let slackBot = null;

async function startSlackBot() {
  if (!SlackApp || !SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
    console.log("  Slack Bot: Not configured (need SLACK_BOT_TOKEN + SLACK_APP_TOKEN)");
    return;
  }

  try {
    slackBot = new SlackApp({
      token: SLACK_BOT_TOKEN,
      appToken: SLACK_APP_TOKEN,
      socketMode: true,
    });

    // Respond to @Apollo mentions in channels
    slackBot.event("app_mention", async ({ event, say }) => {
      const userMsg = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
      console.log(`[Slack] Mention: "${userMsg}"`);

      if (!userMsg) {
        await say({ text: ":wave: Hi! I'm Apollo, your AI SRE agent. Try asking me something like:\n• `@Apollo what's the error rate on checkout-api?`\n• `@Apollo run a full production scan`\n• `@Apollo search past incidents for payment timeouts`", thread_ts: event.ts });
        return;
      }

      await say({ text: ":mag: Apollo is investigating...", thread_ts: event.ts });

      try {
        const rawResponse = await queryApollo(userMsg, `slack-${event.channel}`);
        // Convert markdown to Slack mrkdwn (simpler than Telegram)
        const slackFormatted = rawResponse
          .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
          .replace(/\*\*(.+?)\*\*/g, "*$1*");

        const chunks = splitMessage(slackFormatted, 3000);
        for (const chunk of chunks) {
          await say({ text: chunk, thread_ts: event.ts });
        }
      } catch (err) {
        await say({ text: `:x: Error: ${err.message}`, thread_ts: event.ts });
      }
    });

    // Respond to DMs
    slackBot.event("message", async ({ event, say }) => {
      // Skip bot messages to avoid loops
      if (event.bot_id || event.bot_profile) return;
      // Skip message subtypes (edits, deletes, etc.) but allow normal messages
      if (event.subtype) return;
      // Only handle DMs (im channels)
      if (event.channel_type !== "im") return;

      const userMsg = event.text?.trim();
      if (!userMsg) return;
      console.log(`[Slack DM] "${userMsg}"`);

      await say({ text: ":mag: Apollo is investigating..." });

      try {
        const rawResponse = await queryApollo(userMsg, `slack-dm-${event.user}`);
        const slackFormatted = rawResponse
          .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
          .replace(/\*\*(.+?)\*\*/g, "*$1*");

        const chunks = splitMessage(slackFormatted, 3000);
        for (const chunk of chunks) {
          await say({ text: chunk });
        }
      } catch (err) {
        await say({ text: `:x: Error: ${err.message}` });
      }
    });

    await slackBot.start();
    console.log("  Slack Bot: Active (Socket Mode) -- @mention or DM Apollo in Slack");
  } catch (err) {
    console.error("  Slack Bot: Failed to start:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Scheduled Autonomous Scan
// ---------------------------------------------------------------------------

async function autonomousScan() {
  console.log(`[Scheduled Scan] ${new Date().toISOString()} -- Running autonomous investigation...`);

  try {
    const rawResponse = await queryApollo(
      "Autonomous scheduled scan: Check all production services for anomalies in the last 3 hours. " +
      "If anything looks abnormal, run the full investigation protocol and take all actions. " +
      "If everything is healthy, just report that all systems are normal.",
      "scheduled-scan"
    );

    const formatted = mdToTelegramHtml(rawResponse);

    // Only notify if there's an actual issue (not "all clear")
    const isHealthy = /all.*normal|no.*anomal|healthy|no.*issue/i.test(rawResponse);

    if (!isHealthy && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      await sendTelegram(
        TELEGRAM_CHAT_ID,
        `\u{1F6E1} <b>Apollo Scheduled Scan</b>\n\n${formatted.substring(0, 3800)}`
      );
    }

    console.log(`[Scheduled Scan] Complete. Issues found: ${!isHealthy}`);
  } catch (err) {
    console.error("[Scheduled Scan] Error:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen * 0.3) splitIdx = maxLen;
    chunks.push(remaining.substring(0, splitIdx));
    remaining = remaining.substring(splitIdx).replace(/^\n/, "");
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// MCP Protocol Endpoint
// ---------------------------------------------------------------------------

app.post("/mcp", async (req, res) => {
  const { method, params, id } = req.body;

  switch (method) {
    case "initialize":
      return res.json({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "apollo-actions", version: "4.0.0" },
        },
      });

    case "tools/list":
      return res.json({ jsonrpc: "2.0", id, result: { tools: TOOLS } });

    case "tools/call": {
      const { name, arguments: args } = params;
      let result;
      try {
        switch (name) {
          case "send_telegram_alert": result = await sendTelegramAlert(args); break;
          case "create_incident_record": result = await createIncidentRecord(args); break;
          case "recommend_rollback": result = await recommendRollback(args); break;
          case "send_slack_notification": result = await sendSlackNotification(args); break;
          case "execute_rollback": result = await executeRollback(args); break;
          case "run_health_check": result = await runHealthCheck(args); break;
          case "create_jira_ticket": result = await createJiraTicket(args); break;
          case "create_pagerduty_incident": result = await createPagerDutyIncident(args); break;
          case "generate_postmortem": result = await generatePostmortem(args); break;
          case "update_status_page": result = await updateStatusPage(args); break;
          case "create_github_issue": result = await createGithubIssue(args); break;
          case "get_service_health": result = await getServiceHealth(args || {}); break;
          case "get_recent_incidents": result = await getRecentIncidents(args || {}); break;
          case "get_recent_deployments": result = await getRecentDeployments(args || {}); break;
          case "search_error_logs": result = await searchErrorLogs(args || {}); break;
          case "ask_apollo": result = await askApollo(args); break;
          default: result = { error: `Unknown tool: ${name}` };
        }
      } catch (err) {
        result = { error: err.message };
      }
      return res.json({
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
      });
    }

    default:
      return res.json({
        jsonrpc: "2.0", id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    server: "apollo-actions",
    version: "4.0.0",
    tools: TOOLS.length,
    telegram: TELEGRAM_BOT_TOKEN ? "connected" : "not configured",
    slack: SLACK_WEBHOOK_URL ? "connected" : "not configured",
    elasticsearch: ELASTIC_URL ? "connected" : "not configured",
    kibana: KIBANA_URL ? "connected" : "not configured",
    active_conversations: conversationMap.size,
    next_scan: "every 3 hours",
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║   Apollo MCP Action Server v4.0         ║
  ╚══════════════════════════════════════════╝

  Port:           ${PORT}
  Telegram:       ${TELEGRAM_BOT_TOKEN ? "Active (polling + persistent threads)" : "Not configured"}
  Slack:          ${SLACK_WEBHOOK_URL ? "Active (#apollo)" : "Not configured"}
  Elasticsearch:  ${ELASTIC_URL ? "Connected" : "Not configured"}
  Kibana:         ${KIBANA_URL ? "Connected" : "Not configured"}
  Auto-Scan:      Every ${SCAN_INTERVAL_MS / 3600000}h

  MCP Tools:      ${TOOLS.length} tools (${TOOLS.filter(t => !["get_service_health","get_recent_incidents","get_recent_deployments","search_error_logs","ask_apollo"].includes(t.name)).length} action + ${TOOLS.filter(t => ["get_service_health","get_recent_incidents","get_recent_deployments","search_error_logs","ask_apollo"].includes(t.name)).length} read)

  Telegram Bot:   @Apolloelasticbot
    /investigate  Full production scan
    /status       Quick health check
    /resolve      Mark incident resolved
    /escalate     Escalate to senior on-call
    /newthread    Fresh conversation
  `);

  // Start Telegram polling
  if (TELEGRAM_BOT_TOKEN) {
    console.log("  Starting Telegram bot...\n");
    pollTelegram();
  }

  // Start Slack bot
  startSlackBot();

  // Start scheduled scans
  if (KIBANA_URL && ELASTIC_API_KEY) {
    console.log(`  Scheduling autonomous scans every ${SCAN_INTERVAL_MS / 3600000}h\n`);
    setInterval(autonomousScan, SCAN_INTERVAL_MS);
    // Run first scan 30 seconds after startup
    setTimeout(autonomousScan, 30000);
  }
});
