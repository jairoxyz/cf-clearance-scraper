# =========================
# 1) Builder stage
# =========================
FROM node:lts-slim AS builder

WORKDIR /app

# Install deps for building node_modules (no system Chromium libs needed here)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy source
COPY . .

# If you have a build step (TypeScript, bundling), do it here:
# RUN npm run build

# Optional: remove any leftover tooling caches
RUN rm -rf /tmp/* /var/tmp/*


# =========================
# 2) Runtime stage
# =========================
FROM node:lts-slim AS runtime


# --- Minimal OS deps ---
# Keep only what you need to run headed Chromium with Xvfb + your binary.
RUN apt-get update && apt-get install -y --no-install-recommends \
    gosu \
    ca-certificates \
    xvfb \
    # chromium deps
    libglib2.0-0 \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libatspi2.0-0 \
    libgtk-3-0 \
    libdbus-1-3 \
    libcups2 \
    libexpat1 \
    libudev1 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxrender1 \
    libxi6 \
    libxkbcommon0 \
    libdrm2 \
    libgbm1 \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libfontconfig1 \
    libfreetype6 \
    libpng16-16 \
    libasound2 \
    fonts-liberation \
    fonts-noto-color-emoji fonts-freefont-ttf fonts-unifont \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-tlwg-loma-otf \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only what is needed from builder
COPY --from=builder /app /app

# Install pm2 (optional; see note below)
# RUN npm i -g pm2 && npm cache clean --force

# Create cache dir & permissions for node user
RUN mkdir -p /home/node/.cloakbrowser \
 && chown -R node:node /home/node /app

# Create the X11 socket directory with correct root ownership and permissions
RUN mkdir -p /tmp/.X11-unix \
&& chown root:root /tmp/.X11-unix \
&& chmod 1777 /tmp/.X11-unix

# USER node

# drop to user node via gosu in entrypoint.sh after setting TZ from env
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV HOME=/home/node \
    DISPLAY=:99 \
    NODE_ENV=production \
    PORT=3001 \
    LOG=0 \
    CLOAKBROWSER_CACHE_DIR=/home/node/.cloakbrowser \
    CLOAKBROWSER_AUTO_UPDATE=false

EXPOSE 3001

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
# CMD ["pm2-runtime", "src/index.js"]
CMD ["node", "src/index.js"]

