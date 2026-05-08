# LAFHIA Workflow Reference

## Current Shape

- Workflow: `Lafhia-Chatwoot`
- ID: `2UBCDcgO9bWmatbn`
- Host: `https://n8n-new-production-0154.up.railway.app`
- MCP endpoint: `https://n8n-new-production-0154.up.railway.app/mcp-server/http`
- Primary webhook: `POST /webhook/chatwoot-whatsapp`
- Core systems: Chatwoot, SAGI, OpenRouter, Groq transcription, Resend, html2pdf, Google Drive, WhatsApp.

The workflow has included 41 nodes after SAGI additions. Re-check live state before work.

## Important Nodes

- `Webhook`: receives Chatwoot events.
- `IF incoming`: allows only incoming `message_created`.
- `¿Audio?`, `Descargar audio`, `Transcribir audio`, `Inyectar transcripción`: audio path.
- `Leer historial`: dedupe, debounce, message recovery, validation state, bot silence state.
- `IF bot silenciado`: routes escalated/silenced conversations.
- `Respuesta escalado`: sends the handoff response when already escalated.
- `IF propietario_validado`: branches to SAGI validation or prompt.
- `¿Token SAGI válido?`, `Login SAGI`, `Guardar token SAGI`, `GET Clientes SAGI`, `Buscar nombre en SAGI`: owner lookup and validation.
- `Preparar prompt`: business rules and OpenRouter body.
- `OpenRouter`: model call.
- `Guardar historial`: stores AI response, parses `ORDER_COMPLETE`, `ESCALATE`, and `LABEL:<slug>`.
- `IF ORDER_COMPLETE`, `Actualizar atributos`, `Asignar etiquetas`, `Generar HTML orden`, `Enviar email orden`, `Convertir a PDF`, `Guardar PDF en Drive`: order path.
- `IF ESCALATE`, `Etiquetar ESCALATE`, `Reasignar a agente`: escalation path.
- `IF LABEL entrega_vivienda`, `Etiquetar entrega_vivienda`: delivery label path.
- `IF respuesta válida`, `Enviar respuesta`: customer reply path.

## Escalation Silence Rule

The desired behavior is:

- When AI emits `ESCALATE`, `Guardar historial` persists `bot_silenciado_<conversationId> = true`.
- Later inbound client messages in that conversation must not re-enter normal automation.
- If a human sends a WhatsApp template or Chatwoot webhook arrives without labels, do not clear `bot_silenciado`.
- `IF bot silenciado` true output must go to `Respuesta escalado`.
- `IF bot silenciado` false output must continue to `IF propietario_validado`.

Never reintroduce automatic clearing like:

```javascript
if (!labels.includes('escalado')) {
  sd[`bot_silenciado_${conversationId}`] = false;
}
```

If LAFHIA later wants to reactivate conversations, implement an explicit approved reset mechanism instead of relying on missing labels.

## Label Notes

Prompt mentions can include:

- `entrega-vivienda`
- `envio-planos`
- `fuera-de-garantia`
- `garantia-manual`
- `seguimiento`

Only assume a label is wired to Chatwoot after checking the live workflow. Historically, `entrega-vivienda` is detected in workflow JSON and applied to Chatwoot as `entrega_vivienda`.

## Business Rules To Preserve

- Delivery/writings: standard delivery process takes 25 days after escritura; if still within period, client should wait. This is not a posventa incident.
- Plan requests: ask for or validate email before sending; do not invent email or phone.
- Human handoff: annoyed client or request for a person should be transferred; do not keep solving automatically.
- Urgent reports: separate urgent technical reports from angry-client escalation wording.
- Visits: describe as inspection/evaluation, not guaranteed immediate repair.
- Do not provide phone numbers, emails, or contact data unless the workflow/source explicitly provides approved data.

## Safe API Update Pattern

Use public API for surgical patches.

1. `GET /api/v1/workflows/{workflowId}` with `X-N8N-API-KEY`.
2. Save before snapshot to temp.
3. Modify only the intended node/connection.
4. Build PUT body with accepted fields:

```json
{
  "name": "...",
  "nodes": [],
  "connections": {},
  "settings": {
    "executionOrder": "v1",
    "callerPolicy": "workflowsFromSameOwner",
    "availableInMCP": true
  },
  "staticData": {}
}
```

Do not include read-only `active`. If `settings` contains API-rejected properties, keep only accepted settings and verify after saving that n8n preserved the rest.

5. `PUT /api/v1/workflows/{workflowId}`.
6. Re-read and verify changed nodes and changed connection sources.

## Failure Modes

- `401 unauthorized` on `/api/v1`: wrong key, wrong host, or key from another n8n instance.
- MCP token works but API key fails: token types are different. MCP token is for `/mcp-server/http`; API key is for `/api/v1`.
- EasyPanel Humanio MCP is not the LAFHIA Railway instance. Confirm workflow ID and name before using any connector.
- MCP `update_workflow` can validate but may reconstruct too much. Prefer JSON API for small production patches.
- Chatwoot webhooks may omit labels or send stale labels. Do not use missing labels as proof a conversation should be reactivated.

