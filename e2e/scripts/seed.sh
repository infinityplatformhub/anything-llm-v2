#!/usr/bin/env bash
set -euo pipefail

cd /Users/jintawattuitemwong/Documents/GitHub/anything-llm-v2/.claude/worktrees/workspace-agents-p1
PATH=/opt/homebrew/opt/node@22/bin:$PATH node e2e/scripts/seed.js
