# Production image — compatible with Azure Container Apps and Render.
# PORT is read from the environment (process.env.PORT || 4000).
FROM node:20-alpine

# Create non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Install dependencies only (production)
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY . .

# Create logs directory that Winston File transports require at runtime.
# The logs/ dir is excluded from Docker context via .dockerignore so it
# must be created explicitly here.
RUN mkdir -p /app/logs

# Transfer ownership to non-root user
RUN chown -R appuser:appgroup /app

ENV NODE_ENV=production
EXPOSE 4000

USER appuser

CMD ["node", "src/index.js"]
