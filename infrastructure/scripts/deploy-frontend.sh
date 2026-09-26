#!/usr/bin/env bash
# Build the React app and deploy it to Firebase Hosting, together with the
# deny-all Firestore rules.
# Requires frontend/.env.production.local with the project's public Firebase web config.
# Usage (from the repo root): PROJECT_ID=my-project infrastructure/scripts/deploy-frontend.sh
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID}"

npm run build --workspace frontend
npx firebase deploy --project "$PROJECT_ID" --only hosting,firestore:rules
