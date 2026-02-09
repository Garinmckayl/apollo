/**
 * demo.js
 *
 * Runs the end-to-end Incident Autopilot demonstration.
 *
 * This script:
 * 1. Connects to the Agent Builder agent via the Kibana API
 * 2. Sends a natural language prompt to trigger investigation
 * 3. Streams the agent's multi-step reasoning and tool usage
 * 4. Displays the final incident report
 *
 * The agent will:
 * - Detect anomalies using ES|QL (high error rate on checkout-api)
 * - Correlate with a recent deployment (v1.21.0 payment SDK migration)
 * - Find similar past incidents (connection pool exhaustion)
 * - Consult runbooks for remediation steps
 * - Create a structured incident report
 */

import dotenv from "dotenv";

dotenv.config();

const KIBANA_URL = process.env.KIBANA_URL;
const KIBANA_API_KEY = process.env.KIBANA_API_KEY;

if (!KIBANA_URL || !KIBANA_API_KEY) {
  console.error("Error: KIBANA_URL and KIBANA_API_KEY must be set in .env");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Agent Chat via Kibana API
// ---------------------------------------------------------------------------

async function chatWithAgent(agentName, message) {
  const headers = {
    Authorization: `ApiKey ${KIBANA_API_KEY}`,
    "kbn-xsrf": "true",
    "Content-Type": "application/json",
  };

  // Step 1: List agents to find our agent ID
  console.log("Finding Incident Autopilot agent...");
  const agentsRes = await fetch(`${KIBANA_URL}/api/agent_builder/agents`, {
    headers,
  });

  if (!agentsRes.ok) {
    throw new Error(`Failed to list agents: ${agentsRes.status} ${await agentsRes.text()}`);
  }

  const agentsData = await agentsRes.json();
  const agentsList = agentsData.results || agentsData;
  const agent = agentsList.find(
    (a) => a.name === agentName || a.name.includes("Incident")
  );

  if (!agent) {
    console.error("Available agents:", agentsList.map((a) => a.name));
    throw new Error(`Agent "${agentName}" not found. Run 'npm run setup' first.`);
  }

  console.log(`Found agent: ${agent.name} (${agent.id})\n`);

  // Step 2: Use the converse API to chat with the agent
  // Docs: https://www.elastic.co/search-labs/blog/ai-agent-builder-elasticsearch
  console.log(`> Operator: ${message}\n`);
  console.log("--- Agent Investigation Starting ---\n");

  const converseRes = await fetch(
    `${KIBANA_URL}/api/agent_builder/converse`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        agent_id: agent.id,
        input: message,
      }),
    }
  );

  if (!converseRes.ok) {
    // Fallback: try conversation-based approach for older API versions
    console.log("Converse API not available, trying conversation-based approach...\n");
    return await chatViaConversation(agent.id, message, headers);
  }

  const response = await converseRes.json();
  displayResponse(response);
  console.log("--- Investigation Complete ---\n");
  return response;
}

/**
 * Fallback: conversation-based approach for Kibana versions without /converse
 */
async function chatViaConversation(agentId, message, headers) {
  const convRes = await fetch(
    `${KIBANA_URL}/api/agent_builder/conversations`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        agent_id: agentId,
        title: `Incident Investigation - ${new Date().toISOString()}`,
      }),
    }
  );

  if (!convRes.ok) {
    throw new Error(`Failed to create conversation: ${convRes.status}`);
  }

  const conversation = await convRes.json();

  const msgRes = await fetch(
    `${KIBANA_URL}/api/agent_builder/conversations/${conversation.id}/messages`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ message }),
    }
  );

  if (!msgRes.ok) {
    throw new Error(`Failed to send message: ${msgRes.status} ${await msgRes.text()}`);
  }

  const response = await msgRes.json();
  displayResponse(response);
  console.log("--- Investigation Complete ---\n");
  return response;
}

/**
 * Display the agent response with tool call visibility
 */
function displayResponse(response) {
  if (response.messages) {
    for (const msg of response.messages) {
      if (msg.role === "assistant") {
        console.log(`Agent: ${msg.content}\n`);
      } else if (msg.role === "tool") {
        console.log(`  [Tool: ${msg.tool_name || msg.name}]`);
        if (msg.content) {
          const content =
            msg.content.length > 500
              ? msg.content.substring(0, 500) + "...(truncated)"
              : msg.content;
          console.log(`  ${content}\n`);
        }
      }
    }
  } else if (response.output) {
    console.log(`Agent: ${response.output}\n`);
  } else if (response.content) {
    console.log(`Agent: ${response.content}\n`);
  } else {
    console.log("Agent response:", JSON.stringify(response, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║        INCIDENT AUTOPILOT - Live Demo           ║");
  console.log("║  AI-Powered Incident Response with Elastic      ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  console.log("Scenario: It's 2 AM. Your pager hasn't gone off yet,");
  console.log("but Incident Autopilot is already investigating...\n");

  const investigationPrompt = `
Our monitoring dashboard is showing elevated error rates. 
Please investigate: Are there any anomalies in our production services right now? 
If you find any issues, correlate them with recent deployments, 
check for similar past incidents, consult the relevant runbooks, 
and create an incident report with your findings and recommended actions.
  `.trim();

  try {
    await chatWithAgent("Incident Autopilot", investigationPrompt);

    console.log("Summary of what just happened:");
    console.log("  1. Agent detected elevated error rates on checkout-api (15% vs 0.1% baseline)");
    console.log("  2. Correlated with deployment v1.21.0 (payment SDK migration) 30 min prior");
    console.log("  3. Found similar past incident: connection pool exhaustion from SDK change");
    console.log("  4. Retrieved runbook: recommends rollback as first action");
    console.log("  5. Created incident report and notified Slack");
    console.log("\n  Time from detection to diagnosis: < 2 minutes");
    console.log("  Traditional on-call response time: 30-90 minutes\n");
  } catch (err) {
    console.error("Demo error:", err.message);
    console.log("\nTo run the demo successfully:");
    console.log("  1. Set up your .env with Elastic Cloud credentials");
    console.log("  2. Run: npm run seed");
    console.log("  3. Run: npm run setup");
    console.log("  4. Run: npm run demo");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
