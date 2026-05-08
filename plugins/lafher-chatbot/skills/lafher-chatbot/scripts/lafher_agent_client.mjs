#!/usr/bin/env node

const DEFAULT_BASE_URL = 'https://lafherchatbot-production.up.railway.app';

function usage() {
  console.log(`Usage:
  node lafher_agent_client.mjs health
  node lafher_agent_client.mjs agent
  node lafher_agent_client.mjs audit
  node lafher_agent_client.mjs audit-silence
  node lafher_agent_client.mjs history
  node lafher_agent_client.mjs snapshot
  node lafher_agent_client.mjs cleanup
  node lafher_agent_client.mjs apply-silence-patch

Environment:
  LAFHER_AGENT_BASE_URL       optional, defaults to ${DEFAULT_BASE_URL}
  LAFHER_AGENT_ADMIN_TOKEN    required for history/snapshot/cleanup/apply-silence-patch
`);
}

function config() {
  return {
    baseUrl: process.env.LAFHER_AGENT_BASE_URL || DEFAULT_BASE_URL,
    adminToken: process.env.LAFHER_AGENT_ADMIN_TOKEN || '',
  };
}

function endpointFor(action) {
  const map = {
    health: ['GET', '/health', false],
    agent: ['GET', '/agent', false],
    audit: ['GET', '/lafhia/audit-workflow', false],
    'audit-silence': ['GET', '/lafhia/audit-silence', false],
    history: ['GET', '/lafhia/audit-history', true],
    snapshot: ['POST', '/lafhia/snapshot', true],
    cleanup: ['POST', '/admin/cleanup', true],
    'apply-silence-patch': ['POST', '/lafhia/apply-silence-patch', true],
  };
  return map[action];
}

async function main() {
  const action = process.argv[2];
  if (!action || action === '--help' || action === '-h') {
    usage();
    return;
  }

  const route = endpointFor(action);
  if (!route) {
    usage();
    process.exitCode = 1;
    return;
  }

  const [method, path, needsAuth] = route;
  const cfg = config();
  if (needsAuth && !cfg.adminToken) {
    throw new Error('LAFHER_AGENT_ADMIN_TOKEN is required for this action');
  }

  const headers = { accept: 'application/json' };
  if (needsAuth) {
    headers.authorization = `Bearer ${cfg.adminToken}`;
  }

  const response = await fetch(new URL(path, cfg.baseUrl), { method, headers });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const message = payload.error || payload.message || response.statusText;
    throw new Error(`${response.status} ${message}`);
  }

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
