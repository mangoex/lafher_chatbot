import http from 'node:http';

const DEFAULT_BASE_URL = 'https://n8n-new-production-0154.up.railway.app';
const DEFAULT_WORKFLOW_ID = '2UBCDcgO9bWmatbn';

function config() {
  return {
    port: Number(process.env.PORT || 3000),
    adminToken: process.env.AGENT_ADMIN_TOKEN || '',
    n8nApiKey: process.env.N8N_API_KEY || '',
    baseUrl: process.env.LAFHIA_N8N_BASE_URL || DEFAULT_BASE_URL,
    workflowId: process.env.LAFHIA_WORKFLOW_ID || DEFAULT_WORKFLOW_ID,
  };
}

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload, null, 2));
}

function requireAdmin(req, cfg) {
  if (!cfg.adminToken) return false;
  return req.headers.authorization === `Bearer ${cfg.adminToken}`;
}

async function fetchWorkflow(cfg) {
  if (!cfg.n8nApiKey) {
    throw new Error('N8N_API_KEY is not configured');
  }

  const response = await fetch(`${cfg.baseUrl}/api/v1/workflows/${cfg.workflowId}`, {
    headers: {
      'X-N8N-API-KEY': cfg.n8nApiKey,
      accept: 'application/json',
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`n8n GET failed ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

async function putWorkflow(cfg, workflow) {
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

  const response = await fetch(`${cfg.baseUrl}/api/v1/workflows/${cfg.workflowId}`, {
    method: 'PUT',
    headers: {
      'X-N8N-API-KEY': cfg.n8nApiKey,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`n8n PUT failed ${response.status}: ${text.slice(0, 800)}`);
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
  const trueOutput = (workflow.connections?.['IF bot silenciado']?.main?.[0] || []).map((edge) => edge.node);
  const falseOutput = (workflow.connections?.['IF bot silenciado']?.main?.[1] || []).map((edge) => edge.node);

  return {
    workflowName: workflow.name,
    workflowId: workflow.id,
    active: workflow.active,
    nodeCount: workflow.nodes?.length || 0,
    updatedAt: workflow.updatedAt,
    versionId: workflow.versionId,
    hasAutoReset: code.includes('sd[`bot_silenciado_${conversationId}`] = false'),
    hasPersistentComment: code.includes('Mantener silencio persistente'),
    trueOutput,
    falseOutput,
    trueOutputHasRespuestaEscalado: trueOutput.includes('Respuesta escalado'),
    falseOutputHasNormalPath: falseOutput.includes('IF propietario_validado'),
  };
}

function patchSilence(workflow) {
  const patched = JSON.parse(JSON.stringify(workflow));
  const leer = findNode(patched, 'Leer historial');
  const code = leer.parameters?.jsCode || '';
  const start = code.indexOf('const labels = wb.body.conversation?.labels || [];');
  const end = code.indexOf('\n\nreturn [{', start);

  if (start < 0 || end < 0) {
    throw new Error('Could not locate silence block in Leer historial');
  }

  const oldSegment = code.slice(start, end);
  if (!oldSegment.includes('labels.includes') || !oldSegment.includes('sd[`bot_silenciado_${conversationId}`] = false')) {
    throw new Error('Silence block does not match the expected auto-reset pattern');
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

async function handler(req, res) {
  const cfg = config();
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true, service: 'lafher-chatbot-agent' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/agent') {
      json(res, 200, {
        name: 'lafhia-n8n-agent',
        workflowId: cfg.workflowId,
        baseUrl: cfg.baseUrl,
        capabilities: ['audit-silence', 'apply-silence-patch'],
        secretsConfigured: {
          n8nApiKey: Boolean(cfg.n8nApiKey),
          adminToken: Boolean(cfg.adminToken),
        },
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/lafhia/audit-silence') {
      const workflow = await fetchWorkflow(cfg);
      json(res, 200, auditSilence(workflow));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/lafhia/apply-silence-patch') {
      if (!requireAdmin(req, cfg)) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }

      const before = await fetchWorkflow(cfg);
      const after = patchSilence(before);
      const summary = changedSummary(before, after);

      if (summary.changedNodes.join(',') !== 'Leer historial') {
        throw new Error(`Unexpected changed nodes: ${summary.changedNodes.join(', ')}`);
      }
      if (summary.changedConnectionSources.join(',') !== 'IF bot silenciado') {
        throw new Error(`Unexpected changed connection sources: ${summary.changedConnectionSources.join(', ')}`);
      }

      await putWorkflow(cfg, after);
      const saved = await fetchWorkflow(cfg);
      json(res, 200, {
        changedNodes: summary.changedNodes,
        changedConnectionSources: summary.changedConnectionSources,
        saved: auditSilence(saved),
      });
      return;
    }

    json(res, 404, { error: 'not_found' });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

if (process.argv.includes('--check')) {
  const cfg = config();
  console.log(JSON.stringify({
    ok: true,
    node: process.version,
    baseUrl: cfg.baseUrl,
    workflowId: cfg.workflowId,
    hasAdminToken: Boolean(cfg.adminToken),
    hasN8nApiKey: Boolean(cfg.n8nApiKey),
  }, null, 2));
} else {
  const cfg = config();
  http.createServer(handler).listen(cfg.port, () => {
    console.log(`lafher-chatbot-agent listening on ${cfg.port}`);
  });
}
