---
name: diaria-edicao
description: Roda a pipeline completa da Diar.ia (stages 1–7), pausando em cada gate humano. Uso: `/diaria-edicao YYYY-MM-DD`.
---

# /diaria-edicao

Invoca o orchestrator para produzir uma nova edição da Diar.ia.

## Argumentos

- `$1` = data da edição no formato `YYYY-MM-DD` (ex: `2026-04-18`).

Se `$1` não for passado, peça ao usuário.

## Pré-requisitos

Antes de iniciar, verifique:
1. `context/audience-profile.md` existe e não é placeholder. Se for, avise: rode `/diaria-atualiza-audiencia` primeiro (muda lento, rodar semanalmente/mensalmente).
2. `context/sources.md` existe. Se não, rode `npm run sync-sources`.
3. `context/past-editions.md` **não precisa estar atualizado** — o orchestrator regenera automaticamente via Beehiiv MCP no Stage 0.

## Passo 1 — Confirmar janela de publicação aceita (sempre, antes do orchestrator)

**Este é o primeiro output visível ao usuário.** Execute **neste loop principal** (não delegue para o orchestrator — subagentes não conseguem pausar pra input).

1. Calcular o default de `window_days` com base no dia da semana da edição:
   ```bash
   node -e "const d=new Date('$1');const day=d.getUTCDay();process.stdout.write(String(day===1||day===2?4:3))"
   ```
   - Segunda (`getUTCDay()===1`) ou terça (`getUTCDay()===2`): `window_days = 4` (cobre o fim de semana).
   - Quarta a sexta: `window_days = 3`.
2. Calcular `window_start = $1 − window_days dias`:
   ```bash
   node -e "const d=new Date('$1');d.setUTCDate(d.getUTCDate()-{window_days});process.stdout.write(d.toISOString().slice(0,10))"
   ```
3. Exibir **exatamente** esta mensagem ao usuário e **aguardar resposta** (é uma pergunta, não continue antes):

   ```
   📅 Janela de publicação aceita: {window_start} → $1 ({window_days} dias)
   Pressione Enter para confirmar ou digite outro número de dias:
   ```

4. Interpretar a resposta:
   - Vazia / "Enter" / "ok" / "sim" / "confirmar" → manter o default.
   - Número inteiro N ≥ 1 → `window_days = N`, recalcular `window_start`.
   - Qualquer outra coisa → repetir a pergunta.

## Passo 2 — Disparar o orchestrator com `window_days` confirmado

Dispare o subagente `orchestrator` via `Task` passando no prompt:
- `edition_date = $1`
- `window_days = {valor confirmado no Passo 1}`

O orchestrator vai:
- Stage 0 (refresh automático de `past-editions.md`, inbox drain) — sem gate
- Stage 1 (research + dedup + categorize + score) → GATE humano
- Stage 2 (writer + Clarice) → GATE humano
- Stage 3 (2 social writers + Clarice) → GATE humano
- Stage 4 (É AI? — POTD + texto) → GATE humano
- Stage 5 (3 imagens via Gemini/ComfyUI) → GATE humano
- Stage 6 (publicar newsletter no Beehiiv — rascunho + teste) → GATE humano
- Stage 7 (publicar social — LinkedIn × 3 + Facebook × 3) → fim

Em cada gate, apresente ao usuário o output do stage e peça aprovação (`sim` / `editar` / `retry`). Se o orchestrator retornar uma pergunta ao usuário, relaye a pergunta e depois re-dispare o orchestrator com a resposta (ele é resume-aware).

## Outputs

Todos em `data/editions/{YYMMDD}/` (formato `YYMMDD` = AAMMDD; ex: `2026-04-18` → `260418/`):
- `01-categorized.json`, `01-approved.json`
- `02-draft.md`, `02-clarice-diff.md`, `02-reviewed.md`
- `03-linkedin-d{1..3}.md`, `03-facebook-d{1..3}.md`, `03-social.md`
- `04-eai.md`, `04-eai.jpg`
- `05-d1-2x1.jpg`, `05-d1-1x1.jpg`, `05-d2.jpg`, `05-d3.jpg`
- `06-published.json`
- `07-social-published.json`
