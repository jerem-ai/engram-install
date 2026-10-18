#!/usr/bin/env node
/**
 * Call engram_recall through one stdio MCP server command, the way Claude Code or
 * Codex launches it, and print the evidence it returns (Gate 4 of the out-of-box plan).
 *
 *   node smoke-mcp-recall.mjs --query "<text>" -- <command> [args...]
 *
 * The server inherits this process's environment (HOME and friends), so run it under
 * the install's HOME. Prints { tools, status, evidence: [{source_node_id, object}] }.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const qi = argv.indexOf("--query");
if (sep < 0 || qi < 0 || qi > sep) { console.error("usage: smoke-mcp-recall.mjs --query TEXT -- COMMAND [ARGS...]"); process.exit(64); }
const query = argv[qi + 1];
const [command, ...args] = argv.slice(sep + 1);

const transport = new StdioClientTransport({ command, args, env: process.env, stderr: "pipe" });
const client = new Client({ name: "engram-oob-smoke", version: "1" });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  const res = await client.callTool({ name: "engram_recall", arguments: { query } });
  const body = JSON.parse(res.content?.[0]?.text ?? "{}");
  const result = body.result ?? body;
  const evidence = (result.answer_contract?.evidence ?? result.evidence ?? []).map((e) => ({
    source_node_id: e.source_node_id, subject: e.subject, predicate: e.predicate, object: e.object,
  }));
  console.log(JSON.stringify({ tools, status: result.status ?? null, evidence }, null, 1));
} finally {
  await client.close().catch(() => {});
}
