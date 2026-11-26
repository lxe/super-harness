#!/usr/bin/env bash
# Safely syncs latest desktop reference files (src/, ARCHITECTURE.md, tests/, etc.)
# from the Linux workstation into ~/Developer/super-harness WITHOUT touching ios/ or .git/.
set -euo pipefail

LINUX_HOST="${1:-192.168.1.10}"
LINUX_REPO="${2:-/home/lxe/.gemini/antigravity/scratch/super-harness}"
MAC_REPO="${3:-$HOME/Developer/super-harness}"

rsync -avz --delete \
  --exclude=".git/" \
  --exclude="node_modules/" \
  --exclude="dist/" \
  --exclude="ios/" \
  --exclude="storybook-static/" \
  "${LINUX_HOST}:${LINUX_REPO}/" \
  "${MAC_REPO}/"
