#!/bin/bash
# AgentMemory startup. Lives in persistent /home so the appCommandLine can be quote-free.
set -e
export HOME=/home
mkdir -p /home/.agentmemory/bin /home/opt /home/data
cd /home/opt
if [ ! -x /home/.agentmemory/bin/iii ]; then
  curl -fsSL "https://github.com/iii-hq/iii/releases/download/iii/v0.11.2/iii-x86_64-unknown-linux-gnu.tar.gz" \
    | tar -xz -C /home/.agentmemory/bin
  chmod +x /home/.agentmemory/bin/iii
fi
if [ ! -x node_modules/.bin/agentmemory ]; then
  rm -rf node_modules package.json package-lock.json
  npm install --no-audit --no-fund @agentmemory/agentmemory@0.9.28
fi
# the npm-bundled engine config binds 127.0.0.1; App Service probes the container IP,
# so the server must bind 0.0.0.0 (mirrors upstream's own deploy entrypoint)
cat > node_modules/@agentmemory/agentmemory/dist/iii-config.yaml <<'YAML'
workers:
  - name: iii-http
    config:
      port: 3111
      host: 0.0.0.0
      default_timeout: 180000
      cors:
        allowed_origins:
          - "http://localhost:3111"
          - "http://127.0.0.1:3111"
        allowed_methods: [GET, POST, PUT, DELETE, OPTIONS]
  - name: iii-state
    config:
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: /home/data/state_store.db
  - name: iii-queue
    config:
      adapter:
        name: builtin
  - name: iii-pubsub
    config:
      adapter:
        name: local
  - name: iii-cron
    config:
      adapter:
        name: kv
  - name: iii-stream
    config:
      port: 3112
      host: 0.0.0.0
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: /home/data/stream_store
  - name: iii-observability
    config:
      enabled: true
      service_name: agentmemory
      exporter: memory
      sampling_ratio: 1.0
      metrics_enabled: true
      logs_enabled: true
      logs_console_output: true
YAML
export PATH=/home/.agentmemory/bin:$PATH
exec ./node_modules/.bin/agentmemory
