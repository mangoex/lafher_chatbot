# LAFHER Chatbot Agent

Repositorio del agente global para operar, auditar y mejorar de forma segura el flujo `Lafhia-Chatwoot` en n8n.

## Contenido

- `skills/lafhia-n8n-agent/`: skill local de Codex para auditoria, diagnostico y cambios seguros del flujo.
- `server/`: servidor HTTP minimo para Railway/EasyPanel.
- `.env.example`: variables necesarias sin secretos reales.

## Principio de seguridad

No guardar tokens, API keys, passwords ni credenciales reales en GitHub. Las claves deben ir en variables secretas del hosting.

## Variables

Copiar `.env.example` en Railway como variables de entorno:

- `AGENT_ADMIN_TOKEN`: token privado para acciones de escritura.
- `N8N_API_KEY`: API key de n8n para `/api/v1`.
- `LAFHIA_N8N_BASE_URL`: URL base de n8n.
- `LAFHIA_WORKFLOW_ID`: ID del workflow.

## Endpoints

- `GET /health`: estado del servidor.
- `GET /agent`: informacion del agente.
- `GET /lafhia/audit-silence`: auditoria de la regla de bot silenciado.
- `GET /lafhia/audit-workflow`: auditoria completa de solo lectura del workflow.
- `POST /lafhia/apply-silence-patch`: aplica el parche seguro de escalamiento. Requiere `Authorization: Bearer AGENT_ADMIN_TOKEN`.

## Uso local

```powershell
$env:N8N_API_KEY = "<api key>"
npm run check
npm start
```

## Uso como skill Codex

La skill puede instalarse copiando:

```txt
skills/lafhia-n8n-agent
```

a:

```txt
C:\Users\<usuario>\.codex\skills\lafhia-n8n-agent
```

Luego invocar:

```txt
Usa la skill lafhia-n8n-agent para auditar el flujo Lafhia-Chatwoot.
```
