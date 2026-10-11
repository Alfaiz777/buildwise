#!/usr/bin/env bash
# Build the API image with Cloud Build and deploy it to Cloud Run.
# Usage (from the repo root): PROJECT_ID=my-project infrastructure/scripts/deploy-backend.sh
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-asia-south1}"   # must match firebase.json hosting rewrite region
SERVICE="qwikspot-api"           # must match firebase.json hosting rewrite serviceId
REPO="qwikspot"
SERVICE_ACCOUNT="qwikspot-api@${PROJECT_ID}.iam.gserviceaccount.com"
COMMIT="$(git rev-parse --short HEAD)"
VERSION="$(node -p "require('./backend/package.json').version")"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE}:${COMMIT}"

gcloud builds submit \
  --project "$PROJECT_ID" \
  --config infrastructure/cloudbuild/backend.yaml \
  --substitutions "_IMAGE=${IMAGE}" \
  .

# --allow-unauthenticated: Cloud Run IAM does not gate callers. Every /api route
# except /api/health authenticates in-app (Firebase ID token, Shopify HMAC, signed shopper
# sessions, Cloud Scheduler OIDC), and the Firebase Hosting rewrite and the Shopify
# webhooks need to reach it. (If the org policy iam.allowedPolicyMemberDomains blocks it,
# see infrastructure/scripts/setup-project.sh.)
#
# --no-cpu-throttling: CPU stays allocated after the response, so background work finishes
#   (the Shopify catalogue refresh after a webhook, queued BigQuery inserts).
# --min-instances 1: no cold start in the chat path (5 s reply target); --max-instances 3
#   bounds cost under abuse (docs/07 §17).
# --update-env-vars (not --set-env-vars): keeps the configuration and secrets attached once
#   with `gcloud run services update` (docs/12 §5); a redeploy only refreshes these.
gcloud run deploy "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --image "$IMAGE" \
  --service-account "$SERVICE_ACCOUNT" \
  --allow-unauthenticated \
  --update-env-vars "NODE_ENV=production,QWIKSPOT_PROFILE=gcp,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},LOG_LEVEL=info,BUILD_VERSION=${VERSION},BUILD_COMMIT=${COMMIT}" \
  --no-cpu-throttling \
  --cpu 1 \
  --memory 512Mi \
  --timeout 60 \
  --min-instances 1 \
  --max-instances 3
