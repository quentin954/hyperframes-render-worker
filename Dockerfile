# Render container: Node 22 + Chromium system libs + hyperframes + ffmpeg/ffprobe.
# Bakes the renderer at build time so cold-start is just container provisioning,
# not package install. Composition files are sent in the request body.
FROM node:22-bookworm-slim

# Chromium runtime libs + FFmpeg/FFprobe.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    ffmpeg \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    wget \
    unzip \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install HyperFrames + ffmpeg-static.
# The Debian ffmpeg package above provides ffprobe.
COPY container/package.json ./package.json

RUN npm install --no-audit --no-fund \
  && ln -sf /app/node_modules/ffmpeg-static/ffmpeg /usr/local/bin/ffmpeg \
  && /usr/local/bin/ffmpeg -version \
  && /usr/bin/ffprobe -version

# Pre-download chrome-headless-shell so the first render doesn't pay for it.
RUN npx --no-install hyperframes browser ensure

# The render server.
COPY container/server.mjs ./server.mjs

ENV PORT=8080
ENV DATA_DIR=/data

# Mount a volume here so job.json, project/ and output.mp4 survive a container
# rebuild: -v /opt/hyperframes/data:/data
RUN mkdir -p /data/jobs

EXPOSE 8080
CMD ["node", "server.mjs"]
