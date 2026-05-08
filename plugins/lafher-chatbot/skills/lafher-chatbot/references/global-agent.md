# Global Agent Reference

## Installable Shape

This repo exposes two layers:

- Railway API: the always-on global backend.
- Codex plugin: the installable package that teaches Codex how to call the backend safely.

The plugin does not store secrets. Each machine should provide `LAFHER_AGENT_ADMIN_TOKEN` locally only when protected actions are needed.

## Public API

- `GET /health`
- `GET /agent`
- `GET /lafhia/audit-workflow`
- `GET /lafhia/audit-silence`

## Protected API

Requires `Authorization: Bearer <AGENT_ADMIN_TOKEN>`.

- `GET /lafhia/audit-history`
- `POST /lafhia/snapshot`
- `POST /lafhia/apply-silence-patch`
- `POST /admin/cleanup`

## Safe Use

- Audits are read-only.
- Snapshots write only to Postgres.
- `apply-silence-patch` is idempotent and scoped to the silence/escalation patch.
- Workflow edits must be explicitly authorized by the user.
