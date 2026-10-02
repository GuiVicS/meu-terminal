FROM node:24-trixie-slim

# Install additional terminal utilities and prerequisites
RUN apt-get update && apt-get upgrade -y && apt-get install -y --fix-missing \
    apt-utils \
    curl \
    wget \
    ssh \
    git \
    vim \
    nano \
    htop \
    net-tools \
    iputils-ping \
    fontconfig \
    unzip \
    locales \
    traceroute \
    build-essential \
    python3 \
    # File manager: Google Drive and other clouds (configure with "rclone config")
    rclone \
    # Browser tabs: headless Chromium on the server + fonts so pages render text/emoji
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Configure locales
RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && \
    locale-gen en_US.UTF-8 && \
    update-locale LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# Set environment variables for locale
ENV LANG=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    LC_ALL=en_US.UTF-8 \
    SHELL=/bin/bash \
    CHROMIUM_PATH=/usr/bin/chromium

# "npm i -g" and user installers (Claude Code, pipx, uv...) go to the home folder,
# which is a volume (docker-compose.yml): installed tools survive redeploys
ENV NPM_CONFIG_PREFIX=/root/.npm-global \
    PATH=/root/.npm-global/bin:/root/.local/bin:$PATH

# Install Starship
RUN curl -sS https://starship.rs/install.sh | sh -s -- --yes

# Claude Code comes with the image ("claude" in any terminal). Goes to /usr/local, not
# the home volume, so every deploy brings the current version.
RUN npm install -g --prefix /usr/local @anthropic-ai/claude-code && npm cache clean --force

# Agent UI ("Deseja usar o modo Claude Code UI?"): Claude Code over ACP (scripts/agents/).
# OpenCode speaks ACP natively; Codex needs @agentclientprotocol/codex-acp (installed by the user).
RUN npm install -g --prefix /usr/local @agentclientprotocol/claude-agent-acp && npm cache clean --force

# Vibecoding "Publicar": deploys the project with the Vercel CLI (needs VERCEL_TOKEN set by the user).
RUN npm install -g --prefix /usr/local vercel && npm cache clean --force

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install dependencies
RUN npm ci --production && \
    npm cache clean --force

# Copy entrypoint script and set permissions
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create data directory
RUN mkdir -p data

# Copy application files
COPY . .

# Build node-pty and copy xterm files
RUN npm run copy-xterm

# Expose port
EXPOSE 3000

# Start the application
ENTRYPOINT ["/entrypoint.sh"]
CMD ["npm", "start"]