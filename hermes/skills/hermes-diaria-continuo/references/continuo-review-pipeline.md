---
name: continuo-review-pipeline-pattern
description: Pipeline obrigatório para PRs desta skill: fila de PRs abertos > nova issue; review independente (delegate_task: scan estático + reviewer independente + auto-fix ≤2 ciclos) antes de merge; guard sensível (`scripts/lib/sensitive-path-guard.ts`) obrigatoriamente verificado antes de abrir PR e antes de mergear.
version: 1.0
license: MIT
author: Pixel, Hermes Agent
---

# Pipeline de review independente — ciclo contínuo

Confirmado no ciclo 26/08/2026 (`hermes-diaria-continuo`, `glm-5.2/custom endpoint`): o cron `5d791ef6fc2c` está ativo (`every 30m`, `continuity:true`); PR #6396 (`fix #6393 — overnight effort threshold`) estava aberta sem nenhum `latestReviews`; a fila `overnight` (6 issues) não foi tocada até que a fila de PR fosse processada.

## Regras duras (codificadas no SKILL.md §3 — não são sugestões)

1. **Fila de PRs abertos tem PRIORIDADE sobre nova issue.** Antes de qualquer `claim-issue`: `gh pr list --author @me --state open` → processar todos os PRs abertos (review independente → merge).
2. **Review independente obrigatório (`requesting-code-review`).** Nenhum subagente faz merge sozinho. Passos: (1) scan estático (`security_concerns`, `logic_errors`); (2) baseline de testes/lint; (3) reviewer independente (`delegate_task` com só o diff + scan — zero contexto compartilhado); (4) auto-fix loop (≤2 ciclos, terceiro agente corrige só os problemas apontados); (5) só então mergear.
3. **Fail-closed no review:** veredito não-parseável = `fail`; `security_concerns` ou `logic_errors` não-vazios = `fail`; sugestões são non-blocking. Só docs-only sem executável pode pular o passo 3 (nunca 1–2).
4. **Guard de caminho sensível (`scripts/lib/sensitive-path-guard.ts`) — obrigatório.** Executar antes de abrir PR e antes de mergear: `npx tsx scripts/lib/sensitive-path-guard.ts --base origin/master --json`. Se `"sensitive": true` → NÃO MERGEAR. Deixar PR aberta, comentar nela com `gh pr comment`, encaminhar. Se `exit ≠ 0`, sem stdout ou JSON não-parseável → tratar como SENSÍVEL. Sem exceção.
5. **Review independente dispara em PARALELO com a abertura do PR.** `delegate_task` imediatamente após `gh pr create`. Enquanto roda, o coordenador pode continuar — mas NÃO abrir PR nova enquanto houver veredito anterior não consumido. Merge acontece no MESMO tick do veredito, nunca adiado.

## Quando NÃO é esta skill que governa

- PR que NÃO toca código executável deste repo (ex.: docs-only de outra skill, arquivo `.env.example` puro, config do editor) não precisa deste pipeline — mas ainda passa por `sensitive-path-guard` se toca `scripts/lib/site-archive*.ts`, `scripts/publish-*`, `stitch-newsletter.ts`, etc.
- PR de outro autor (`gh pr list` sem `--author @me`) não é responsabilidade deste pipeline — só observar se há colisão (`claimed_issues` no `session-registry`).
- Se o `overnight` ativo reivindicou uma issue (`claimed_issues`), o contínuo apenas pula essa issue — não interrompe todo o ciclo. A fila `overnight` continua elegível para as não-reivindicadas.

## Fonte única

O `SKILL.md` desta skill (versão v0.4.2+) é a fonte autoritativa. Este arquivo só condensa o padrão para referência rápida em ciclos futuros — nunca substitui o SKILL.md.
