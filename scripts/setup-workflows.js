/**
 * setup-workflows.js
 *
 * Creates the Elastic Workflow for incident creation and notification.
 * This workflow is triggered by the Agent Builder workflow tool.
 *
 * Docs: https://www.elastic.co/docs/explore-analyze/workflows
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
    // 409 = already exists, which is fine
    if (response.status === 409) {
      console.log(`    -> Workflow already exists, skipping...`);
      return null;
    }
    throw new Error(
      `Kibana API ${method} ${path} failed (${response.status}): ${text}`
    );
  }

  return text ? JSON.parse(text) : null;
}

async function main() {
  console.log("=== Incident Autopilot: Setting Up Workflows ===\n");

  const workflowPath = resolve(
    PROJECT_ROOT,
    "workflows",
    "create-incident.json"
  );
  const workflowDef = JSON.parse(readFileSync(workflowPath, "utf-8"));

  console.log("Creating workflow: Create Incident and Notify...");

  try {
    const result = await kibanaRequest(
      "POST",
      "/api/workflows",
      workflowDef
    );

    if (result) {
      console.log(`    -> Workflow created with ID: ${result.id || workflowDef.id}`);
    }
  } catch (err) {
    console.error(`    -> Error: ${err.message}`);
  }

  console.log("\n=== Workflow setup complete! ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
