---
name: diaria-edicao
description: Roda a pipeline completa da Diar.ia (4 etapas). Uso — `/diaria-edicao AAMMDD [--no-gates]`.
---

# /diaria-edicao

Executa a pipeline completa da Diar.ia (4 etapas com gate humano em cada uma).

## Argumentos

- `$1` = data da edição no formato `AAMMDD` (ex: `260418`). **Se não passar, perguntar explicitamente** — nunca inferir a partir de `today()`. Sugerir amanhã como atalho principal (regra D+1 — edição é sempre o dia seguinte à pesquisa), com hoje como secundário, mas exigir confirmação:
  > "Você não passou a data da edição. Qual edição você quer processar? amanhã ({AAMMDD_amanha}) / hoje ({AAMMDD_hoje}) / outra (informe AAMMDD)"
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

1. **Janela = 4 dias corridos terminando em D+0** (#315).
   Stage 1 roda em D+0 (dia antes da publicação). Endpoint superior = D+0 = `$ISO − 1 dia`.
   ```bash
   node -e "const d=new Date('$ISO');d.setUTCDate(d.getUTCDate()-1);process.stdout.write(d.toISOString().slice(0,10))"
   ```
   Armazenar como `WINDOW_END`. `window_days = 4` fixo.
   ```bash
   node -e "const d=new Date('$WINDOW_END');d.setUTCDate(d.getUTCDate()-3);process.stdout.write(d.toISOString().slice(0,10))"
   ```
   Armazenar como `window_start`.

**Se `--no-gates`:** usar os valores calculados sem perguntar. Pular para o Passo 2.

**Caso contrário:** exibir ao usuário e aguardar resposta:

   ```
   Janela de publicacao aceita: {window_start} -> {WINDOW_END} (4 dias)
   Digite ok para confirmar ou outro numero de dias:
   ```

   Interpretar a resposta:
   - Vazia / "Enter" / "ok" / "sim" / "confirmar" → manter o default.
   - Número inteiro N ≥ 1 → `window_days = N`, recalcular `window_start` a partir de `WINDOW_END`.
   - Qualquer outra coisa → repetir a pergunta.

## Passo 2 — Executar o playbook diretamente no top-level (#207)

**Você (top-level Claude Code) lê `.claude/agents/orchestrator.md` e executa o playbook stage-a-stage diretamente.** **Não delegue a um subagente `orchestrator` via `Agent`** — o runtime bloqueia recursão de Agent dentro de subagentes (issue #207). O top-level tem `Agent` disponível e pode dispatchar `source-researcher`, `discovery-searcher`, `eia-composer`, `research-reviewer`, `scorer`, `writer`, `title-picker`, `social-linkedin`, `social-facebook`, `publish-newsletter`, `publish-social`, `auto-reporter` em paralelo conforme cada stage prescreve.

Variáveis pra alimentar o playbook (passar mentalmente como contexto, não como prompt de Agent):
- `edition_date = $1` (AAMMDD)
- `edition_iso = 20${AAMMDD.slice(0,2)}-${AAMMDD.slice(2,4)}-${AAMMDD.slice(4,6)}`
- `window_days = {valor confirmado no Passo 1}`
- `auto_approve = true` se `--no-gates` foi passado, senão `false`
- `test_mode = false` (use `/diaria-test` se quiser test_mode)

Sequência de etapas (do playbook em `.claude/agents/orchestrator.md`):
- **§ 0 Setup** — resume detection, Drive sync flag, Chrome MCP probe, refresh `past-editions.md`, inbox drain, log de início
- **§ 1 Etapa 1 — Pesquisa** (É IA? dispatcha em background) → GATE humano
- **§ 2 Etapa 2 — Escrita** (newsletter + social em paralelo) → GATE humano unificado
- **§ 3 Etapa 3 — Imagens** (É IA? gate + imagens de destaque) → GATE humano unificado
- **§ 4 Etapa 4 — Publicação** (newsletter Beehiiv + Facebook Graph + LinkedIn Chrome em paralelo) → GATE único + auto-reporter → fim

**Se `--no-gates` (`auto_approve = true`):** auto-aprovar todos os gates conforme Princípio 2 do playbook (`test_mode` ou `auto_approve` pulam gates). Drive sync e social scheduling ficam normais (diferente de `test_mode`).

**Caso contrário:** em cada gate, apresente o output do stage e peça aprovação (`sim` / `editar` / `retry`). Resume-aware: ao retomar, listar arquivos em `data/editions/{AAMMDD}/` e pular para o stage adequado conforme as condições do § 0 Setup.

## Outputs

Todos em `data/editions/{AAMMDD}/` (ex: `260418/`):
- `01-categorized.md`, `01-eia.md`, `01-eia-A.jpg`, `01-eia-B.jpg` (edições antigas pré-#192: `01-eia-real.jpg`/`01-eia-ia.jpg`)
- `02-reviewed.md`
- `03-social.md`
- `04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg`, `04-d3-1x1.jpg`
- `05-published.json`
- `06-social-published.json`
- `_internal/` — JSON intermediários, drafts, diffs, prompts
