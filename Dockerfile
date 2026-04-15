# Azure Container Apps optimised image
FROM node:20-alpine

# Create non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Install dependencies only (production)
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY . .

# Transfer ownership to non-root user
RUN chown -R appuser:appgroup /app

ENV NODE_ENV=production
EXPOSE 4000

USER appuser

CMD ["node", "src/index.js"]
