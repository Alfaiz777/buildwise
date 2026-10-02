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
# except /api/health authenticates in-app with a Firebase ID token, and the
# Firebase Hosting rewrite (and, later, Shopify/Meta webhooks) need to reach it.
gcloud run deploy "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --image "$IMAGE" \
  --service-account "$SERVICE_ACCOUNT" \
  --allow-unauthenticated \
  --set-env-vars "NODE_ENV=production,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},LOG_LEVEL=info,BUILD_VERSION=${VERSION},BUILD_COMMIT=${COMMIT}" \
  --cpu 1 \
  --memory 512Mi \
  --timeout 60 \
  --min-instances 0 \
  --max-instances 5
