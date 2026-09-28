# Buildwise — Infrastructure

How Buildwise runs in the `local` profile and how it is deployed in the `gcp` profile
(docs/03_TECH_ARCHITECTURE.md §2.2). The main build path is local-first; GCP cutover is
phase G1 (docs/10_EXECUTION_PLAN.md).

```text
Browser ──► Firebase Hosting ──(/api/** rewrite)──► Cloud Run: buildwise-api ──► Firestore
   │                                                    ▲
   └──── Firebase Auth (sign-in, ID tokens) ────────────┘ (ID token verified on every request)
```

| Piece | Local | Deployed |
|---|---|---|
| Frontend | Vite dev server `:5173` | Firebase Hosting (`frontend/dist`) |
| API | `tsx watch` on `:8080` | Cloud Run service `buildwise-api` |
| `/api` routing | Vite proxy → `:8080` | Hosting rewrite → Cloud Run (same origin) |
| Auth | Auth emulator `:9099` | Firebase Authentication (Email/Password) |
| Database | Firestore emulator `:8085` | Firestore (Native mode) |
| Credentials | none (emulators) or `gcloud auth application-default login` | Cloud Run service account (ADC). No key files. |
| Profile | `BUILDWISE_PROFILE=local` (default) | `BUILDWISE_PROFILE=gcp`, `VITE_BUILDWISE_PROFILE=gcp` |
| Adapters | mock commerce, simulator channel, mock agent, local files (`backend/.data`), local event sink | Shopify, WhatsApp (+ simulator fallback), ADK + Gemini, Cloud Storage, BigQuery (phase G2) |
| Config | none required (optional `backend/.env`) | Cloud Run env vars, `frontend/.env.production.local` at build time |
| Secrets | none | Secret Manager (phase G1/G2) |

The gcp profile refuses to start with any mock/local adapter or the emulators.

---

## Local development

Requires Node.js 24 (`.nvmrc`) and Java 21+ (Firestore emulator). No `.env` files are required.

```bash
npm install

# terminal 1: Firebase emulators (Auth + Firestore, UI at http://127.0.0.1:4000)
npm run emulators

# terminal 2: synthetic demo users for the three internal roles (emulators only; password buildwise-demo-1)
npm run seed:demo

# terminal 2: API (local profile)
npm run dev:backend

# terminal 3: web app → http://localhost:5173
npm run dev:frontend
```

To start from an empty emulator with only a platform admin (the real bootstrap flow):

```bash
npm run seed:platform-admin -- --email ops@buildwise.test --password 'change-me-123'
```

Then sign in as that user, create a brand and provision its Brand Admin in the Platform Admin console.

Tests:

```bash
npm test               # backend + frontend unit tests (no emulators needed)
npm run test:emulator  # full auth chain + Firestore rules against the emulators
npm run typecheck
npm run build
```

Windows note: after an emulator run, the Firestore emulator's `java.exe` sometimes keeps port 8085 open, and the next run then fails with "port taken". Find it with `netstat -ano | findstr :8085` and stop that PID.

---

## One-time Google Cloud / Firebase setup

Replace `PROJECT_ID`. Region `asia-south1` is used throughout. If you change it,
also change it in `firebase.json` (hosting rewrite) and `deploy-backend.sh`.

1. **Project.** Create a GCP project and add Firebase to it (Firebase console → Add project → select the GCP project). Hosting rewrites to Cloud Run require the Blaze plan.

2. **APIs.**
   ```bash
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
     artifactregistry.googleapis.com firestore.googleapis.com \
     identitytoolkit.googleapis.com --project PROJECT_ID
   ```

3. **Firestore.** Create the database in Native mode, region `asia-south1`.

4. **Firebase Authentication.**
   - Enable the **Email/Password** provider.
   - Authentication → Settings → User actions: **disable "Enable create (sign-up)"**. Users are provisioned by an admin (seed script), never self-registered.
   - Authentication → Settings → Authorized domains: keep the Hosting domain(s).

5. **Web app config.** Firebase console → Project settings → Your apps → add a Web app. Copy its config into `frontend/.env.production.local` (git-ignored). These values are public identifiers, not secrets.

6. **Runtime service account** (least privilege):
   ```bash
   gcloud iam service-accounts create buildwise-api --project PROJECT_ID
   gcloud projects add-iam-policy-binding PROJECT_ID \
     --member "serviceAccount:buildwise-api@PROJECT_ID.iam.gserviceaccount.com" \
     --role roles/datastore.user
   ```
   Verifying ID tokens needs no IAM role (it uses Google's public keys).
   `roles/secretmanager.secretAccessor` is granted per secret when secrets arrive (M2+).

7. **Artifact Registry.**
   ```bash
   gcloud artifacts repositories create buildwise --repository-format docker \
     --location asia-south1 --project PROJECT_ID
   ```

## Deploy

```bash
PROJECT_ID=PROJECT_ID infrastructure/scripts/deploy-backend.sh    # Cloud Build → Cloud Run
PROJECT_ID=PROJECT_ID infrastructure/scripts/deploy-frontend.sh   # Hosting + Firestore rules
```

Bootstrap the first PLATFORM_ADMIN (the only user created by a script, docs/07 §4.4).
The script refuses to write to a real project without `--confirm-project`. It uses
your ADC credentials, which need Firebase Auth admin and Firestore write access:

```bash
BUILDWISE_PROFILE=gcp GOOGLE_CLOUD_PROJECT=PROJECT_ID npm run seed:platform-admin -- \
  --confirm-project PROJECT_ID --email ops@buildwise.example --password '<strong password>'
```

Everything else is provisioned in the product: the Platform Admin creates each brand and its
single Brand Admin; the Brand Admin creates retailers and provisions one Retail Admin per store, who
operates only that store (a retailer may own many stores; stores come from retail ingestion).

Smoke test: open the Hosting URL, sign in as the platform admin, and confirm the Platform Admin console loads.
`GET https://<hosting-domain>/api/health` should return `{"status":"ok"}`.
