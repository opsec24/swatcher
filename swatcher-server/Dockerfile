# ==============================================================================
# swatcher Central Server - Production Dockerfile
# ==============================================================================
FROM node:22-alpine

# Install wget and ca-certificates for health checks
RUN apk add --no-cache ca-certificates wget

WORKDIR /usr/src/app

# Set production environment
ENV NODE_ENV=production
ENV PORT=9090

# Copy package descriptors first for layer caching
COPY package*.json ./

# Install only production dependencies cleanly
RUN npm ci --omit=dev --no-audit --no-fund

# Copy server application source and public assets
COPY src/ ./src/
COPY public/ ./public/

# Use unprivileged user for container runtime security
RUN chown -R node:node /usr/src/app
USER node

# Expose the central governance port
EXPOSE 9090

# Health check endpoint
HEALTHCHECK --interval=20s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:9090/health || exit 1

# Start the enterprise ingestion and dashboard server
CMD ["node", "src/server.js"]
