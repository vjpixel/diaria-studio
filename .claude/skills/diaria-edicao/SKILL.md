---
name: diaria-edicao
description: Roda a pipeline completa da Diar.ia (stages 1–7). Uso — `/diaria-edicao AAMMDD [--no-gates]`.
---

# /diaria-edicao

Invoca o orchestrator para produzir uma nova edição da Diar.ia.

## Argumentos

- `$1` = data da edição no formato `AAMMDD` (ex: `260418`). **Se não passar, perguntar explicitamente** — nunca inferir a partir de `today()`. Sugerir hoje/ontem como atalhos mas exigir confirmação:
  > "Você não passou a data da edição. Qual edição você quer processar? hoje ({AAMMDD_hoje}) / ontem ({AAMMDD_ontem}) / outra (informe AAMMDD)"
- `--no-gates` (opcional) = pular todos os gates humanos, auto-aprovando cada stage. Drive sync, social scheduling e demais comportamentos permanecem normais (diferente de `/diaria-test` que também desabilita Drive e agenda social 10 dias à frente).

## Pré-requisitos

Antes de iniciar, verifique:
1. `context/audience-profile.md` existe e não é placeholder. Se for, avise: rode `/diaria-atualiza-audiencia` primeiro (muda lento, rodar semanalmente/mensalmente).
2. `context/sources.md` existe. Se não, rode `npm run sync-sources`.
3. `context/past-editions.md` **não precisa estar atualizado** — o orchestrator regenera automaticamente via Beehiiv MCP no Stage 0.

## Passo 1 — Confirmar janela de publicação aceita

Converter `$1` (AAMMDD) para ISO date interno:
```bash
node -e "const s='$1';process.stdout.write('20'+s.slice(0,2)+'-'+s.slice(2,4)+'-'+s.slice(4,6))"
```
Armazenar o resultado como `$ISO` (ex: `260423` → `2026-04-23`). Usar `$ISO` em todo Date math abaixo.

1. Calcular o default de `window_days` com base no dia da semana da edição:
   ```bash
   node -e "const d=new Date('$ISO');const day=d.getUTCDay();process.stdout.write(String(day===1||day===2?4:3))"
   ```
   - Segunda (`getUTCDay()===1`) ou terça (`getUTCDay()===2`): `window_days = 4` (cobre o fim de semana).
   - Quarta a sexta: `window_days = 3`.
2. Calcular `window_start = $ISO − window_days dias`:
   ```bash
   node -e "const d=new Date('$ISO');d.setUTCDate(d.getUTCDate()-{window_days});process.stdout.write(d.toISOString().slice(0,10))"
   ```

**Se `--no-gates`:** usar o default calculado sem perguntar. Pular para o Passo 2.

**Caso contrário:** exibir ao usuário e aguardar resposta:

   ```
   Janela de publicacao aceita: {window_start} -> $1 ({window_days} dias)
   Pressione Enter para confirmar ou digite outro numero de dias:
   ```

   Interpretar a resposta:
   - Vazia / "Enter" / "ok" / "sim" / "confirmar" → manter o default.
   - Número inteiro N ≥ 1 → `window_days = N`, recalcular `window_start`.
   - Qualquer outra coisa → repetir a pergunta.

## Passo 2 — Disparar o orchestrator com `window_days` confirmado

Dispare o subagente `orchestrator` via `Agent` passando no prompt:
- `edition_date = $1` (AAMMDD)
- `window_days = {valor confirmado no Passo 1}`
- `auto_approve = true` (se `--no-gates` foi passado)

O orchestrator vai:
- Stage 0 (refresh automático de `past-editions.md`, inbox drain) — sem gate
- Stage 1 (research + dedup + categorize + score) → GATE humano
- É IA? (POTD + texto, em paralelo com Stage 1) → GATE humano
- Stage 2 (writer + Clarice) → GATE humano
- Stage 3 (2 social writers + Clarice) → GATE humano
- Stage 4 (3 imagens via Gemini/ComfyUI) → GATE humano
- Stage 5 (publicar newsletter no Beehiiv — rascunho + teste) → GATE humano
- Stage 6 (publicar social — LinkedIn × 3 + Facebook × 3) → fim

**Se `--no-gates`:** o orchestrator auto-aprova todos os gates (mesma lógica de `test_mode` mas sem desabilitar Drive sync nem alterar social scheduling). Não relayar gates ao usuário.

**Caso contrário:** em cada gate, apresente ao usuário o output do stage e peça aprovação (`sim` / `editar` / `retry`). Se o orchestrator retornar uma pergunta ao usuário, relaye a pergunta e depois re-dispare o orchestrator com a resposta (ele é resume-aware).

## Outputs

Todos em `data/editions/{AAMMDD}/` (ex: `260418/`):
- `01-categorized.md`, `01-eai.md`, `01-eai-A.jpg`, `01-eai-B.jpg` (edições antigas pré-#192: `01-eai-real.jpg`/`01-eai-ia.jpg`)
- `02-reviewed.md`
- `03-social.md`
- `04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2.jpg`, `04-d3.jpg`
- `05-published.json`
- `06-social-published.json`
- `_internal/` — JSON intermediários, drafts, diffs, prompts
