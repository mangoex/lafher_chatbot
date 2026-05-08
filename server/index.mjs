import http from 'node:http';
import { createHash } from 'node:crypto';
import pg from 'pg';

const DEFAULT_BASE_URL = 'https://n8n-new-production-0154.up.railway.app';
const DEFAULT_WORKFLOW_ID = '2UBCDcgO9bWmatbn';
const { Pool } = pg;
let dbPool = null;

function config() {
  return {
    port: Number(process.env.PORT || 3000),
    adminToken: process.env.AGENT_ADMIN_TOKEN || '',
    n8nApiKey: process.env.N8N_API_KEY || '',
    baseUrl: process.env.LAFHIA_N8N_BASE_URL || DEFAULT_BASE_URL,
    workflowId: process.env.LAFHIA_WORKFLOW_ID || DEFAULT_WORKFLOW_ID,
    databaseUrl: process.env.DATABASE_URL || '',
    auditRetentionDays: Number(process.env.AUDIT_RETENTION_DAYS || 90),
    patchRetentionDays: Number(process.env.PATCH_RETENTION_DAYS || 365),
    maxSnapshots: Number(process.env.MAX_WORKFLOW_SNAPSHOTS || 20),
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

function getDb(cfg) {
  if (!cfg.databaseUrl) return null;
  if (!dbPool) {
    dbPool = new Pool({
      connectionString: cfg.databaseUrl,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }
  return dbPool;
}

async function ensureDb(cfg) {
  const db = getDb(cfg);
  if (!db) return { configured: false };

  await db.query(`
    CREATE TABLE IF NOT EXISTS agent_audit_events (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      action TEXT NOT NULL,
      workflow_id TEXT,
      workflow_name TEXT,
      workflow_version_id TEXT,
      workflow_hash TEXT,
      success BOOLEAN NOT NULL DEFAULT true,
      summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      error TEXT
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_snapshots (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      workflow_id TEXT NOT NULL,
      workflow_name TEXT,
      workflow_version_id TEXT,
      workflow_hash TEXT NOT NULL,
      reason TEXT NOT NULL,
      is_patch_snapshot BOOLEAN NOT NULL DEFAULT false,
      snapshot_json JSONB NOT NULL,
      UNIQUE (workflow_id, workflow_hash)
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS idx_agent_audit_events_created_at ON agent_audit_events (created_at DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_workflow_snapshots_workflow_created ON workflow_snapshots (workflow_id, created_at DESC)');
  return { configured: true };
}

function sanitizeForStorage(value, key = '') {
  const secretKey = /(api[_-]?key|apikey|api_access_token|authorization|bearer|password|secret|token|credential)/i;
  if (value === null || value === undefined) return value;
  if (secretKey.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
      .replace(/eyJ[A-Za-z0-9._-]{20,}/g, '[JWT_REDACTED]')
      .replace(/sk-[A-Za-z0-9._-]+/g, 'sk-[REDACTED]')
      .replace(/(api[_-]?key|apiKey|api_access_token|authorization|password|secret|token)(["'\s:=]+)[^"',}\s]+/gi, '$1$2[REDACTED]');
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForStorage(item));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeForStorage(childValue, childKey)]),
    );
  }
  return value;
}

function workflowHash(workflow) {
  const sanitized = sanitizeForStorage(workflow);
  const serialized = JSON.stringify(sanitized);
  return {
    hash: createHash('sha256').update(serialized).digest('hex'),
    sanitized,
  };
}

function auditSummaryPayload(audit) {
  return {
    active: audit.workflow?.active,
    nodeCount: audit.workflow?.nodeCount,
    edgeCount: audit.graph?.edgeCount,
    issueCount: audit.issues?.length || 0,
    issues: audit.issues || [],
    criticalPaths: audit.criticalPaths,
    labels: audit.labels,
    externalServices: audit.externalServices,
  };
}

async function cleanupRetention(cfg) {
  const db = getDb(cfg);
  if (!db) return { configured: false };
  await ensureDb(cfg);

  const auditRetentionDays = Math.max(1, cfg.auditRetentionDays);
  const patchRetentionDays = Math.max(auditRetentionDays, cfg.patchRetentionDays);
  const maxSnapshots = Math.max(1, cfg.maxSnapshots);

  const oldAudit = await db.query(
    `DELETE FROM agent_audit_events
     WHERE action <> 'apply_silence_patch'
       AND created_at < now() - ($1::int * interval '1 day')`,
    [auditRetentionDays],
  );
  const oldPatch = await db.query(
    `DELETE FROM agent_audit_events
     WHERE action = 'apply_silence_patch'
       AND created_at < now() - ($1::int * interval '1 day')`,
    [patchRetentionDays],
  );
  const oldSnapshots = await db.query(
    `DELETE FROM workflow_snapshots s
     WHERE s.is_patch_snapshot = false
       AND s.id NOT IN (
         SELECT id FROM workflow_snapshots
         WHERE is_patch_snapshot = false
         ORDER BY created_at DESC
         LIMIT $1
       )`,
    [maxSnapshots],
  );
  return {
    configured: true,
    deleted: {
      auditEvents: oldAudit.rowCount,
      patchEvents: oldPatch.rowCount,
      snapshots: oldSnapshots.rowCount,
    },
    retention: { auditRetentionDays, patchRetentionDays, maxSnapshots },
  };
}

async function recordAuditEvent(cfg, event) {
  const db = getDb(cfg);
  if (!db) return { configured: false, inserted: false };
  await ensureDb(cfg);
  await db.query(
    `INSERT INTO agent_audit_events
      (action, workflow_id, workflow_name, workflow_version_id, workflow_hash, success, summary, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      event.action,
      event.workflowId || null,
      event.workflowName || null,
      event.workflowVersionId || null,
      event.workflowHash || null,
      event.success !== false,
      JSON.stringify(event.summary || {}),
      event.error || null,
    ],
  );
  return { configured: true, inserted: true };
}

async function saveWorkflowSnapshot(cfg, workflow, reason, isPatchSnapshot = false) {
  const db = getDb(cfg);
  if (!db) return { configured: false, inserted: false };
  await ensureDb(cfg);
  const { hash, sanitized } = workflowHash(workflow);
  const result = await db.query(
    `INSERT INTO workflow_snapshots
      (workflow_id, workflow_name, workflow_version_id, workflow_hash, reason, is_patch_snapshot, snapshot_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (workflow_id, workflow_hash) DO NOTHING
     RETURNING id, created_at`,
    [
      workflow.id,
      workflow.name,
      workflow.versionId,
      hash,
      reason,
      isPatchSnapshot,
      JSON.stringify(sanitized),
    ],
  );
  return {
    configured: true,
    inserted: result.rowCount === 1,
    id: result.rows[0]?.id || null,
    hash,
  };
}

async function getAuditHistory(cfg, limit = 20) {
  const db = getDb(cfg);
  if (!db) return { configured: false, events: [], snapshots: [] };
  await ensureDb(cfg);
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const events = await db.query(
    `SELECT id, created_at, action, workflow_id, workflow_name, workflow_version_id,
            workflow_hash, success, summary, error
     FROM agent_audit_events
     ORDER BY created_at DESC
     LIMIT $1`,
    [safeLimit],
  );
  const snapshots = await db.query(
    `SELECT id, created_at, workflow_id, workflow_name, workflow_version_id,
            workflow_hash, reason, is_patch_snapshot
     FROM workflow_snapshots
     ORDER BY created_at DESC
     LIMIT $1`,
    [safeLimit],
  );
  return { configured: true, events: events.rows, snapshots: snapshots.rows };
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
          edges.push({
            from: source,
            output: outputIndex,
            to: edge.node,
            input: edge.index ?? 0,
          });
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
  const terminalNodes = (workflow.nodes || [])
    .filter((node) => (graph.outgoing[node.name] || 0) === 0)
    .map((node) => node.name);
  const nonTriggerNoIncoming = (workflow.nodes || [])
    .filter((node) => !node.type?.toLowerCase().includes('trigger') && node.type !== 'n8n-nodes-base.webhook')
    .filter((node) => (graph.incoming[node.name] || 0) === 0)
    .map((node) => node.name);

  const expectedNodes = [
    'Webhook',
    'IF incoming',
    'Leer historial',
    'IF bot silenciado',
    'Respuesta escalado',
    'IF propietario_validado',
    'Preparar prompt',
    'OpenRouter',
    'Guardar historial',
    'IF ESCALATE',
    'IF ORDER_COMPLETE',
  ];
  const nodeNames = new Set((workflow.nodes || []).map((node) => node.name));
  const missingExpectedNodes = expectedNodes.filter((name) => !nodeNames.has(name));

  const issues = [];
  if (!workflow.active) {
    issues.push({ severity: 'critical', code: 'workflow_inactive', message: 'El workflow no está activo.' });
  }
  if (graph.missingTargets.length || graph.missingSources.length) {
    issues.push({ severity: 'critical', code: 'broken_connections', message: 'Hay conexiones con nodos origen/destino inexistentes.' });
  }
  if (!silence.trueOutputHasRespuestaEscalado || !silence.falseOutputHasNormalPath || silence.hasAutoReset) {
    issues.push({ severity: 'critical', code: 'escalation_silence_broken', message: 'La ruta de silencio/escalamiento no está completamente protegida.' });
  }
  if (missingExpectedNodes.length) {
    issues.push({ severity: 'high', code: 'missing_expected_nodes', message: `Faltan nodos esperados: ${missingExpectedNodes.join(', ')}` });
  }
  if (nonTriggerNoIncoming.length) {
    issues.push({ severity: 'medium', code: 'disconnected_nodes', message: `Nodos sin entrada: ${nonTriggerNoIncoming.join(', ')}` });
  }

  const wiredLabels = [];
  if (nodeNames.has('IF LABEL entrega_vivienda') && nodeNames.has('Etiquetar entrega_vivienda')) {
    wiredLabels.push('entrega-vivienda -> entrega_vivienda');
  }
  const potentiallyUnwiredLabels = promptLabels.labels.filter(
    (label) => !['entrega-vivienda'].includes(label),
  );
  if (potentiallyUnwiredLabels.length) {
    issues.push({
      severity: 'low',
      code: 'labels_need_review',
      message: `Etiquetas mencionadas en prompt que conviene revisar si están cableadas: ${potentiallyUnwiredLabels.join(', ')}`,
    });
  }

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
    graph: {
      edgeCount: graph.edges.length,
      missingTargets: graph.missingTargets,
      missingSources: graph.missingSources,
      terminalNodes,
      nonTriggerNoIncoming,
    },
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
      wiredLabels,
      potentiallyUnwiredLabels,
    },
    externalServices: collectExternalServices(workflow),
    issues,
    recommendations: [
      'Mantener cambios de producción por API pública y con diff verificado.',
      'Mover secretos hardcodeados a credenciales/variables si se autoriza una mejora de seguridad.',
      'Revisar etiquetas de prompt no cableadas antes de depender de ellas en Chatwoot.',
      'Agregar snapshots/auditoría persistente en Postgres antes de ampliar acciones de escritura.',
    ],
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
        capabilities: ['audit-silence', 'audit-workflow', 'snapshot', 'audit-history', 'cleanup', 'apply-silence-patch'],
        secretsConfigured: {
          n8nApiKey: Boolean(cfg.n8nApiKey),
          adminToken: Boolean(cfg.adminToken),
          databaseUrl: Boolean(cfg.databaseUrl),
        },
        retention: {
          auditRetentionDays: cfg.auditRetentionDays,
          patchRetentionDays: cfg.patchRetentionDays,
          maxSnapshots: cfg.maxSnapshots,
        },
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/lafhia/audit-silence') {
      const workflow = await fetchWorkflow(cfg);
      json(res, 200, auditSilence(workflow));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/lafhia/audit-workflow') {
      const workflow = await fetchWorkflow(cfg);
      const audit = auditWorkflow(workflow);
      const { hash } = workflowHash(workflow);
      let storage = { configured: Boolean(cfg.databaseUrl), recorded: false };
      if (url.searchParams.get('record') === 'true') {
        if (!requireAdmin(req, cfg)) {
          json(res, 401, { error: 'unauthorized' });
          return;
        }
        await cleanupRetention(cfg);
        const record = await recordAuditEvent(cfg, {
          action: 'audit_workflow',
          workflowId: workflow.id,
          workflowName: workflow.name,
          workflowVersionId: workflow.versionId,
          workflowHash: hash,
          success: true,
          summary: auditSummaryPayload(audit),
        });
        storage = { ...record, recorded: record.inserted };
      }
      json(res, 200, { ...audit, storage });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/lafhia/snapshot') {
      if (!requireAdmin(req, cfg)) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      const workflow = await fetchWorkflow(cfg);
      const audit = auditWorkflow(workflow);
      const snapshot = await saveWorkflowSnapshot(cfg, workflow, 'manual_snapshot', false);
      const cleanup = await cleanupRetention(cfg);
      await recordAuditEvent(cfg, {
        action: 'manual_snapshot',
        workflowId: workflow.id,
        workflowName: workflow.name,
        workflowVersionId: workflow.versionId,
        workflowHash: snapshot.hash,
        success: true,
        summary: {
          snapshotInserted: snapshot.inserted,
          snapshotId: snapshot.id,
          audit: auditSummaryPayload(audit),
        },
      });
      json(res, 200, { snapshot, cleanup, audit });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/lafhia/audit-history') {
      if (!requireAdmin(req, cfg)) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      const history = await getAuditHistory(cfg, url.searchParams.get('limit') || 20);
      json(res, 200, history);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/cleanup') {
      if (!requireAdmin(req, cfg)) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      const cleanup = await cleanupRetention(cfg);
      json(res, 200, cleanup);
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

      const allowedNodeChanges = summary.changedNodes.length === 0
        || summary.changedNodes.join(',') === 'Leer historial';
      if (!allowedNodeChanges) {
        throw new Error(`Unexpected changed nodes: ${summary.changedNodes.join(', ')}`);
      }
      const allowedConnectionChanges = summary.changedConnectionSources.length === 0
        || summary.changedConnectionSources.join(',') === 'IF bot silenciado';
      if (!allowedConnectionChanges) {
        throw new Error(`Unexpected changed connection sources: ${summary.changedConnectionSources.join(', ')}`);
      }

      const beforeSnapshot = await saveWorkflowSnapshot(cfg, before, 'before_apply_silence_patch', true);
      const noChangesNeeded = summary.changedNodes.length === 0 && summary.changedConnectionSources.length === 0;
      if (!noChangesNeeded) {
        await putWorkflow(cfg, after);
      }
      const saved = noChangesNeeded ? before : await fetchWorkflow(cfg);
      const savedAudit = auditSilence(saved);
      const afterSnapshot = await saveWorkflowSnapshot(cfg, saved, 'after_apply_silence_patch', true);
      const cleanup = await cleanupRetention(cfg);
      await recordAuditEvent(cfg, {
        action: 'apply_silence_patch',
        workflowId: saved.id,
        workflowName: saved.name,
        workflowVersionId: saved.versionId,
        workflowHash: afterSnapshot.hash,
        success: true,
        summary: {
          noChangesNeeded,
          changedNodes: summary.changedNodes,
          changedConnectionSources: summary.changedConnectionSources,
          beforeSnapshot,
          afterSnapshot,
          saved: savedAudit,
        },
      });
      json(res, 200, {
        noChangesNeeded,
        changedNodes: summary.changedNodes,
        changedConnectionSources: summary.changedConnectionSources,
        saved: savedAudit,
        storage: {
          beforeSnapshot,
          afterSnapshot,
          cleanup,
        },
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
