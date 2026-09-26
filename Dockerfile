# syntax=docker/dockerfile:1
#
# Auriva backend — Node API plus everything pronunciation scoring shells out to:
#   layer 1  ffmpeg                          (MFCC-DTW)
#   layer 2  ml/venv python + torch + espeak (phoneme GOP worker)
#   layer 3  whisper-cli                     (word verification)
# Every one of these degrades SILENTLY when missing, so each is checked at
# build time below — a broken image fails the build instead of scoring worse.
#
# The ~2.6 GB of models are NOT in the image: they are mounted at /app/models
# (hf-cache/ and ggml-base.en.bin), see auriva-deploy/docker-compose.yml.

# ─── whisper.cpp → Linux whisper-cli ──────────────────────────────────────────
# models/whisper/ in the repo holds Windows .exe/.dll files; those cannot run
# here, so the CLI is compiled from source against the same Debian release as
# the runtime image.
FROM debian:trixie-slim AS whisper
ARG WHISPER_CPP_VERSION=v1.7.6
RUN apt-get update \
 && apt-get install -y --no-install-recommends git cmake build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${WHISPER_CPP_VERSION} https://github.com/ggml-org/whisper.cpp /src
WORKDIR /src
# GGML_NATIVE=OFF: CI compiles on a different CPU than the Azure VM runs on, so
# target an explicit, portable instruction set (every current Azure x64 CPU has
# AVX2/FMA/F16C) rather than whatever the build machine happens to support.
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON \
      -DWHISPER_BUILD_TESTS=OFF \
 && cmake --build build --config Release -j"$(nproc)" --target whisper-cli

# ─── Runtime ──────────────────────────────────────────────────────────────────
# trixie ships Python 3.13 — the same minor version as the developers' ml/venv.
FROM node:24-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-venv ffmpeg espeak-ng libsndfile1 libgomp1 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=whisper /src/build/bin/whisper-cli /usr/local/bin/whisper-cli

WORKDIR /app

# Python venv at ml/venv — phonemeGopService's default PYTHON_PATH on Linux.
# Before the app code so this slow, rarely-changing layer stays cached.
COPY ml/requirements.txt ml/constraints.txt ml/
RUN python3 -m venv ml/venv \
 && ml/venv/bin/pip install --no-cache-dir --upgrade pip \
 && ml/venv/bin/pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.13.0 \
 && ml/venv/bin/pip install --no-cache-dir -r ml/requirements.txt -c ml/constraints.txt

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .
RUN mkdir -p logs models credentials && chown node:node logs

ENV NODE_ENV=production \
    PORT=3000 \
    PHONEME_GOP_PYTHON=/app/ml/venv/bin/python \
    HF_HOME=/app/models/hf-cache \
    WHISPER_MODEL_PATH=/app/models/ggml-base.en.bin \
    WHISPER_CLI_PATH=whisper-cli \
    PHONEMIZER_ESPEAK_LIBRARY=/usr/lib/x86_64-linux-gnu/libespeak-ng.so.1

# Fail the build if any scoring dependency is missing (see header).
RUN ffmpeg -version > /dev/null \
 && whisper-cli -h > /dev/null 2>&1 \
 && ml/venv/bin/python -c "import torch, transformers, soundfile; \
from phonemizer.backend import EspeakBackend; EspeakBackend('en-us'); \
print('scoring deps ok: torch', torch.__version__, '| transformers', transformers.__version__)"

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
