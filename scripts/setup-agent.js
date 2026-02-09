/**
 * setup-agent.js
 *
 * Creates the Agent Builder custom tools and agent via the Kibana API.
 * API reference: https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/kibana-api
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

const KIBANA_URL = process.env.KIBANA_URL;
const KIBANA_API_KEY = process.env.KIBANA_API_KEY;

if (!KIBANA_URL || !KIBANA_API_KEY) {
  console.error("Error: KIBANA_URL and KIBANA_API_KEY must be set in .env");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Kibana API Helper
// ---------------------------------------------------------------------------

async function kibanaRequest(method, path, body = null) {
  const url = `${KIBANA_URL}${path}`;
  const headers = {
    Authorization: `ApiKey ${KIBANA_API_KEY}`,
    "kbn-xsrf": "true",
    "Content-Type": "application/json",
  };

  const options = { method, headers };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const text = await response.text();

  if (!response.ok) {
    // 409 = already exists
    if (response.status === 409) {
      return { id: body?.id, _alreadyExists: true };
    }
    throw new Error(
      `Kibana API ${method} ${path} failed (${response.status}): ${text}`
    );
  }

  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// Tool Creation -- matching exact Kibana API schema
// ---------------------------------------------------------------------------

/**
 * Create an ES|QL tool.
 * Schema: { id, type: "esql", description, tags, configuration: { query, params } }
 */
async function createEsqlTool(toolDef) {
  console.log(`  Creating ES|QL tool: ${toolDef.id}`);

  const body = {
    id: toolDef.id,
    type: "esql",
    description: toolDef.description,
    tags: ["incident-autopilot", "observability"],
    configuration: {
      query: toolDef.esql_query,
    },
  };

  // Add params if defined -- types must be Elasticsearch types
  if (toolDef.parameters) {
    body.configuration.params = {};
    // Map our types to valid ES types
    const typeMap = { string: "keyword", integer: "integer", float: "float", date: "date" };
    for (const [key, val] of Object.entries(toolDef.parameters)) {
      body.configuration.params[key] = {
        type: typeMap[val.type] || "keyword",
        description: val.description,
      };
    }
  }

  return kibanaRequest("POST", "/api/agent_builder/tools", body);
}

/**
 * Create an Index Search tool.
 * Schema: { id, type: "index", description, tags, configuration: { index, ... } }
 */
async function createIndexSearchTool(toolDef) {
  console.log(`  Creating Index Search tool: ${toolDef.id}`);

  return kibanaRequest("POST", "/api/agent_builder/tools", {
    id: toolDef.id,
    type: "index_search",
    description: toolDef.description,
    tags: ["incident-autopilot", "observability"],
    configuration: {
      pattern: toolDef.index,
    },
  });
}

/**
 * Create a Workflow tool.
 */
async function createWorkflowTool(toolDef) {
  console.log(`  Creating Workflow tool: ${toolDef.id}`);

  return kibanaRequest("POST", "/api/agent_builder/tools", {
    id: toolDef.id,
    type: "workflow",
    description: toolDef.description,
    tags: ["incident-autopilot", "actions"],
    configuration: {
      workflow_id: toolDef.workflow_id,
    },
  });
}

// ---------------------------------------------------------------------------
// Agent Creation -- matching exact Kibana API schema
// ---------------------------------------------------------------------------

async function createAgent(agentDef, toolIds) {
  console.log(`  Creating agent: ${agentDef.name}`);

  return kibanaRequest("POST", "/api/agent_builder/agents", {
    id: "incident-autopilot",
    name: agentDef.name,
    description: agentDef.description,
    labels: ["incident-response", "observability", "sre"],
    avatar_color: "#E8A317",
    avatar_symbol: "AP",
    configuration: {
      instructions: agentDef.system_prompt,
      tools: [
        {
          tool_ids: toolIds,
        },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Incident Autopilot: Setting Up Agent Builder ===\n");

  // Tool definitions -- 3 ES|QL + 3 Index Search (skip workflow for serverless)
  const toolFiles = [
    { file: "detect-anomalies.json", creator: createEsqlTool },
    { file: "analyze-errors.json", creator: createEsqlTool },
    { file: "correlate-deploys.json", creator: createEsqlTool },
    { file: "search-deploys.json", creator: createIndexSearchTool },
    { file: "search-incidents.json", creator: createIndexSearchTool },
    { file: "search-runbooks.json", creator: createIndexSearchTool },
  ];

  console.log("Step 1: Creating custom tools...");
  const createdToolIds = [];

  for (const { file, creator } of toolFiles) {
    const toolPath = resolve(PROJECT_ROOT, "tools", file);
    const toolDef = JSON.parse(readFileSync(toolPath, "utf-8"));

    try {
      const result = await creator(toolDef);
      if (result?._alreadyExists) {
        console.log(`    -> Already exists: ${toolDef.id}`);
      } else {
        console.log(`    -> Created: ${result?.id || toolDef.id}`);
      }
      createdToolIds.push(toolDef.id);
    } catch (err) {
      console.error(`    -> Error: ${err.message}`);
      // Still add the ID -- it might exist already
      createdToolIds.push(toolDef.id);
    }
  }

  console.log(`\n  Tool IDs: ${createdToolIds.join(", ")}\n`);

  // Create agent
  console.log("Step 2: Creating Incident Autopilot agent...");
  const agentPath = resolve(PROJECT_ROOT, "agents", "incident-autopilot.json");
  const agentDef = JSON.parse(readFileSync(agentPath, "utf-8"));

  try {
    const agent = await createAgent(agentDef, createdToolIds);
    if (agent?._alreadyExists) {
      console.log(`    -> Agent already exists, updating...`);
      // Update instead
      await kibanaRequest("PUT", "/api/agent_builder/agents/incident-autopilot", {
        name: agentDef.name,
        description: agentDef.description,
        labels: ["incident-response", "observability", "sre"],
        avatar_color: "#E8A317",
        avatar_symbol: "AP",
        configuration: {
          instructions: agentDef.system_prompt,
          tools: [{ tool_ids: createdToolIds }],
        },
      });
      console.log(`    -> Agent updated.`);
    } else {
      console.log(`    -> Created: ${agent?.id || "incident-autopilot"}`);
    }
  } catch (err) {
    console.error(`    -> Error: ${err.message}`);
  }

  console.log("\n=== Agent Builder setup complete! ===");
  console.log(`
Next steps:
  1. Open Kibana -> Agent Builder (left nav -> Agents)
  2. Select the "Incident Autopilot" agent from the dropdown
  3. Ask: "Are there any anomalies in our production services?"
  4. Or run: npm run demo
`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
