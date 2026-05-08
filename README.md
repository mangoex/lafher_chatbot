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
- `GET /lafhia/audit-workflow?record=true`: guarda resumen de auditoria. Requiere `Authorization: Bearer AGENT_ADMIN_TOKEN`.
- `POST /lafhia/snapshot`: guarda snapshot sanitizado si el workflow cambio. Requiere `Authorization: Bearer AGENT_ADMIN_TOKEN`.
- `GET /lafhia/audit-history`: muestra historial reciente. Requiere `Authorization: Bearer AGENT_ADMIN_TOKEN`.
- `POST /admin/cleanup`: ejecuta limpieza de retencion. Requiere `Authorization: Bearer AGENT_ADMIN_TOKEN`.
- `POST /lafhia/apply-silence-patch`: aplica el parche seguro de escalamiento. Requiere `Authorization: Bearer AGENT_ADMIN_TOKEN`.

## Retencion de datos

El agente no guarda snapshots completos en cada auditoria. Para cuidar espacio:

- Auditorias normales guardan solo resumen cuando se llama con `record=true`.
- Snapshots completos se guardan sanitizados y solo si cambia el hash del workflow.
- Snapshots asociados a parches se conservan por mas tiempo.
- La limpieza borra auditorias viejas y conserva solo los ultimos snapshots no criticos.

Variables opcionales:

```txt
DATABASE_URL=railway_postgres_url
AUDIT_RETENTION_DAYS=90
PATCH_RETENTION_DAYS=365
MAX_WORKFLOW_SNAPSHOTS=20
```

## Auditoria diaria con Railway Cron

Usar un segundo servicio Cron en Railway apuntando a este mismo repositorio.
Ese servicio debe ejecutar y terminar:

```txt
npm run daily:audit
```

Schedule diario sugerido, 8:00 AM Chihuahua / 14:00 UTC:

```txt
0 14 * * *
```

El Cron guarda solo resumen de auditoria en Postgres y ejecuta limpieza de retencion.
No modifica el workflow de n8n y no guarda snapshots completos.

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

## Uso como plugin Codex instalable

El repo incluye un plugin instalable:

```txt
plugins/lafher-chatbot
```

El plugin expone el agente como `@lafher_chatbot` en la interfaz y agrega una skill llamada `lafher-chatbot`.
Desde cualquier equipo con Codex, instalar el plugin desde este repo y configurar el token solo en el entorno local cuando se requieran acciones protegidas.

Invocaciones naturales:

```txt
@lafher_chatbot audita el flujo Lafhia
@lafher_chatbot revisa el historial
@lafher_chatbot guarda un snapshot seguro
@lafher_chatbot aplica el parche de silencio si hace falta
```

Comandos directos:

```powershell
node plugins/lafher-chatbot/skills/lafher-chatbot/scripts/lafher_agent_client.mjs audit

$env:LAFHER_AGENT_ADMIN_TOKEN = "<admin token>"
node plugins/lafher-chatbot/skills/lafher-chatbot/scripts/lafher_agent_client.mjs history
Remove-Item Env:LAFHER_AGENT_ADMIN_TOKEN
```

El plugin no guarda secretos. Usa la API global en Railway y solo requiere token local para historial, snapshots, limpieza o cambios autorizados.
