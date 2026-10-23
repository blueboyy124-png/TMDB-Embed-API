# ---------- Build Stage ----------
FROM node:20-alpine AS build
ARG VERSION=dev
WORKDIR /app

# Install only production dependencies first (leveraging cache)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy only required source (avoid sending screenshots, node_modules already installed)
COPY apiServer.js ./
COPY providers ./providers
COPY proxy ./proxy
COPY public ./public
COPY utils ./utils
COPY README.md ./

# ---------- Runtime Stage ----------
FROM node:20-alpine AS runtime
ARG VERSION=dev
WORKDIR /app
ENV NODE_ENV=production \
    API_PORT=8787 \
    BIND_HOST=0.0.0.0 \
    APP_VERSION=${VERSION}

# Create non-root user
RUN addgroup -S app && adduser -S app -G app

# Copy node_modules from build and necessary source
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apiServer.js ./
COPY --from=build /app/public ./public
COPY --from=build /app/providers ./providers
COPY --from=build /app/proxy ./proxy
COPY --from=build /app/utils ./utils
COPY --from=build /app/package.json ./
COPY --from=build /app/README.md ./

# Expose port (documentational; runtime can override)
EXPOSE 8787

# Ensure runtime user owns app directory for writes (overrides, restart marker)
RUN chown -R app:app /app
USER app

# Labels / metadata
LABEL org.opencontainers.image.title="TMDB Embed API" \
    org.opencontainers.image.description="Streaming metadata + source aggregation API with multi-key TMDB rotation" \
    org.opencontainers.image.version="${VERSION}" \
    org.opencontainers.image.source="https://github.com/Inside4ndroid/TMDB-Embed-API" \
    org.opencontainers.image.licenses="MIT"

# Healthcheck (simple)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:${API_PORT:-8787}/api/health || exit 1

CMD ["node","apiServer.js"]
