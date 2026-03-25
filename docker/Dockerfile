FROM node:22-slim

RUN npm install -g @mariozechner/pi-coding-agent@latest && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      git \
      ripgrep \
      python3 \
      python3-pip \
      python3-venv \
      curl \
      wget \
      jq \
      build-essential \
      ca-certificates \
      unzip && \
    rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"
ENV NODE_PATH="/usr/local/lib/node_modules"

RUN mkdir -p /vault /root/.pi/agent /node_modules/@mariozechner && \
    ln -s /usr/local/lib/node_modules/@mariozechner/pi-coding-agent /node_modules/@mariozechner/pi-coding-agent

# auth.json is mounted at runtime and not baked into the image.

COPY ghost-server.js /ghost-server.js
COPY entrypoint.sh /entrypoint.sh
COPY ghost-save /usr/local/bin/ghost-save
COPY ghost-changelog /usr/local/bin/ghost-changelog
COPY exa-search /usr/local/bin/exa-search
COPY ghost-memory /usr/local/bin/ghost-memory
COPY qmd /usr/local/bin/qmd
RUN chmod +x /entrypoint.sh
RUN chmod +x /usr/local/bin/ghost-save
RUN chmod +x /usr/local/bin/ghost-changelog
RUN chmod +x /usr/local/bin/exa-search
RUN chmod +x /usr/local/bin/ghost-memory
RUN chmod +x /usr/local/bin/qmd

WORKDIR /vault
EXPOSE 3000 8001-8009

CMD ["/entrypoint.sh"]
