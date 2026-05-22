# ---------- build stage ----------
FROM node:lts-slim AS build

WORKDIR /app

# Install build-time tools only if you actually need them
# RUN apt-get update && apt-get install -y --no-install-recommends \
#     ca-certificates \
#     git \
#   && rm -rf /var/lib/apt/lists/*

# Copy only manifests first (better layer caching)
COPY package*.json ./

# Install ONLY production deps for runtime
RUN npm ci --omit=dev

# Copy application source
COPY . .

# ---------- runtime stage ----------
FROM node:lts-slim AS runtime

# Re-declare ARG in this stage if you want to use it here
ARG PORT=3001

WORKDIR /app

# Runtime deps for Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \    
    fonts-liberation \
    bash \
    procps \
  && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium
ENV NODE_ENV=production
ENV PORT=$PORT

# Install pm2 globally (runtime-only)
RUN npm i -g pm2

# Copy app + node_modules from build, with correct ownership
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src

# Drop privileges
USER node

EXPOSE $PORT

CMD ["pm2-runtime", "src/index.js"]