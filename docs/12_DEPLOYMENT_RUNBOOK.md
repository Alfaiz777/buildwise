# Qwikspot — Deployment Runbook (draft)

## Status

**M7 draft.** Every command below is **UNVERIFIED** until phase L1 runs it against a real project (`10_EXECUTION_PLAN.md`). What *is* verified locally is marked ✅: the container build inputs, the configuration contract, `seed:live` (rehearsed on the emulators), `demo:check` and Reset demo.

Audience: the person deploying Qwikspot to Google Cloud for the first time (L1) and re-deploying it afterwards. Read `infrastructure/README.md` first for the one-time project setup; this runbook is the ordered checklist with everything M7 added.

Conventions: `PROJECT_ID` is the Google Cloud project, region `asia-south1` everywhere (it must match `firebase.json` and `infrastructure/scripts/deploy-backend.sh`). Run commands from the repository root.

---

## 1. Project, budget and APIs — UNVERIFIED

1. Create the project, link billing (Blaze plan — Hosting rewrites to Cloud Run need it) and add Firebase to it.
2. **Budget alert first**, before anything can spend money:
   ```bash
   gcloud billing budgets create --billing-account BILLING_ACCOUNT_ID \
     --display-name "qwikspot-demo" --budget-amount 50USD \
     --threshold-rule percent=0.5 --threshold-rule percent=0.9 --threshold-rule percent=1.0
   ```
3. Enable the APIs:
   ```bash
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
     firestore.googleapis.com identitytoolkit.googleapis.com secretmanager.googleapis.com \
     aiplatform.googleapis.com bigquery.googleapis.com storage.googleapis.com \
     cloudscheduler.googleapis.com --project PROJECT_ID
   ```
4. Artifact Registry repository `qwikspot` (docker, `asia-south1`) — `infrastructure/README.md` step 7.

## 2. Service account (least privilege) — UNVERIFIED

One runtime identity, `qwikspot-api@PROJECT_ID.iam.gserviceaccount.com`, with only:

| Role | Why |
|---|---|
| `roles/datastore.user` | Firestore reads/writes (all tenant data) |
| `roles/firebaseauth.admin` | Provisioning users (Platform / Brand Admin flows create Auth users and setup links) |
| `roles/aiplatform.user` | Gemini on Vertex AI (`AdkGeminiAgentRuntime`, L1) |
| `roles/storage.objectAdmin` on the `GCS_BUCKET` bucket only | Retail import uploads and row reports |
| `roles/bigquery.dataEditor` on `BIGQUERY_DATASET` only | `BigQueryEventSink` |
| `roles/secretmanager.secretAccessor` on each secret below only | Secrets as env vars |

No key files: Cloud Run uses the attached service account (ADC).

## 3. Secrets and configuration — UNVERIFIED (contract ✅)

The `gcp` profile checks every required setting at startup and stops with one message listing the **names** of the missing ones (`backend/src/config/env.ts`, `GCP_REQUIRED_SETTINGS`; tested in `config.test.ts`). ✅

**Secrets (Secret Manager → Cloud Run `--set-secrets`):**

| Secret | Used for |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Cloud API sends (L2) |
| `WHATSAPP_APP_SECRET` | Webhook signature verification (L2) |
| `WHATSAPP_VERIFY_TOKEN` | Webhook subscription handshake (L2) |
| `SHOPIFY_ADMIN_TOKEN` | Admin API (L2) |
| `SHOPIFY_WEBHOOK_SECRET` | Webhook HMAC (L2) |
| `DEMO_LOGINS` | The judged demo's login panel (JSON with the real `DEMO_PASSWORD`) |

**Plain environment variables:**

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `QWIKSPOT_PROFILE` | `gcp` |
| `GOOGLE_CLOUD_PROJECT` | `PROJECT_ID` |
| `GCP_REGION` | `asia-south1` |
| `FIRESTORE_DATABASE` | `(default)` (optional) |
| `VERTEX_MODEL`, `VERTEX_LOCATION` | the Gemini model id and its region (step 6) |
| `WHATSAPP_PHONE_NUMBER_ID` | the WhatsApp sender's id |
| `SHOPIFY_SHOP_DOMAIN` | `your-dev-store.myshopify.com` |
| `BIGQUERY_DATASET`, `GCS_BUCKET` | analytics dataset, upload bucket |
| `CORS_ALLOWED_ORIGINS` | the Hosting origin(s), e.g. `https://PROJECT_ID.web.app` |
| `DEMO_MODE` | `true` for the judged deployment only, otherwise `false` |
| `DEMO_BRAND_IDS` | `brd_demo` |
| `DEMO_HOLD_MINUTES` | `20` |
| `BUILD_VERSION`, `BUILD_COMMIT` | set by `deploy-backend.sh` |
| `LOG_LEVEL` | `info` |

Create a secret (repeat per name):
```bash
printf '%s' "$VALUE" | gcloud secrets create WHATSAPP_ACCESS_TOKEN --data-file=- --project PROJECT_ID
gcloud secrets add-iam-policy-binding WHATSAPP_ACCESS_TOKEN --project PROJECT_ID \
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
Then attach the configuration (once; later deploys keep it):
```bash
gcloud run services update qwikspot-api --project PROJECT_ID --region asia-south1 \
  --update-env-vars "QWIKSPOT_PROFILE=gcp,GCP_REGION=asia-south1,VERTEX_MODEL=...,VERTEX_LOCATION=...,WHATSAPP_PHONE_NUMBER_ID=...,SHOPIFY_SHOP_DOMAIN=...,BIGQUERY_DATASET=...,GCS_BUCKET=...,CORS_ALLOWED_ORIGINS=https://PROJECT_ID.web.app,DEMO_MODE=true,DEMO_BRAND_IDS=brd_demo,DEMO_HOLD_MINUTES=20" \
  --update-secrets "WHATSAPP_ACCESS_TOKEN=WHATSAPP_ACCESS_TOKEN:latest,WHATSAPP_APP_SECRET=WHATSAPP_APP_SECRET:latest,WHATSAPP_VERIFY_TOKEN=WHATSAPP_VERIFY_TOKEN:latest,SHOPIFY_ADMIN_TOKEN=SHOPIFY_ADMIN_TOKEN:latest,SHOPIFY_WEBHOOK_SECRET=SHOPIFY_WEBHOOK_SECRET:latest,DEMO_LOGINS=DEMO_LOGINS:latest"
```
Sizing: 1 vCPU, 512 MiB, min 0 / max 5 instances (`deploy-backend.sh`) — the max bounds cost under abuse (`07_SECURITY_SPEC.md` §17).

The image (`backend/Dockerfile`) contains `backend/dist` and `backend/fixtures` (the judge stock fixture Reset demo reads). ✅ To try the image locally against the emulators (needs Docker Desktop running):
```bash
docker build -f backend/Dockerfile -t qwikspot-api .
docker run --rm -p 8080:8080 -e QWIKSPOT_PROFILE=local -e GOOGLE_CLOUD_PROJECT=demo-qwikspot \
  -e FIRESTORE_EMULATOR_HOST=host.docker.internal:8085 -e FIREBASE_AUTH_EMULATOR_HOST=host.docker.internal:9099 \
  -e DEMO_MODE=true -e LOCAL_DATA_DIR=/tmp/qwikspot-data qwikspot-api
curl http://localhost:8080/api/health   # {"status":"ok","version":"…","commit":…,"profile":"local"}
```
The image runs as the unprivileged `node` user, so in the local profile `LOCAL_DATA_DIR` must point at a writable path (`/tmp/…`); in `gcp` files go to Cloud Storage. Verified in M7: the image built, served `/api/health`, ran Reset demo and passed `demo:check` against the emulators. ✅

**Until the real adapters exist (L1/L2)** the `gcp` profile refuses to start (`AdapterNotAvailableError`) — by design, it never falls back to a mock.

## 6. Vertex AI model access — UNVERIFIED

1. Vertex AI → Model Garden: confirm the chosen Gemini model is available in `VERTEX_LOCATION` for this project.
2. Smoke-call it with the service account (L1 adds the exact command next to `AdkGeminiAgentRuntime`).
3. Run the AI scenario suite against the real runtime: `runAgentScenarioSuite({ runtime: 'ADK_GEMINI', runs: 5, … })` — scenarios 8–12 must pass 5/5, 1–7 at least 4/5 (`08_TEST_PLAN.md` §7.3).

## 7. Web app on Firebase Hosting — UNVERIFIED

1. `frontend/.env.production.local` (git-ignored): the public Firebase web config and `VITE_QWIKSPOT_PROFILE=gcp`. These are public identifiers, not secrets.
2. Deploy:
   ```bash
   PROJECT_ID=PROJECT_ID infrastructure/scripts/deploy-frontend.sh
   ```
   `firebase.json` rewrites `/api/**` to the `qwikspot-api` service in `asia-south1` (checked by `indexCompleteness.test.ts`). ✅
3. `npm run secrets:scan` after `npm run build` also scans `frontend/dist` for keys and the demo password. ✅

## 8. Seed the judged demo — rehearsed on the emulators ✅

```bash
QWIKSPOT_PROFILE=gcp GOOGLE_CLOUD_PROJECT=PROJECT_ID DEMO_MODE=true DEMO_PASSWORD='<at least 12 chars>' \
  npm run seed:live --workspace backend -- --project PROJECT_ID
# type PROJECT_ID when asked
```
It refuses without `--project`, a matching typed confirmation, `DEMO_MODE=true`, a strong `DEMO_PASSWORD` that is not the repository's local password, or a brand outside `DEMO_BRAND_IDS` (`backend/test/seedLive.test.ts`). It creates the Platform Admin, `brd_demo` with its retailers, runs the same rebuild as Reset demo, provisions the Brand Admin and the Bandra / Andheri Retail Admins through the product's services, and prints the `DEMO_LOGINS` JSON — put it in Secret Manager with the real password.

Rehearsal (local): run the emulators, then `GOOGLE_CLOUD_PROJECT=demo-qwikspot DEMO_MODE=true DEMO_PASSWORD=… npm run seed:live --workspace backend -- --project demo-qwikspot`.

## 9. Scheduled due work — UNVERIFIED, endpoint pending (L1)

Follow-ups, hold expiry and NONE outcomes run in `POST /api/brand/follow-ups/process-due`, which today needs a Brand Admin token (the console's "Run due follow-ups" button). L1 adds an internal route that accepts a **Cloud Scheduler OIDC token** for the service account and loops over the active brands; then:
```bash
gcloud scheduler jobs create http qwikspot-process-due --project PROJECT_ID --location asia-south1 \
  --schedule "*/2 * * * *" --http-method POST \
  --uri "https://qwikspot-api-XXXX.a.run.app/api/internal/process-due" \
  --oidc-service-account-email qwikspot-scheduler@PROJECT_ID.iam.gserviceaccount.com
```

## 10. Verify — `demo:check` ✅

```bash
BASE_URL=https://PROJECT_ID.web.app STOREFRONT_ORIGIN=https://PROJECT_ID.web.app \
FIREBASE_API_KEY=<public web api key> DEMO_PASSWORD='<the demo password>' npm run demo:check
```
It walks health → the four sign-ins → platform → brand → retailer stock → a customer conversation → AI decision → reservation → store fulfilment with the pickup code → the OFFLINE outcome in insights, printing ✔ / ✘ per step and exiting non-zero on failure. It never resets the demo and uses a fresh `judge_check_xxxx` customer. Also check `GET /api/health` shows the deployed `commit`.

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
| Service exits: "The gcp profile refuses local/mock infrastructure" | A selector (`COMMERCE_PROVIDER`, …) or an emulator host is set |
| `503 SERVICE_UNAVAILABLE` from every route | Firestore not reachable / service account lacks `datastore.user` |
| Login panel missing on the judged site | `DEMO_MODE` is not `true` or `DEMO_LOGINS` is not attached |
| `demo:check` ✘ "no store offered" | Stock exhausted by earlier sessions — press Reset demo |
| Reset demo → 403 | The brand is not in `DEMO_BRAND_IDS` |
| Reset demo → 500, demo brand has no stock | The rebuild failed after the wipe (e.g. storage not writable); fix the cause and press Reset again — it is idempotent |
