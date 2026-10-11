#!/usr/bin/env bash
# One-time Google Cloud setup for Qwikspot (L1; docs/12_DEPLOYMENT_RUNBOOK.md §1–§3).
# Idempotent: every step checks before it creates, so it is safe to re-run.
# It never creates secret VALUES — it prints the commands for you to run with your own values.
#
# Usage (from the repo root, signed in with `gcloud auth login` as a project owner):
#   PROJECT_ID=qwikspot REGION=asia-south1 infrastructure/scripts/setup-project.sh
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-asia-south1}"           # must match firebase.json and deploy-backend.sh
REPO="qwikspot"                           # Artifact Registry repository
API_SA="qwikspot-api@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_SA="qwikspot-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"
BUCKET="qwikspot-${PROJECT_ID}-uploads"   # GCS_BUCKET
DATASET="qwikspot"                        # BIGQUERY_DATASET
SCHEMA="infrastructure/bigquery/events.schema.json"
WEB_ORIGINS=("https://${PROJECT_ID}.web.app" "https://${PROJECT_ID}.firebaseapp.com")

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok() { printf '   ✔ %s\n' "$*"; }
gc() { gcloud --project "$PROJECT_ID" --quiet "$@"; }

[ -f "$SCHEMA" ] || { echo "Run from the repository root ($SCHEMA not found)"; exit 1; }
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

say "1. APIs (runbook §1)"
gc services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com identitytoolkit.googleapis.com secretmanager.googleapis.com \
  aiplatform.googleapis.com bigquery.googleapis.com storage.googleapis.com \
  cloudscheduler.googleapis.com iamcredentials.googleapis.com firebase.googleapis.com
ok "enabled (iamcredentials: signed upload URLs; firebase: Hosting)"

say "2. Firestore (Native mode, ${REGION})"
if gc firestore databases describe --database='(default)' >/dev/null 2>&1; then
  ok "database (default) exists"
else
  gc firestore databases create --database='(default)' --location="$REGION" --type=firestore-native
  ok "created (default)"
fi

say "3. Artifact Registry repository ${REPO}"
if gc artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1; then
  ok "exists"
else
  gc artifacts repositories create "$REPO" --repository-format docker --location "$REGION"
  ok "created"
fi

say "4. Service accounts"
for name in qwikspot-api qwikspot-scheduler; do
  if gc iam service-accounts describe "${name}@${PROJECT_ID}.iam.gserviceaccount.com" >/dev/null 2>&1; then
    ok "${name} exists"
  else
    gc iam service-accounts create "$name" --display-name "$name"
    ok "${name} created"
  fi
done

say "5. Project-level roles for ${API_SA} (runbook §2)"
for role in roles/datastore.user roles/firebaseauth.admin roles/aiplatform.user; do
  gc projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:${API_SA}" --role "$role" \
    --condition=None >/dev/null
  ok "$role"
done
# Signed upload URLs from Cloud Run (no key file): the service account signs with its own
# identity via IAM signBlob — granted on itself only, not project-wide.
gc iam service-accounts add-iam-policy-binding "$API_SA" --member "serviceAccount:${API_SA}" \
  --role roles/iam.serviceAccountTokenCreator >/dev/null
ok "roles/iam.serviceAccountTokenCreator on itself (signBlob for signed upload URLs)"

say "6. Upload bucket gs://${BUCKET} (GCS_BUCKET)"
if gcloud storage buckets describe "gs://${BUCKET}" --project "$PROJECT_ID" >/dev/null 2>&1; then
  ok "exists"
else
  gcloud storage buckets create "gs://${BUCKET}" --project "$PROJECT_ID" --location "$REGION" \
    --uniform-bucket-level-access --public-access-prevention
  ok "created (uniform access, public access prevention)"
fi
gcloud storage buckets update "gs://${BUCKET}" --uniform-bucket-level-access --public-access-prevention >/dev/null
CORS_FILE="$(mktemp)"
cat > "$CORS_FILE" <<EOF
[{"origin": ["${WEB_ORIGINS[0]}", "${WEB_ORIGINS[1]}"],
  "method": ["PUT"],
  "responseHeader": ["Content-Type", "x-goog-content-length-range"],
  "maxAgeSeconds": 3600}]
EOF
gcloud storage buckets update "gs://${BUCKET}" --cors-file="$CORS_FILE" >/dev/null
rm -f "$CORS_FILE"
ok "CORS: browser PUT from ${WEB_ORIGINS[*]} (signed upload URLs)"
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --member "serviceAccount:${API_SA}" \
  --role roles/storage.objectAdmin >/dev/null
ok "roles/storage.objectAdmin for ${API_SA} on this bucket only"

say "7. BigQuery dataset ${DATASET} and table events (BIGQUERY_DATASET)"
if bq --project_id "$PROJECT_ID" show --dataset "${PROJECT_ID}:${DATASET}" >/dev/null 2>&1; then
  ok "dataset exists"
else
  bq --project_id "$PROJECT_ID" --location "$REGION" mk --dataset \
    --description "Qwikspot commerce events (BigQueryEventSink)" "${PROJECT_ID}:${DATASET}"
  ok "dataset created in ${REGION}"
fi
if bq --project_id "$PROJECT_ID" show "${PROJECT_ID}:${DATASET}.events" >/dev/null 2>&1; then
  ok "table events exists"
else
  bq --project_id "$PROJECT_ID" mk --table --time_partitioning_field event_timestamp \
    --time_partitioning_type DAY --description "One row per CommerceEvent; insertId = event_id" \
    "${PROJECT_ID}:${DATASET}.events" "$SCHEMA"
  ok "table events created (partitioned by day on event_timestamp)"
fi
bq --project_id "$PROJECT_ID" --location "$REGION" query --nouse_legacy_sql \
  "GRANT \`roles/bigquery.dataEditor\` ON SCHEMA \`${PROJECT_ID}.${DATASET}\` TO \"serviceAccount:${API_SA}\"" >/dev/null
ok "roles/bigquery.dataEditor for ${API_SA} on this dataset only"

say "8. Cloud Build can build and push the image"
# Newer projects build as the Compute Engine default service account; older ones as the
# legacy Cloud Build account. Grant whichever exists, scoped to what a build needs.
for build_sa in "${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" "${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"; do
  # (the account that does not exist in this project just fails quietly)
  if true; then
    gc artifacts repositories add-iam-policy-binding "$REPO" --location "$REGION" \
      --member "serviceAccount:${build_sa}" --role roles/artifactregistry.writer >/dev/null 2>&1 \
      && ok "artifactregistry.writer on ${REPO} for ${build_sa}" || true
    for role in roles/logging.logWriter roles/storage.objectViewer; do
      gc projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:${build_sa}" --role "$role" \
        --condition=None >/dev/null 2>&1 && ok "${role} for ${build_sa}" || true
    done
  fi
done
CALLER="$(gcloud config get-value account 2>/dev/null)"
gc iam service-accounts add-iam-policy-binding "$API_SA" --member "user:${CALLER}" \
  --role roles/iam.serviceAccountUser >/dev/null 2>&1 && ok "you (${CALLER}) may deploy as ${API_SA}" || true
gc iam service-accounts add-iam-policy-binding "$SCHEDULER_SA" --member "user:${CALLER}" \
  --role roles/iam.serviceAccountUser >/dev/null 2>&1 && ok "you may create Scheduler jobs that act as ${SCHEDULER_SA}" || true

say "9. Organisation policies"
# Domain restricted sharing blocks granting allUsers the Cloud Run invoker role, which
# `--allow-unauthenticated` needs (every route authenticates in-app; Hosting and Shopify must reach it).
DRS="$(gcloud org-policies describe iam.allowedPolicyMemberDomains --project "$PROJECT_ID" --effective --format=json 2>/dev/null || true)"
if [ -n "$DRS" ] && ! grep -q '"allowAll": *true' <<<"$DRS" && grep -q '"values"\|"allowedValues"' <<<"$DRS"; then
  cat <<EOF
   ! iam.allowedPolicyMemberDomains is enforced for this project: Cloud Run cannot be made public
     (--allow-unauthenticated fails). Override it for THIS PROJECT ONLY (needs roles/orgpolicy.policyAdmin
     on the organisation), then re-run deploy-backend.sh:

     cat > /tmp/qwikspot-drs.yaml <<'YAML'
     name: projects/${PROJECT_ID}/policies/iam.allowedPolicyMemberDomains
     spec:
       rules:
         - allowAll: true
     YAML
     gcloud org-policies set-policy /tmp/qwikspot-drs.yaml

     Why: every Qwikspot route authenticates in the app (Firebase ID tokens, Shopify HMAC, OIDC);
     Cloud Run IAM only has to let the Hosting rewrite and Shopify's webhooks through.
EOF
else
  ok "iam.allowedPolicyMemberDomains does not block allUsers here"
fi
ok "iam.disableServiceAccountKeyCreation is irrelevant: Qwikspot uses no key files (ADC on Cloud Run)"

say "10. Secrets — run these yourself with your own values (nothing was created)"
cat <<EOF
   Each one: create the secret from stdin, then let ${API_SA} read that secret only.
   (In Git Bash or Cloud Shell. Values never go into the repository or your shell history:
    prefer \`read -rs VALUE\` then \`printf '%s' "\$VALUE" | ...\`.)
EOF
for secret in SHOPIFY_API_KEY SHOPIFY_API_SECRET TOKEN_ENCRYPTION_KEY SHOPPER_SESSION_SECRET DEMO_LOGINS; do
  cat <<EOF

   printf '%s' '<${secret} value>' | gcloud secrets create ${secret} --data-file=- --replication-policy=automatic --project ${PROJECT_ID}
   gcloud secrets add-iam-policy-binding ${secret} --project ${PROJECT_ID} \\
     --member serviceAccount:${API_SA} --role roles/secretmanager.secretAccessor
EOF
done
cat <<EOF

   Values:
     SHOPIFY_API_KEY / SHOPIFY_API_SECRET  Dev Dashboard → Qwikspot app → Settings (Client ID / Client secret)
     TOKEN_ENCRYPTION_KEY                  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
                                           (keep the SAME key as long as stored Shopify tokens must stay readable)
     SHOPPER_SESSION_SECRET                at least 32 random characters, e.g. the same node command
     DEMO_LOGINS                           the JSON printed by \`npm run seed:live\` (runbook §8) — create it after seeding
   Later (WhatsApp, L2): WHATSAPP_ACCESS_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN — not needed while
   MESSAGING_CHANNELS=simulator.
EOF

say "Done"
cat <<EOF
   GCS_BUCKET=${BUCKET}
   BIGQUERY_DATASET=${DATASET}
   SCHEDULER_SERVICE_ACCOUNT=${SCHEDULER_SA}
   Next: create the secrets above, then docs/12_DEPLOYMENT_RUNBOOK.md §4 (Firestore rules/indexes) and §5 (deploy).
EOF
