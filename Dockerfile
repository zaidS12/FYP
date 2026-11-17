# AgentFlow: zero-dependency Node server, so there is nothing to install or build.
# Works on Hugging Face Spaces (Docker SDK, app_port 7860) and any other container host.
FROM node:20-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7860 \
    TRUST_PROXY=1 \
    DATA_DIR=/tmp/agentflow-data \
    ALLOW_FAKE_GATEWAY=1
# REMOTE_STORE_URL and REMOTE_STORE_KEY (Supabase) are secrets: set them in the host's settings, never here.
USER node
EXPOSE 7860
CMD ["node", "server.js"]
