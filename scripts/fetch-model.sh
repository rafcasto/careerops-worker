#!/bin/bash
# Resumable fetch of a trained model from the GPU box + import into Ollama.
# Usage: scripts/fetch-model.sh <outName> <tag> [host]
set -u
OUT="$1"; TAG="$2"; HOST="${3:-gpu}"
LOCAL="$HOME/careerops-training/models/$OUT"; mkdir -p "$LOCAL"
REMOTE="~/careerops-finetune/$OUT/$OUT/"
for attempt in $(seq 1 40); do
  if rsync -az --partial --append-verify --timeout=60 -e "ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=3" \
       "$HOST:$REMOTE" "$LOCAL/" --include='*.gguf' --include='Modelfile' --exclude='*'; then
    echo "fetched after $attempt attempt(s)"; break
  fi
  echo "rsync attempt $attempt failed — retrying in 15s ($(du -sh "$LOCAL" 2>/dev/null | cut -f1) so far)"; sleep 15
  [ "$attempt" = 40 ] && { echo "giving up"; exit 1; }
done
GGUF=$(ls "$LOCAL"/*.gguf 2>/dev/null | head -1); [ -n "$GGUF" ] || { echo "no gguf"; exit 1; }
printf 'FROM ./%s\nPARAMETER temperature 0.2\nPARAMETER num_ctx 8192\nPARAMETER repeat_penalty 1.15\n' "$(basename "$GGUF")" > "$LOCAL/Modelfile"
cd "$LOCAL" && ollama create "$TAG" -f Modelfile && echo "ollama: $TAG ready ($(du -h "$GGUF" | cut -f1))"
