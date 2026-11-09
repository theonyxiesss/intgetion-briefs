# intgetion-briefs

Morning briefs of the INTGETION platform as a standalone service: the
candidate digest (best new matches with a friendly intro), the employer brief
(anonymous candidate cards for a job), the slot schedule and the admin panel
behind them. Not connected to the platform yet; it is integrated later
through a separate branch and PR.

- Package `@intgetion/briefs`, HTTP service on port `4110`.
- Depends on `@intgetion/kit` v0.3.1 and `@intgetion/notifications` v0.1.1 (by git tag).
- Owns tables `brief_slots`, `brief_settings`, `brief_runs`, `brief_deliveries`
  (migration `0032_briefs.sql`, tracker `briefs_schema_migrations`).

## HTTP

Every route except `/health` needs `authorization: Bearer $BRIEFS_SERVICE_TOKEN`.
Admin routes trust the platform: it checks the admin role, writes the audit
record and names the admin in `x-user-id`.

| Method | Path | Does |
| --- | --- | --- |
| POST | `/v1/tasks/run-briefs` | cron tick: runs every slot whose local time has come |
| GET | `/v1/admin` | slots, pause flag, recent runs |
| PUT | `/v1/admin/settings` | `{paused}` |
| PATCH | `/v1/admin/slots/:id` | `{timezone, localTime, enabled}` |
| POST | `/v1/admin/slots/:id/run` | `{dryRun}` run a slot now |
| GET | `/v1/jobs/:jobId/candidate-cards?locale=` | anonymous cards for the employer |

Errors: `{error: {code, message, details}}`.

## Ports

`src/ports.ts`. In-process adapters (`src/test-support.ts`) are how the
platform will wire it; `src/server/remote-ports.ts` is the HTTP wiring:

- `deliver`: notifications `POST /v1/deliver`. In-process it writes with the
  brief's transaction, so the delivery claim and the notice commit together.
  Over HTTP a refused delivery rolls the claim back and the next tick retries.
- `matchScreen`, `computeMatchesForJob`: matching service.
- `postSystemEvent`: assistant chat note, platform `/api/internal/briefs/chat-note` until bot moves out.
- `llm`: intro text, platform `/api/internal/briefs/llm`; null or an error gives the template intro.

Known exception: the candidate brief still sets
`candidate_profiles.last_digest_at` inside its transaction (a candidates
table). It moves behind a candidates port when the platform integrates.

## Run

```bash
cp .env.example .env
npm ci
npm run migrate
npm start
```

## Tests

Unit tests run without a database. Integration tests run when `DATABASE_URL`
is set, on a fresh database prepared as in CI: `test/sql/pre/*.sql`, then
`npm run migrate`, then `test/sql/post/*.sql`. They leave brief runs behind,
so use a fresh database for each full run.
