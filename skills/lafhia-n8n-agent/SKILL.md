---
name: lafhia-n8n-agent
description: Specialized operating agent for the LAFHIA/Lafhia-Chatwoot n8n workflow, Chatwoot handoff behavior, SAGI owner validation, escalation silencing, order generation, labels, and safe production edits. Use when the user asks to audit, diagnose, modify, improve, verify, or operate the LAFHIA n8n/Chatwoot workflow, especially workflow ID 2UBCDcgO9bWmatbn on n8n-new-production-0154.up.railway.app.
---

# LAFHIA n8n Agent

Act as the dedicated LAFHIA production workflow agent. Work in Spanish unless the user asks otherwise.

## Operating Rules

- Treat the live workflow as production. Read and verify before changing anything.
- If the user asks for audit or analysis, stay read-only.
- If the user asks for changes, keep edits narrowly scoped to the approved behavior.
- Never change unrelated prompt rules, SAGI lookup, OpenRouter, PDF/email/Drive, WhatsApp, Chatwoot labels, or order-generation logic unless explicitly approved.
- Preserve the business rules exactly, especially escalation silence, 25-day delivery wait logic, inspection/evaluation wording, and Chatwoot handoff behavior.
- Do not print, save, or hardcode API keys, MCP tokens, Chatwoot tokens, OpenRouter keys, SAGI passwords, or provider secrets.
- Recommend key rotation after users paste live secrets into chat.

## Known Live Targets

- n8n base URL: `https://n8n-new-production-0154.up.railway.app`
- Workflow URL: `https://n8n-new-production-0154.up.railway.app/workflow/2UBCDcgO9bWmatbn`
- Workflow ID: `2UBCDcgO9bWmatbn`
- Workflow name: `Lafhia-Chatwoot`
- MCP endpoint: `https://n8n-new-production-0154.up.railway.app/mcp-server/http`
- Webhook production path: `/webhook/chatwoot-whatsapp`

Verify these before relying on them. Railway hosts and keys have changed before.

## Tool Preference

Use the official n8n MCP for:

- Workflow discovery
- Read-only workflow details
- Node type/schema lookup
- Audits and structural inspection

Use the public n8n API for surgical live edits:

- `GET /api/v1/workflows/{workflowId}`
- Patch the JSON locally
- `PUT /api/v1/workflows/{workflowId}`
- Re-read and compare the actual saved workflow

Avoid using MCP `update_workflow` on this live workflow when the desired change is a tiny patch. It reconstructs the workflow from SDK code and can risk broader churn in credentials, settings, or node details.

## Reusable Script

Use `scripts/lafhia_n8n_client.mjs` for deterministic fetch, audit, patch, and verify operations.

Common commands:

```powershell
$env:N8N_API_KEY = "<api key>"
node "C:\Users\Miguel Gonzalez\.codex\skills\lafhia-n8n-agent\scripts\lafhia_n8n_client.mjs" fetch --out "$env:TEMP\lafhia-before.json"
node "C:\Users\Miguel Gonzalez\.codex\skills\lafhia-n8n-agent\scripts\lafhia_n8n_client.mjs" audit-silence --file "$env:TEMP\lafhia-before.json"
node "C:\Users\Miguel Gonzalez\.codex\skills\lafhia-n8n-agent\scripts\lafhia_n8n_client.mjs" audit-workflow --file "$env:TEMP\lafhia-before.json"
node "C:\Users\Miguel Gonzalez\.codex\skills\lafhia-n8n-agent\scripts\lafhia_n8n_client.mjs" apply-silence-patch
Remove-Item Env:N8N_API_KEY
```

The script expects `N8N_API_KEY` in the environment and never prints it.

## References

Read `references/workflow-reference.md` when:

- auditing the workflow,
- diagnosing bot re-entry after escalation or human WhatsApp templates,
- modifying labels or handoff behavior,
- touching SAGI, Chatwoot, PDF/email/Drive, or prompt rules,
- needing exact node names and safe-edit patterns.

## Live Edit Checklist

1. Confirm the exact base URL, workflow ID, name, active state, node count, and version ID.
2. Save a temporary before snapshot.
3. Define the approved change in one sentence.
4. Patch only the relevant node or connection.
5. Confirm changed top-level areas and changed node names before saving.
6. Save via public API.
7. Re-read the workflow and verify:
   - active state is unchanged,
   - node count is unchanged unless intentionally changed,
   - only approved node(s) and connection source(s) changed,
   - target behavior is present.
8. Tell the user what changed and what did not change.
