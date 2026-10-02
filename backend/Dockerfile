# Buildwise API — Cloud Run image.
# Build from the REPO ROOT (the npm workspace lockfile lives there):
#   docker build -f backend/Dockerfile -t buildwise-api .

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --workspace backend --include-workspace-root=false --ignore-scripts
COPY backend/tsconfig.json backend/tsconfig.build.json backend/
COPY backend/src backend/src
RUN npm run build --workspace backend

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --workspace backend --include-workspace-root=false --omit=dev --ignore-scripts \
  && npm cache clean --force
COPY --from=build /app/backend/dist backend/dist
# Reset demo and seed:live read the judge stock fixture at runtime (BundledFixtureSource).
COPY backend/fixtures backend/fixtures

# Run as the unprivileged user shipped with the node image.
USER node
# Cloud Run injects PORT (default 8080).
EXPOSE 8080
CMD ["node", "backend/dist/server.js"]
