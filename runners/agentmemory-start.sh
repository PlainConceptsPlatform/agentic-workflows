#!/bin/bash
# AgentMemory startup. Lives in persistent /home so the appCommandLine can be quote-free.
set -e
export HOME=/home
mkdir -p /home/.agentmemory/bin /home/opt
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
export PATH=/home/.agentmemory/bin:$PATH
exec ./node_modules/.bin/agentmemory
