#!/usr/bin/env bash
# #9527 — abre /diaria-overnight numa sessão já em claude-opus-5-5/low (a sonda da
# Fase 0 passa de primeira). Flags valem só pra esta sessão: não persistem em
# ~/.claude/settings.json (ao contrário de `/model`/`/effort` digitados).
exec claude --model claude-opus-5-5 --effort low "/diaria-overnight $*"
