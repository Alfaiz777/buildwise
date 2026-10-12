# Qwikspot — Deployment Runbook (draft)

## Status

**L1 draft.** Every command below is **UNVERIFIED** until it has been run against the real project (`10_EXECUTION_PLAN.md`); each step is flipped to verified after it runs. What *is* verified locally is marked ✅: the container build inputs, the configuration contract (including the staged rollout), the GCS / BigQuery adapters against their port contracts, the scheduler endpoint, `seed:live` (rehearsed on the emulators), `demo:check` and Reset demo.

Audience: the person deploying Qwikspot to Google Cloud for the first time (L1) and re-deploying it afterwards. `infrastructure/scripts/setup-project.sh` does the one-time project setup (§1–§3); this runbook is the ordered checklist.

Conventions: project id `qwikspot` (written `PROJECT_ID` below), region `asia-south1` everywhere (it must match `firebase.json` and `infrastructure/scripts/deploy-backend.sh`). Run commands from the repository root.

**Staged rollout (until the Gemini and WhatsApp adapters ship).** Deploy with `GCP_STAGED_ROLLOUT=true`, `AGENT_RUNTIME=mock` and `MESSAGING_CHANNELS=simulator`. The gcp profile then allows exactly the mock agent and a simulator-only channel; it still refuses mock commerce, local files, local events and the emulators. `/api/health` shows `"staged": ["AGENT_RUNTIME=mock", "MESSAGING_CHANNELS=simulator"]`, the server logs one `server.staged_rollout` warning at start, and the console labels the agent "Mock AI". No `META_*`, `WHATSAPP_*` or `VERTEX_*` setting is needed in this mode. ✅ (`config.test.ts`)

**L2-WhatsApp under the staged rollout.** `MESSAGING_CHANNELS=simulator,whatsapp` is also allowed with `GCP_STAGED_ROLLOUT=true` and `AGENT_RUNTIME=mock`: brands that connect their own WhatsApp Business number (Settings → Channels: WhatsApp) are answered on WhatsApp by the mock agent; every other brand, the shopper demo (`/chat`) and `demo:check` stay on the simulator. `/api/health` then shows `"staged": ["AGENT_RUNTIME=mock"]`. ✅ (`config.test.ts`)

---

## 1. Project, budget and APIs — UNVERIFIED

1. Create the project, link billing (Blaze plan — Hosting rewrites to Cloud Run need it) and add Firebase to it (`npx firebase projects:addfirebase PROJECT_ID`, or the Firebase console).
2. **Budget alert first**, before anything can spend money:
   ```bash
   gcloud billing budgets create --billing-account BILLING_ACCOUNT_ID \
     --display-name "qwikspot-demo" --budget-amount 50USD \
     --threshold-rule percent=0.5 --threshold-rule percent=0.9 --threshold-rule percent=1.0
   ```
3. Run the one-time setup (idempotent; safe to re-run):
   ```bash
   PROJECT_ID=PROJECT_ID REGION=asia-south1 infrastructure/scripts/setup-project.sh
   ```
   It enables the APIs (Cloud Run, Cloud Build, Artifact Registry, Firestore, Identity Toolkit, Secret Manager, Vertex AI, BigQuery, Cloud Storage, Cloud Scheduler, IAM Credentials, Firebase), creates the Firestore database (Native, `asia-south1`), the Artifact Registry repository `qwikspot`, the service accounts `qwikspot-api` and `qwikspot-scheduler`, the upload bucket `qwikspot-PROJECT_ID-uploads` (uniform access, public access prevention, CORS for browser PUTs from the Hosting origins), the BigQuery dataset `qwikspot` with the `events` table (`infrastructure/bigquery/events.schema.json`, partitioned by day on `event_timestamp`), and the IAM below. It prints — but never runs — the secret commands (§3).
4. **Organisation policy.** The project sits under a Google Cloud organisation. New organisations enforce `iam.allowedPolicyMemberDomains` (domain restricted sharing), which blocks granting `allUsers` the Cloud Run invoker role, so `deploy-backend.sh --allow-unauthenticated` fails. `setup-project.sh` detects this and prints the project-only override (`gcloud org-policies set-policy` with `allowAll: true` on `projects/PROJECT_ID`; needs `roles/orgpolicy.policyAdmin` on the organisation). Qwikspot authenticates every route in the app, so Cloud Run IAM only has to let the Hosting rewrite and Shopify's webhooks through. `iam.disableServiceAccountKeyCreation` does not matter: no key files are used.

## 2. Service accounts (least privilege) — UNVERIFIED

Runtime identity `qwikspot-api@PROJECT_ID.iam.gserviceaccount.com`:

| Role | Scope | Why |
|---|---|---|
| `roles/datastore.user` | project | Firestore reads/writes (all tenant data) |
| `roles/firebaseauth.admin` | project | Provisioning users (Platform / Brand Admin flows create Auth users and setup links) |
| `roles/aiplatform.user` | project | Gemini on Vertex AI (`AdkGeminiAgentRuntime`, when it ships) |
| `roles/iam.serviceAccountTokenCreator` | **on itself only** | Signs the browser's upload URLs (IAM signBlob; no key file) |
| `roles/storage.objectAdmin` | **the upload bucket only** | Retail import uploads and row reports (`GCSFileStorageProvider`) |
| `roles/bigquery.dataEditor` | **the `qwikspot` dataset only** | Streaming inserts (`BigQueryEventSink`) |
| `roles/secretmanager.secretAccessor` | **each secret in §3 only** | Secrets as env vars |

Scheduler identity `qwikspot-scheduler@PROJECT_ID.iam.gserviceaccount.com`: no roles. Cloud Scheduler mints an OIDC token for it; the API checks the token's signature, audience (the endpoint URL) and email (§9).

Cloud Build (the Compute Engine default account on newer projects, the legacy Cloud Build account on older ones): `roles/artifactregistry.writer` on the `qwikspot` repository, `roles/logging.logWriter`, `roles/storage.objectViewer` (the uploaded build source). The person deploying gets `roles/iam.serviceAccountUser` on both service accounts.

No key files: Cloud Run uses the attached service account (ADC).

## 3. Secrets and configuration — UNVERIFIED (contract ✅)

The `gcp` profile checks every required setting at startup and stops with one message listing the **names** of the missing ones (`backend/src/config/env.ts`, `gcpRequiredSettings`; tested in `config.test.ts`). Required settings follow the selected adapters: `META_APP_ID`, `META_APP_SECRET`, `META_ES_CONFIG_ID` and `WHATSAPP_VERIFY_TOKEN` only when the `whatsapp` channel is selected (no global WhatsApp access token or number: each brand connects its own), `VERTEX_*` only with `AGENT_RUNTIME=adk_gemini`. ✅

**Secrets (Secret Manager → Cloud Run `--update-secrets`):**

| Secret | Used for |
|---|---|
| `SHOPIFY_API_KEY` | The Shopify app's client id (OAuth) |
| `SHOPIFY_API_SECRET` | The Shopify app's client secret: OAuth callback HMAC, token exchange, webhook HMAC |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM key (32 bytes, base64) for the stored Shopify tokens — keep it stable |
| `SHOPPER_SESSION_SECRET` | Signs shopper demo sessions (≥ 32 characters; required with `DEMO_MODE=true`) |
| `DEMO_LOGINS` | The judged demo's login panel (JSON printed by `seed:live`, with the real `DEMO_PASSWORD`) |
| `META_APP_SECRET` | The Meta app's secret (L2-WhatsApp): webhook `X-Hub-Signature-256` check and the Embedded Signup code exchange. Only with the `whatsapp` channel |
| `WHATSAPP_VERIFY_TOKEN` | A random string you choose; Meta sends it back once when the webhook is verified. Only with the `whatsapp` channel |

**Plain environment variables:**

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` (set by `deploy-backend.sh`) |
| `QWIKSPOT_PROFILE` | `gcp` (set by `deploy-backend.sh`) |
| `GOOGLE_CLOUD_PROJECT` | `PROJECT_ID` (set by `deploy-backend.sh`) |
| `GCP_REGION` | `asia-south1` |
| `GCP_STAGED_ROLLOUT` | `true` until Gemini and WhatsApp ship (then remove it) |
| `AGENT_RUNTIME` | `mock` during the staged rollout (later `adk_gemini`) |
| `MESSAGING_CHANNELS` | `simulator`, or `simulator,whatsapp` once the Meta app is set up (§7b) |
| `COMMERCE_PROVIDER` | `shopify` (the gcp default; set it explicitly) |
| `PUBLIC_BACKEND_URL` | The API's public https origin, e.g. `https://PROJECT_ID.web.app` (Hosting rewrites `/api/**`) — the Shopify callback and the Scheduler audience are built from it |
| `FRONTEND_URL` | `https://PROJECT_ID.web.app` (where Shopify OAuth lands) |
| `SCHEDULER_SERVICE_ACCOUNT` | `qwikspot-scheduler@PROJECT_ID.iam.gserviceaccount.com` |
| `GCS_BUCKET` | `qwikspot-PROJECT_ID-uploads` |
| `BIGQUERY_DATASET` | `qwikspot` |
| `CORS_ALLOWED_ORIGINS` | the Hosting origin(s), e.g. `https://PROJECT_ID.web.app` |
| `PUBLIC_WEB_ORIGIN` | `https://PROJECT_ID.web.app` (absolute product image URLs; defaults to the first CORS origin) |
| `DEMO_MODE` | `true` for the judged deployment only, otherwise `false` |
| `DEMO_BRAND_IDS` | `brd_demo` |
| `DEMO_HOLD_MINUTES` | `20` |
| `SHOPIFY_SCOPES`, `SHOPIFY_API_VERSION` | optional; default the four read scopes and `2026-10` |
| `VERTEX_MODEL`, `VERTEX_LOCATION` | later, with `AGENT_RUNTIME=adk_gemini` (§6) |
| `META_APP_ID` | The Meta app id (public; the Facebook SDK uses it) — with the `whatsapp` channel |
| `META_ES_CONFIG_ID` | The Facebook Login for Business configuration id for WhatsApp Embedded Signup (public) — with the `whatsapp` channel |
| `META_GRAPH_VERSION` | optional; default `v26.0` (format `vNN.0`) |
| `FIRESTORE_DATABASE` | `(default)` (optional) |
| `BUILD_VERSION`, `BUILD_COMMIT` | set by `deploy-backend.sh` |
| `LOG_LEVEL` | `info` (set by `deploy-backend.sh`) |

Create a secret (repeat per name; `setup-project.sh` prints all of them):
```bash
printf '%s' '<value>' | gcloud secrets create SHOPIFY_API_SECRET --data-file=- --replication-policy=automatic --project PROJECT_ID
gcloud secrets add-iam-policy-binding SHOPIFY_API_SECRET --project PROJECT_ID \
  --member serviceAccount:qwikspot-api@PROJECT_ID.iam.gserviceaccount.com --role roles/secretmanager.secretAccessor
```
Never put a secret in a file in the repository; `npm run secrets:scan` fails the build if one appears. ✅

## 4. Firestore: rules and indexes — UNVERIFIED (index list ✅)

```bash
npx firebase deploy --project PROJECT_ID --only firestore:rules,firestore:indexes
```
The rules deny all client access (the browser never talks to Firestore). Every multi-field query in the adapters is matched to `infrastructure/firebase/firestore.indexes.json` by `backend/test/indexCompleteness.test.ts`. ✅ Wait until the console shows every index as *Enabled* before seeding.

## 5. Build and deploy the API — UNVERIFIED (image inputs ✅)

```bash
PROJECT_ID=PROJECT_ID infrastructure/scripts/deploy-backend.sh
```
It builds with Cloud Build and deploys `qwikspot-api` with `--no-cpu-throttling` (background work after a response — the Shopify catalogue refresh after a webhook, queued BigQuery inserts — gets CPU), `--min-instances 1` (no cold start in the chat path), `--max-instances 3` (bounds cost under abuse, `07_SECURITY_SPEC.md` §17), 1 vCPU, 512 MiB, `--allow-unauthenticated` (in-app auth; §1 step 4), and `--update-env-vars` for `NODE_ENV`, `QWIKSPOT_PROFILE=gcp`, `GOOGLE_CLOUD_PROJECT`, `LOG_LEVEL`, `BUILD_*` — `--update-*` keeps the configuration attached below across redeploys.

The first deploy cannot start the gcp profile yet (no configuration attached). Attach it once:
```bash
gcloud run services update qwikspot-api --project PROJECT_ID --region asia-south1 \
  --update-env-vars "GCP_REGION=asia-south1,GCP_STAGED_ROLLOUT=true,AGENT_RUNTIME=mock,MESSAGING_CHANNELS=simulator,COMMERCE_PROVIDER=shopify,PUBLIC_BACKEND_URL=https://PROJECT_ID.web.app,FRONTEND_URL=https://PROJECT_ID.web.app,SCHEDULER_SERVICE_ACCOUNT=qwikspot-scheduler@PROJECT_ID.iam.gserviceaccount.com,GCS_BUCKET=qwikspot-PROJECT_ID-uploads,BIGQUERY_DATASET=qwikspot,CORS_ALLOWED_ORIGINS=https://PROJECT_ID.web.app,PUBLIC_WEB_ORIGIN=https://PROJECT_ID.web.app,DEMO_MODE=true,DEMO_BRAND_IDS=brd_demo,DEMO_HOLD_MINUTES=20" \
  --update-secrets "SHOPIFY_API_KEY=SHOPIFY_API_KEY:latest,SHOPIFY_API_SECRET=SHOPIFY_API_SECRET:latest,TOKEN_ENCRYPTION_KEY=TOKEN_ENCRYPTION_KEY:latest,SHOPPER_SESSION_SECRET=SHOPPER_SESSION_SECRET:latest"
```
Add `DEMO_LOGINS=DEMO_LOGINS:latest` to `--update-secrets` once §8 has printed it.

The image (`backend/Dockerfile`) contains `backend/dist` and `backend/fixtures` (the judge stock fixture Reset demo reads). ✅ To try the image locally against the emulators (needs Docker Desktop running):
```bash
docker build -f backend/Dockerfile -t qwikspot-api .
docker run --rm -p 8080:8080 -e QWIKSPOT_PROFILE=local -e GOOGLE_CLOUD_PROJECT=demo-qwikspot \
  -e FIRESTORE_EMULATOR_HOST=host.docker.internal:8085 -e FIREBASE_AUTH_EMULATOR_HOST=host.docker.internal:9099 \
  -e DEMO_MODE=true -e LOCAL_DATA_DIR=/tmp/qwikspot-data qwikspot-api
curl http://localhost:8080/api/health   # {"status":"ok","version":"…","commit":…,"profile":"local",…}
```
The image runs as the unprivileged `node` user, so in the local profile `LOCAL_DATA_DIR` must point at a writable path (`/tmp/…`); in `gcp` files go to Cloud Storage.

The gcp profile never falls back to a mock or local adapter. The adapter that does not exist yet (`AdkGeminiAgentRuntime`) is only reachable without `GCP_STAGED_ROLLOUT`, where they fail at start with `AdapterNotAvailableError` — by design.

## 6. Vertex AI model access — UNVERIFIED (after the staged rollout)

1. Vertex AI → Model Garden: confirm the chosen Gemini model is available in `VERTEX_LOCATION` for this project.
2. Smoke-call it with the service account (the exact command lands next to `AdkGeminiAgentRuntime`).
3. Run the AI scenario suite against the real runtime: `runAgentScenarioSuite({ runtime: 'ADK_GEMINI', runs: 5, … })` — scenarios 8–12 must pass 5/5, 1–7 at least 4/5 (`08_TEST_PLAN.md` §7.3).
4. Then set `AGENT_RUNTIME=adk_gemini`, `VERTEX_MODEL`, `VERTEX_LOCATION` and drop `GCP_STAGED_ROLLOUT`.

## 7. Web app on Firebase Hosting — UNVERIFIED

1. `frontend/.env.production.local` (git-ignored): the public Firebase web config and `VITE_QWIKSPOT_PROFILE=gcp`. These are public identifiers, not secrets.
2. Deploy:
   ```bash
   PROJECT_ID=PROJECT_ID infrastructure/scripts/deploy-frontend.sh
   ```
   `firebase.json` rewrites `/api/**` to the `qwikspot-api` service in `asia-south1` (checked by `indexCompleteness.test.ts`). ✅
3. `npm run secrets:scan` after `npm run build` also scans `frontend/dist` for keys and the demo password. ✅

## 7a. Shopify app — UNVERIFIED

1. Dev Dashboard → the Qwikspot app → configuration: change the redirect URL to `https://PROJECT_ID.web.app/api/integrations/shopify/callback` (the `PUBLIC_BACKEND_URL` host), then release the version.
2. Brand Console (the demo brand's Brand Admin) → **Settings → Shopify** → reconnect the store (`m6ccxz-wk.myshopify.com`) → approve. The webhooks are registered against the deployed URL.
3. **Sync products**, then **Reset demo** so the stock maps to the live catalogue.

## 7b. Meta app and WhatsApp — UNVERIFIED (contract ✅)

One Meta app (Qwikspot, Tech Provider) serves every brand; each brand connects its **own** WhatsApp Business number with Embedded Signup in Settings → Channels: WhatsApp. The simulator stays for every brand that has not connected one.

1. Secrets: `META_APP_SECRET` (App settings → Basic → App secret) and `WHATSAPP_VERIFY_TOKEN` (any random string, e.g. `openssl rand -hex 24`) into Secret Manager, readable by `qwikspot-api` (§3).
2. Cloud Run: `MESSAGING_CHANNELS=simulator,whatsapp`, `META_APP_ID`, `META_ES_CONFIG_ID`, `META_GRAPH_VERSION=v26.0` and the two secrets (`gcloud run services update … --update-env-vars … --update-secrets …`).
3. Meta app dashboard:
   - **WhatsApp → Configuration → Webhook:** callback URL `https://PROJECT_ID.web.app/api/webhooks/whatsapp` (Hosting forwards `/api/**` with the body unchanged), verify token = `WHATSAPP_VERIFY_TOKEN`; subscribe to `messages`, `account_update` and `phone_number_quality_update`.
   - **Facebook Login for Business → Configurations:** a WhatsApp Embedded Signup configuration (its id is `META_ES_CONFIG_ID`) with `whatsapp_business_management` and `whatsapp_business_messaging`.
   - **Facebook Login for Business → Settings:** Login with the JavaScript SDK on; Allowed domains for the JavaScript SDK and Valid OAuth redirect URIs = `https://PROJECT_ID.web.app` (and any custom domain).
   - **App settings → Basic:** App domains `PROJECT_ID.web.app`; Privacy policy `https://qwikspot.urbanlyfe.in/privacy-policy/`, Terms `https://qwikspot.urbanlyfe.in/terms/`, User data deletion `https://qwikspot.urbanlyfe.in/data-deletion/`.
4. Brand Console → Settings → **Connect WhatsApp** → finish Meta's signup → the card shows the masked number and its name. Message that number: the reply comes from it, and the conversation appears in Conversations as channel WhatsApp.

## 8. Seed the judged demo — rehearsed on the emulators ✅

```bash
QWIKSPOT_PROFILE=gcp GOOGLE_CLOUD_PROJECT=PROJECT_ID DEMO_MODE=true DEMO_PASSWORD='<at least 12 chars>' \
  npm run seed:live --workspace backend -- --project PROJECT_ID
# type PROJECT_ID when asked
```
It runs with your own ADC (`gcloud auth application-default login`) and the same gcp configuration as the service (export the §3 settings in the shell first — the staged rollout included). It refuses without `--project`, a matching typed confirmation, `DEMO_MODE=true`, a strong `DEMO_PASSWORD` that is not the repository's local password, or a brand outside `DEMO_BRAND_IDS` (`backend/test/seedLive.test.ts`). It creates the Platform Admin, `brd_demo` with its retailers, runs the same rebuild as Reset demo, provisions the Brand Admin and the Bandra / Andheri Retail Admins through the product's services, and prints the `DEMO_LOGINS` JSON — put it in Secret Manager with the real password.

Rehearsal (local): run the emulators, then `GOOGLE_CLOUD_PROJECT=demo-qwikspot DEMO_MODE=true DEMO_PASSWORD=… npm run seed:live --workspace backend -- --project demo-qwikspot`.

## 9. Scheduled due work — UNVERIFIED (endpoint ✅)

`POST /api/internal/process-due` runs, for every ACTIVE brand, the same work as the Brand Console's "Process due work now": abandoned sessions, due follow-ups, the hold-expiry sweep and the NONE-outcome sweep, audited `DUE_WORK_PROCESSED` with the SYSTEM actor `cloud-scheduler`. It accepts only a Google-signed OIDC token whose audience is exactly `<PUBLIC_BACKEND_URL>/api/internal/process-due` and whose email is `SCHEDULER_SERVICE_ACCOUNT`; anything else is `401`. Rate-limited. ✅ (`scheduledWork.test.ts`)

```bash
gcloud scheduler jobs create http qwikspot-process-due --project PROJECT_ID --location asia-south1 \
  --schedule "*/5 * * * *" --http-method POST \
  --uri "https://PROJECT_ID.web.app/api/internal/process-due" \
  --oidc-service-account-email qwikspot-scheduler@PROJECT_ID.iam.gserviceaccount.com \
  --oidc-token-audience "https://PROJECT_ID.web.app/api/internal/process-due"
```
The URI and the audience must both equal `PUBLIC_BACKEND_URL` + `/api/internal/process-due`. Test it once with `gcloud scheduler jobs run qwikspot-process-due --location asia-south1 --project PROJECT_ID`, then check the Cloud Run log for a `200`.

## 10. Verify — `demo:check` ✅

```bash
BASE_URL=https://PROJECT_ID.web.app STOREFRONT_ORIGIN=https://PROJECT_ID.web.app \
FIREBASE_API_KEY=<public web api key> DEMO_PASSWORD='<the demo password>' npm run demo:check
```
It walks health → the four sign-ins → platform → brand → retailer stock → a customer conversation → AI decision → reservation → store fulfilment with the pickup code → the OFFLINE outcome in insights, printing ✔ / ✘ per step and exiting non-zero on failure. It never resets the demo and uses a fresh `judge_check_xxxx` customer. Also check `GET /api/health` shows the deployed `commit` and, during the staged rollout, the `staged` list.

Note: the storefront step needs `STOREFRONT_ORIGIN` in the demo brand's `allowed_storefront_origins` (Reset keeps whatever the brand has; `seed:live` defaults to the local demo store, so set the Hosting origin on the brand once).

## 11. Rollback — UNVERIFIED

```bash
gcloud run revisions list --service qwikspot-api --region asia-south1 --project PROJECT_ID
gcloud run services update-traffic qwikspot-api --region asia-south1 --project PROJECT_ID \
  --to-revisions PREVIOUS_REVISION=100
npx firebase hosting:rollback --project PROJECT_ID      # web app
```
Data: Firestore is not rolled back with code. For the demo brand, **Reset demo** (Brand Console) or `seed:live` restores the seeded state; no other brand is ever touched.

## 12. If something is wrong

| Symptom | Likely cause |
|---|---|
| Service exits at start: "The gcp profile is missing required settings: …" | A variable or secret from §3 is not attached |
| Service exits: "The gcp profile refuses local/mock infrastructure" | A selector (`COMMERCE_PROVIDER`, …) or an emulator host is set — or `AGENT_RUNTIME=mock` without `GCP_STAGED_ROLLOUT=true` |
| Service exits: `AdapterNotAvailableError` | `AGENT_RUNTIME=adk_gemini` before that adapter exists — use the staged rollout |
| Service exits: "MESSAGING_CHANNELS=whatsapp needs valid settings: …" | A `META_*` variable or `WHATSAPP_VERIFY_TOKEN` is missing, or `META_GRAPH_VERSION` is not `vNN.0` |
| Meta: "The callback URL or verify token couldn't be validated" | `WHATSAPP_VERIFY_TOKEN` differs from the dashboard, or the service is not running with the `whatsapp` channel yet |
| WhatsApp messages arrive but nobody answers | Webhook `401` (wrong `META_APP_SECRET`), or `whatsapp.webhook_unknown_number` in the log: that number is not connected to any brand |
| `deploy-backend.sh` fails on `--allow-unauthenticated` | The org policy `iam.allowedPolicyMemberDomains` (§1 step 4) |
| `503 SERVICE_UNAVAILABLE` from every route | Firestore not reachable / service account lacks `datastore.user` |
| Retail upload fails in the browser (CORS) | The bucket's CORS does not list the Hosting origin — re-run `setup-project.sh` |
| Retail upload `403 SignatureDoesNotMatch` | The browser did not send the target's headers, or the service account lacks `serviceAccountTokenCreator` on itself |
| No rows in BigQuery | The service account lacks `bigquery.dataEditor` on the dataset — look for `events.bigquery_insert_failed` (event ids + code) in the log |
| Scheduler job `401` | URI and `--oidc-token-audience` differ from `PUBLIC_BACKEND_URL/api/internal/process-due`, or the job's service account is not `SCHEDULER_SERVICE_ACCOUNT` |
| Login panel missing on the judged site | `DEMO_MODE` is not `true` or `DEMO_LOGINS` is not attached |
| `demo:check` ✘ "no store offered" | Stock exhausted by earlier sessions — press Reset demo |
| Reset demo → 403 | The brand is not in `DEMO_BRAND_IDS` |
| Reset demo → 500, demo brand has no stock | The rebuild failed after the wipe (e.g. storage not writable); fix the cause and press Reset again — it is idempotent |
