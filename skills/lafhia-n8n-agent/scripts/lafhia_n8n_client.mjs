#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://n8n-new-production-0154.up.railway.app';
const DEFAULT_WORKFLOW_ID = '2UBCDcgO9bWmatbn';

function usage() {
  console.log(`Usage:
  node lafhia_n8n_client.mjs fetch [--out file]
  node lafhia_n8n_client.mjs audit-silence --file workflow.json
  node lafhia_n8n_client.mjs patch-silence --file workflow.json --out patched.json
  node lafhia_n8n_client.mjs apply-silence-patch

Environment:
  N8N_API_KEY                 required for fetch/apply
  LAFHIA_N8N_BASE_URL         optional, defaults to ${DEFAULT_BASE_URL}
  LAFHIA_WORKFLOW_ID          optional, defaults to ${DEFAULT_WORKFLOW_ID}
`);
}

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function apiConfig() {
  return {
    baseUrl: process.env.LAFHIA_N8N_BASE_URL || DEFAULT_BASE_URL,
    workflowId: process.env.LAFHIA_WORKFLOW_ID || DEFAULT_WORKFLOW_ID,
    apiKey: process.env.N8N_API_KEY || '',
  };
}

async function fetchWorkflow() {
  const { baseUrl, workflowId, apiKey } = apiConfig();
  if (!apiKey) throw new Error('N8N_API_KEY is required');

  const response = await fetch(`${baseUrl}/api/v1/workflows/${workflowId}`, {
    headers: {
      'X-N8N-API-KEY': apiKey,
      Accept: 'application/json',
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET workflow failed ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

async function putWorkflow(workflow) {
  const { baseUrl, workflowId, apiKey } = apiConfig();
  if (!apiKey) throw new Error('N8N_API_KEY is required');

  const body = {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: {
      executionOrder: workflow.settings?.executionOrder,
      callerPolicy: workflow.settings?.callerPolicy,
      availableInMCP: workflow.settings?.availableInMCP,
    },
    staticData: workflow.staticData,
  };

  const response = await fetch(`${baseUrl}/api/v1/workflows/${workflowId}`, {
    method: 'PUT',
    headers: {
      'X-N8N-API-KEY': apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`PUT workflow failed ${response.status}: ${text.slice(0, 800)}`);
  }
  return JSON.parse(text);
}

function findNode(workflow, name) {
  const node = workflow.nodes?.find((candidate) => candidate.name === name);
  if (!node) throw new Error(`Node not found: ${name}`);
  return node;
}

function auditSilence(workflow) {
  const leer = findNode(workflow, 'Leer historial');
  const code = leer.parameters?.jsCode || '';
  const trueOut = (workflow.connections?.['IF bot silenciado']?.main?.[0] || []).map((edge) => edge.node);
  const falseOut = (workflow.connections?.['IF bot silenciado']?.main?.[1] || []).map((edge) => edge.node);

  return {
    workflowName: workflow.name,
    workflowId: workflow.id,
    active: workflow.active,
    nodeCount: workflow.nodes?.length || 0,
    updatedAt: workflow.updatedAt,
    versionId: workflow.versionId,
    hasAutoReset: code.includes('sd[`bot_silenciado_${conversationId}`] = false'),
    hasPersistentComment: code.includes('Mantener silencio persistente'),
    trueOutput: trueOut,
    falseOutput: falseOut,
    trueOutputHasRespuestaEscalado: trueOut.includes('Respuesta escalado'),
    falseOutputHasNormalPath: falseOut.includes('IF propietario_validado'),
  };
}

function patchSilence(workflow) {
  const patched = JSON.parse(JSON.stringify(workflow));
  const leer = findNode(patched, 'Leer historial');
  const code = leer.parameters?.jsCode || '';
  const hasAutoReset = code.includes('sd[`bot_silenciado_${conversationId}`] = false');
  const hasPersistentLogic = code.includes("const botSilenciado = labels.includes('escalado')")
    && code.includes('sd[`bot_silenciado_${conversationId}`]');

  if (hasAutoReset) {
    const start = code.indexOf('const labels = wb.body.conversation?.labels || [];');
    const end = code.indexOf('\n\nreturn [{', start);
    if (start < 0 || end < 0) {
      throw new Error('Could not locate silence block in Leer historial');
    }
    const oldSegment = code.slice(start, end);
    if (!oldSegment.includes('labels.includes')) {
      throw new Error('Silence block does not match the expected labels pattern');
    }

    const newSegment = [
      "const labels = wb.body.conversation?.labels || [];",
      "// Mantener silencio persistente tras escalamiento. No se limpia por payloads sin label,",
      "// porque Chatwoot puede enviar eventos incompletos o templates de agente sin labels.",
      "const botSilenciado = labels.includes('escalado')",
      "                || sd[`bot_silenciado_${conversationId}`]",
      "                || false;",
    ].join('\n');
    leer.parameters.jsCode = code.slice(0, start) + newSegment + code.slice(end);
  } else if (!hasPersistentLogic) {
    throw new Error('Silence code is neither old auto-reset nor known persistent form');
  }

  patched.connections ||= {};
  patched.connections['IF bot silenciado'] ||= { main: [] };
  patched.connections['IF bot silenciado'].main ||= [];
  patched.connections['IF bot silenciado'].main[0] ||= [];
  patched.connections['IF bot silenciado'].main[1] ||= [];

  const trueOutput = patched.connections['IF bot silenciado'].main[0];
  if (!trueOutput.some((edge) => edge.node === 'Respuesta escalado')) {
    trueOutput.push({ node: 'Respuesta escalado', type: 'main', index: 0 });
  }

  return patched;
}

function changedSummary(before, after) {
  const changedNodes = (after.nodes || [])
    .filter((node, index) => JSON.stringify(node) !== JSON.stringify(before.nodes?.[index]))
    .map((node) => node.name);
  const sources = new Set([
    ...Object.keys(before.connections || {}),
    ...Object.keys(after.connections || {}),
  ]);
  const changedConnectionSources = [...sources].filter(
    (source) => JSON.stringify(before.connections?.[source]) !== JSON.stringify(after.connections?.[source]),
  );
  return { changedNodes, changedConnectionSources };
}

async function main() {
  const command = process.argv[2];
  if (!command || command === '--help' || command === '-h') {
    usage();
    return;
  }

  if (command === 'fetch') {
    const workflow = await fetchWorkflow();
    const out = argValue('--out', path.join(os.tmpdir(), 'lafhia-workflow.json'));
    fs.writeFileSync(out, JSON.stringify(workflow, null, 2));
    console.log(JSON.stringify({
      out,
      name: workflow.name,
      id: workflow.id,
      active: workflow.active,
      nodes: workflow.nodes?.length || 0,
      updatedAt: workflow.updatedAt,
      versionId: workflow.versionId,
    }, null, 2));
    return;
  }

  if (command === 'audit-silence') {
    const file = argValue('--file');
    const workflow = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(JSON.stringify(auditSilence(workflow), null, 2));
    return;
  }

  if (command === 'patch-silence') {
    const file = argValue('--file');
    const out = argValue('--out', path.join(os.tmpdir(), 'lafhia-workflow-patched.json'));
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    const after = patchSilence(before);
    fs.writeFileSync(out, JSON.stringify(after, null, 2));
    console.log(JSON.stringify({ out, ...changedSummary(before, after), audit: auditSilence(after) }, null, 2));
    return;
  }

  if (command === 'apply-silence-patch') {
    const before = await fetchWorkflow();
    const backup = path.join(os.tmpdir(), `lafhia-before-${Date.now()}.json`);
    fs.writeFileSync(backup, JSON.stringify(before, null, 2));
    const after = patchSilence(before);
    const summary = changedSummary(before, after);
    if (summary.changedNodes.join(',') !== 'Leer historial') {
      throw new Error(`Unexpected changed nodes: ${summary.changedNodes.join(', ')}`);
    }
    if (summary.changedConnectionSources.join(',') !== 'IF bot silenciado') {
      throw new Error(`Unexpected changed connection sources: ${summary.changedConnectionSources.join(', ')}`);
    }
    await putWorkflow(after);
    const saved = await fetchWorkflow();
    console.log(JSON.stringify({
      backup,
      saved: auditSilence(saved),
      changedNodes: summary.changedNodes,
      changedConnectionSources: summary.changedConnectionSources,
    }, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
