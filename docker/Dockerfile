FROM node:22-slim

RUN npm install -g @mariozechner/pi-coding-agent@latest @anthropic-ai/claude-code@2.1.114 @modelcontextprotocol/sdk@1.29.0 zod@3.25.76 && \
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

RUN mkdir -p /vault /root/.pi/agent/agents /root/.pi/agent/extensions /node_modules/@mariozechner /node_modules/@modelcontextprotocol && \
    ln -s /usr/local/lib/node_modules/@mariozechner/pi-coding-agent /node_modules/@mariozechner/pi-coding-agent && \
    ln -s /usr/local/lib/node_modules/@modelcontextprotocol/sdk /node_modules/@modelcontextprotocol/sdk && \
    ln -s /usr/local/lib/node_modules/zod /node_modules/zod

RUN cd /usr/local/lib/node_modules/@mariozechner/pi-coding-agent && \
    npm install pi-subagents --save=false

RUN ln -s /usr/local/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/pi-subagents \
      /root/.pi/agent/extensions/subagent

COPY agents/ /opt/ghostbox/agents/
COPY skills/ghostbox-api/SKILL.md /opt/ghostbox/skills/ghostbox-api/SKILL.md

# auth.json is mounted at runtime and not baked into the image.

COPY ghost-server.js /ghost-server.js
COPY ghost-server-claude.js /ghost-server-claude.js
COPY ghostbox-mcp-server.js /ghostbox-mcp-server.js
COPY qmd-mcp-server.js /qmd-mcp-server.js
COPY entrypoint.sh /entrypoint.sh
COPY ghost-save /usr/local/bin/ghost-save
COPY ghost-changelog /usr/local/bin/ghost-changelog
COPY exa-search /usr/local/bin/exa-search
COPY ghost-nudge /usr/local/bin/ghost-nudge
COPY qmd /usr/local/bin/qmd
RUN chmod +x /entrypoint.sh
RUN chmod +x /usr/local/bin/ghost-save
RUN chmod +x /usr/local/bin/ghost-changelog
RUN chmod +x /usr/local/bin/exa-search
RUN chmod +x /usr/local/bin/ghost-nudge
RUN chmod +x /usr/local/bin/qmd

WORKDIR /vault
EXPOSE 3000 8001-8009

CMD ["/entrypoint.sh"]
