#!/usr/bin/env bash
# #9527/#9530 — abre /diaria-overnight numa sessão já em claude-sonnet-5-5/medium
# (a sonda da Fase 0 passa de primeira). Flags valem só pra esta sessão: não
# persistem em ~/.claude/settings.json (ao contrário de `/model`/`/effort` digitados).
#
# `env -u` remove as vars de CLAUDE_CLI_STRIPPED_ENV_VARS
# (scripts/overnight/run-scheduled-edicao.ts, regra #5608/#6714): sessão de
# Claude Code nunca autentica pela API nem por gateway de terceiro. A lista é
# espelhada aqui (bash não importa TS) e travada por
# test/overnight-start-sh-strips-auth-env-9527.test.ts.
exec env \
  -u ANTHROPIC_API_KEY \
  -u ANTHROPIC_AUTH_TOKEN \
  -u ANTHROPIC_BASE_URL \
  -u CLAUDE_CODE_USE_BEDROCK \
  -u CLAUDE_CODE_USE_VERTEX \
  -u CLAUDE_CODE_SESSION_ID \
  -u CLAUDE_CODE_CHILD_SESSION \
  -u CLAUDECODE \
  claude --model claude-sonnet-5-5 --effort medium "/diaria-overnight $*"
