# Public build: install the reviewed browser-use 3.1.6 SDK from vendor/browser-use/.
# The package itself is bundled in the local build context and never fetched by name.
ARG NODE_BASE_IMAGE=node:22-bookworm-slim
FROM ${NODE_BASE_IMAGE} AS builder
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG APT_MIRROR=deb.debian.org
ENV NODE_ENV=development
WORKDIR /app
RUN sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm_config_build_from_source=true \
    npm ci --no-audit --no-fund --registry="$NPM_REGISTRY"
COPY vite.config.ts ./
COPY scripts/build-gui-runtimes.mjs ./scripts/build-gui-runtimes.mjs
COPY client ./client
COPY server ./server
COPY gui-runtime ./gui-runtime
COPY native-automation ./native-automation
COPY browser-automation ./browser-automation
COPY skills ./skills
COPY test/fixtures/browser/codex-ui-complex-fixture.html test/fixtures/browser/codex-ui-complex-frame.html test/fixtures/browser/codex-ui-benchmark-download.txt ./test/fixtures/browser/
RUN npm run build && npm prune --omit=dev

FROM ${NODE_BASE_IMAGE} AS runtime
ARG APT_MIRROR=deb.debian.org
ENV PORT=8787 HOST=0.0.0.0 NODE_ENV=production \
    UI_AGENT_DATA_DIR=/data/ui-agent-chat \
    UI_AGENT_DB_MODE=sqlite \
    UI_AGENT_DEFAULT_EXECUTION_RUNTIME=dtcoder \
    UI_AGENT_SERVER_MANAGED_BROWSER=true \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    UI_TEST_PYTHON=/opt/ui-test-assistant-venv/bin/python \
    UI_TEST_ASSISTANT_SKILL_PATH=/opt/ui-test-assistant-skill \
    DT_GUI_COMPUTER_SKILL_PATH=/opt/dt-gui-computer-skill \
    DT_GUI_BROWSER_SKILL_PATH=/opt/dt-gui-browser-skill \
    DT_GUI_BROWSER_CLI=/app/browser-automation/cli.mjs \
    DT_GUI_BROWSER_BIN=/app/browser-automation/bin/dt-gui-browser \
    DT_GUI_COMPUTER_BIN=/opt/native-automation/dt-gui-computer
RUN sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv ca-certificates curl fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/ui-test-assistant-venv
ARG PIP_INDEX_URL=https://pypi.org/simple/
ARG PIP_DEFAULT_TIMEOUT=180
ARG PIP_RETRIES=10
COPY vendor/ui-test-runtime/constraints.txt /tmp/ui-test-runtime-constraints.txt
RUN /opt/ui-test-assistant-venv/bin/pip install \
      --index-url "$PIP_INDEX_URL" \
      --timeout "$PIP_DEFAULT_TIMEOUT" \
      --retries "$PIP_RETRIES" \
      --constraint /tmp/ui-test-runtime-constraints.txt \
      playwright==1.58.0
RUN DEBIAN_FRONTEND=noninteractive /opt/ui-test-assistant-venv/bin/python -m playwright install-deps chromium
ARG UIWARDEN_BROWSER_USE_WHEEL_SHA256=
ARG UIWARDEN_BROWSER_USE_REDISTRIBUTION_APPROVED=false
ARG UIWARDEN_PUBLIC_RELEASE=false
COPY vendor/browser-use/browser_use-3.1.6-*.whl /tmp/browser-use/
COPY scripts/verify_browser_use_wheel.py /tmp/verify_browser_use_wheel.py
RUN UIWARDEN_BROWSER_USE_WHEEL_SHA256="$UIWARDEN_BROWSER_USE_WHEEL_SHA256" UIWARDEN_BROWSER_USE_REDISTRIBUTION_APPROVED="$UIWARDEN_BROWSER_USE_REDISTRIBUTION_APPROVED" UIWARDEN_PUBLIC_RELEASE="$UIWARDEN_PUBLIC_RELEASE" \
      python3 /tmp/verify_browser_use_wheel.py /tmp/browser-use \
    && /opt/ui-test-assistant-venv/bin/pip install \
      --index-url "$PIP_INDEX_URL" \
      --timeout "$PIP_DEFAULT_TIMEOUT" \
      --retries "$PIP_RETRIES" \
      --constraint /tmp/ui-test-runtime-constraints.txt \
      /tmp/browser-use/browser_use-3.1.6-*.whl \
      openpyxl==3.1.5 python-docx==1.2.0 \
    && /opt/ui-test-assistant-venv/bin/python -c "import importlib.metadata as m; assert m.version('browser-use') == '3.1.6'" \
    && rm -rf /tmp/browser-use /tmp/verify_browser_use_wheel.py
ARG PLAYWRIGHT_DOWNLOAD_HOST=
ARG PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST=
ARG PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=180000
RUN export PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT \
    && if [ -n "$PLAYWRIGHT_DOWNLOAD_HOST" ]; then export PLAYWRIGHT_DOWNLOAD_HOST; fi \
    && if [ -n "$PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST" ]; then export PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST; fi \
    && /opt/ui-test-assistant-venv/bin/python -m playwright install chromium
RUN /opt/ui-test-assistant-venv/bin/pip install \
      --index-url "$PIP_INDEX_URL" \
      --timeout "$PIP_DEFAULT_TIMEOUT" \
      --retries "$PIP_RETRIES" \
      --constraint /tmp/ui-test-runtime-constraints.txt \
      socksio 'httpx[socks]' \
    && /opt/ui-test-assistant-venv/bin/python -m pip check \
    && /opt/ui-test-assistant-venv/bin/python -c "import browser_use, dotenv, yaml, omegaconf, openpyxl, docx" \
    && rm /tmp/ui-test-runtime-constraints.txt
COPY scripts/patch-browser-use.py /tmp/patch-browser-use.py
RUN /opt/ui-test-assistant-venv/bin/python /tmp/patch-browser-use.py \
    && rm /tmp/patch-browser-use.py
WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/skills/ui-test-assistant-skill /opt/ui-test-assistant-skill
COPY --from=builder /app/skills/dt-gui-computer-skill /opt/dt-gui-computer-skill
COPY --from=builder /app/skills/dt-gui-browser-skill /opt/dt-gui-browser-skill
COPY --from=builder /app/browser-automation ./browser-automation
COPY --from=builder /app/native-automation /opt/native-automation
COPY --from=builder /app/test/fixtures/browser/codex-ui-complex-fixture.html ./evaluation-bench-assets/codex-ui-complex-fixture.html
COPY --from=builder /app/test/fixtures/browser/codex-ui-complex-frame.html ./evaluation-bench-assets/codex-ui-complex-frame.html
COPY --from=builder /app/test/fixtures/browser/codex-ui-benchmark-download.txt ./evaluation-bench-assets/codex-ui-benchmark-download.txt
COPY scripts/start.sh /app/start.sh
COPY LICENSE /app/LICENSE
COPY THIRD_PARTY_NOTICES.md /app/THIRD_PARTY_NOTICES.md
COPY LICENSES/browser-use-MIT.txt /app/LICENSES/browser-use-MIT.txt
RUN CHROMIUM_BIN="$(find /ms-playwright -type f -path '*/chrome-linux*/chrome' -perm /111 | head -1)" \
    && test -n "$CHROMIUM_BIN" \
    && ln -s "$CHROMIUM_BIN" /usr/local/bin/uiwarden-chromium \
    && test -x /opt/native-automation/dt-gui-computer \
    && chmod +x /app/start.sh /app/browser-automation/bin/dt-gui-browser \
    && rm -rf /opt/ui-test-assistant-skill/config/.env /opt/ui-test-assistant-skill/logs /opt/ui-test-assistant-skill/.skill-output
ENV UIWARDEN_SERVER_BROWSER_EXECUTABLE=/usr/local/bin/uiwarden-chromium
ENV PATH=/opt/ui-test-assistant-venv/bin:${PATH}
EXPOSE 8787
VOLUME ["/data/ui-agent-chat"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/start.sh"]
