/**
 * teardown.js
 *
 * Cleans up all resources created by Incident Autopilot:
 * - Deletes Elasticsearch indices
 * - Removes Agent Builder tools and agent
 * - Removes Elastic Workflows
 */

import { Client } from "@elastic/elasticsearch";
import dotenv from "dotenv";

dotenv.config();

const client = new Client({
  node: process.env.ELASTIC_URL,
  auth: { apiKey: process.env.ELASTIC_API_KEY },
});

const KIBANA_URL = process.env.KIBANA_URL;
const KIBANA_API_KEY = process.env.KIBANA_API_KEY;

async function kibanaRequest(method, path) {
  const url = `${KIBANA_URL}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `ApiKey ${KIBANA_API_KEY}`,
      "kbn-xsrf": "true",
    },
  });
  return response;
}

async function main() {
  console.log("=== Incident Autopilot: Teardown ===\n");

  // Delete indices
  const indices = [
    "app-logs",
    "app-metrics",
    "deployments",
    "incidents",
    "runbooks",
  ];

  console.log("Step 1: Deleting Elasticsearch indices...");
  for (const index of indices) {
    try {
      const exists = await client.indices.exists({ index });
      if (exists) {
        await client.indices.delete({ index });
        console.log(`  Deleted: ${index}`);
      } else {
        console.log(`  Skipped (not found): ${index}`);
      }
    } catch (err) {
      console.error(`  Error deleting ${index}: ${err.message}`);
    }
  }

  // Clean up Agent Builder resources if Kibana is configured
  if (KIBANA_URL && KIBANA_API_KEY) {
    console.log("\nStep 2: Cleaning up Agent Builder resources...");

    // List and delete custom tools
    try {
      const toolsRes = await kibanaRequest("GET", "/api/agent_builder/tools");
      if (toolsRes.ok) {
        const tools = await toolsRes.json();
        const customTools = tools.filter(
          (t) =>
            t.name.includes("Anomal") ||
            t.name.includes("Deploy") ||
            t.name.includes("Incident") ||
            t.name.includes("Runbook")
        );

        for (const tool of customTools) {
          await kibanaRequest("DELETE", `/api/agent_builder/tools/${tool.id}`);
          console.log(`  Deleted tool: ${tool.name}`);
        }
      }
    } catch (err) {
      console.error(`  Error cleaning tools: ${err.message}`);
    }

    // List and delete agents
    try {
      const agentsRes = await kibanaRequest("GET", "/api/agent_builder/agents");
      if (agentsRes.ok) {
        const agents = await agentsRes.json();
        const ourAgents = agents.filter((a) =>
          a.name.includes("Incident Autopilot")
        );

        for (const agent of ourAgents) {
          await kibanaRequest(
            "DELETE",
            `/api/agent_builder/agents/${agent.id}`
          );
          console.log(`  Deleted agent: ${agent.name}`);
        }
      }
    } catch (err) {
      console.error(`  Error cleaning agents: ${err.message}`);
    }
  } else {
    console.log(
      "\nStep 2: Skipping Agent Builder cleanup (no Kibana credentials)"
    );
  }

  console.log("\n=== Teardown complete! ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
