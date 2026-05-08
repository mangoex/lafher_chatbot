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
  node lafhia_n8n_client.mjs audit-workflow --file workflow.json
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

function buildGraph(workflow) {
  const nodes = workflow.nodes || [];
  const nodeNames = new Set(nodes.map((node) => node.name));
  const incoming = Object.fromEntries(nodes.map((node) => [node.name, 0]));
  const outgoing = Object.fromEntries(nodes.map((node) => [node.name, 0]));
  const edges = [];

  for (const [source, outputs] of Object.entries(workflow.connections || {})) {
    for (const [outputType, groups] of Object.entries(outputs || {})) {
      if (outputType !== 'main') continue;
      (groups || []).forEach((group, outputIndex) => {
        (group || []).forEach((edge) => {
          edges.push({ from: source, output: outputIndex, to: edge.node, input: edge.index ?? 0 });
          outgoing[source] = (outgoing[source] || 0) + 1;
          incoming[edge.node] = (incoming[edge.node] || 0) + 1;
        });
      });
    }
  }

  return {
    incoming,
    outgoing,
    edges,
    missingTargets: edges.filter((edge) => !nodeNames.has(edge.to)),
    missingSources: Object.keys(workflow.connections || {}).filter((source) => !nodeNames.has(source)),
  };
}

function collectPromptLabels(workflow) {
  const promptNode = workflow.nodes?.find((node) => node.name === 'Preparar prompt');
  const code = promptNode?.parameters?.jsCode || '';
  const labels = [...code.matchAll(/LABEL:([a-zA-Z0-9_-]+)/g)].map((match) => match[1]);
  return {
    labels: [...new Set(labels)],
    counts: labels.reduce((acc, label) => {
      acc[label] = (acc[label] || 0) + 1;
      return acc;
    }, {}),
  };
}

function collectExternalServices(workflow) {
  const services = new Set();
  for (const node of workflow.nodes || []) {
    const blob = JSON.stringify(node.parameters || {});
    if (blob.includes('chatwoot-production-4e8e.up.railway.app')) services.add('Chatwoot');
    if (blob.includes('sagi.lafher.mx')) services.add('SAGI');
    if (blob.includes('openrouter.ai')) services.add('OpenRouter');
    if (blob.includes('api.groq.com')) services.add('Groq transcription');
    if (blob.includes('api.resend.com')) services.add('Resend email');
    if (blob.includes('html2pdf.app')) services.add('html2pdf');
    if (node.type === 'n8n-nodes-base.googleDrive') services.add('Google Drive');
    if (node.type === 'n8n-nodes-base.whatsApp') services.add('WhatsApp Meta');
  }
  return [...services].sort();
}

function auditWorkflow(workflow) {
  const graph = buildGraph(workflow);
  const silence = auditSilence(workflow);
  const promptLabels = collectPromptLabels(workflow);
  const nodeNames = new Set((workflow.nodes || []).map((node) => node.name));
  const terminalNodes = (workflow.nodes || []).filter((node) => (graph.outgoing[node.name] || 0) === 0).map((node) => node.name);
  const nonTriggerNoIncoming = (workflow.nodes || [])
    .filter((node) => !node.type?.toLowerCase().includes('trigger') && node.type !== 'n8n-nodes-base.webhook')
    .filter((node) => (graph.incoming[node.name] || 0) === 0)
    .map((node) => node.name);
  const potentiallyUnwiredLabels = promptLabels.labels.filter((label) => !['entrega-vivienda'].includes(label));
  const issues = [];

  if (!workflow.active) issues.push({ severity: 'critical', code: 'workflow_inactive', message: 'El workflow no está activo.' });
  if (graph.missingTargets.length || graph.missingSources.length) issues.push({ severity: 'critical', code: 'broken_connections', message: 'Hay conexiones con nodos origen/destino inexistentes.' });
  if (!silence.trueOutputHasRespuestaEscalado || !silence.falseOutputHasNormalPath || silence.hasAutoReset) issues.push({ severity: 'critical', code: 'escalation_silence_broken', message: 'La ruta de silencio/escalamiento no está completamente protegida.' });
  if (nonTriggerNoIncoming.length) issues.push({ severity: 'medium', code: 'disconnected_nodes', message: `Nodos sin entrada: ${nonTriggerNoIncoming.join(', ')}` });
  if (potentiallyUnwiredLabels.length) issues.push({ severity: 'low', code: 'labels_need_review', message: `Etiquetas mencionadas en prompt que conviene revisar si están cableadas: ${potentiallyUnwiredLabels.join(', ')}` });

  return {
    generatedAt: new Date().toISOString(),
    workflow: {
      id: workflow.id,
      name: workflow.name,
      active: workflow.active,
      nodeCount: workflow.nodes?.length || 0,
      updatedAt: workflow.updatedAt,
      versionId: workflow.versionId,
      settings: workflow.settings,
    },
    graph: { edgeCount: graph.edges.length, missingTargets: graph.missingTargets, missingSources: graph.missingSources, terminalNodes, nonTriggerNoIncoming },
    criticalPaths: {
      webhookToIncoming: graph.edges.some((edge) => edge.from === 'Webhook' && edge.to === 'IF incoming'),
      incomingToAudio: graph.edges.some((edge) => edge.from === 'IF incoming' && edge.to === '¿Audio?'),
      silence,
      orderPathPresent: nodeNames.has('IF ORDER_COMPLETE') && nodeNames.has('Generar HTML orden'),
      escalationPathPresent: nodeNames.has('IF ESCALATE') && nodeNames.has('Etiquetar ESCALATE') && nodeNames.has('Reasignar a agente'),
      sagiPathPresent: nodeNames.has('¿Token SAGI válido?') && nodeNames.has('GET Clientes SAGI') && nodeNames.has('Buscar nombre en SAGI'),
    },
    labels: {
      promptLabels,
      wiredLabels: nodeNames.has('IF LABEL entrega_vivienda') && nodeNames.has('Etiquetar entrega_vivienda') ? ['entrega-vivienda -> entrega_vivienda'] : [],
      potentiallyUnwiredLabels,
    },
    externalServices: collectExternalServices(workflow),
    issues,
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

  if (command === 'audit-workflow') {
    const file = argValue('--file');
    const workflow = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(JSON.stringify(auditWorkflow(workflow), null, 2));
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
    const allowedNodeChanges = summary.changedNodes.length === 0
      || summary.changedNodes.join(',') === 'Leer historial';
    if (!allowedNodeChanges) {
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
