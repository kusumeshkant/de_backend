# Production image — compatible with Azure Container Apps and Render.
# PORT is read from the environment (process.env.PORT || 4000).
FROM node:20-alpine

# Create non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Install dependencies only (production)
COPY package*.json ./
RUN npm install --omit=dev

# Transfer node_modules ownership before copying app source.
# Doing chown here (only covers node_modules) is fast.
# Doing it after COPY . . would chown 50k+ source files too — 10+ min slowdown.
RUN chown -R appuser:appgroup /app

# Copy application source (owned by root in the image layer; appuser can read)
COPY . .

# Create logs directory that Winston File transports require at runtime.
# Owned by appuser so the app can write logs when running as non-root.
RUN mkdir -p /app/logs && chown appuser:appgroup /app/logs

ENV NODE_ENV=production
EXPOSE 4000

USER appuser

CMD ["node", "src/index.js"]
