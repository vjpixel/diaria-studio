# Invariantes do projeto Diar.ia

_Gerado automaticamente por `scripts/regen-invariants.ts` a partir de issues GitHub com label `convention`. Não editar diretamente — alterações são sobrescritas no próximo run._

Última atualização: 2026-05-08T04:01:49.886Z
Fonte: 13 issue(s) com label `convention`.

## Drive sync

- (#495) **Ao aplicar transformações de formatação em arquivos editáveis pelo editor, fazer substituições cirúrgicas — uma linha por vez — que toquem apenas o padrão a transformar, sem incluir linhas adjacentes que o editor pode ter alterado.**
- (#494) **Antes de qualquer `Edit` ou `Write` em arquivo que existe no Drive, sempre fazer pull primeiro.**

## Publicação

- (#573) guard: filter future-dated Beehiiv posts antes de tratar como published (#572 follow-up)
- (#336) Stage 5 publish: SEMPRE perguntar editor antes de disparar (manual vs automático)

## Lint / Validação

- (#966) scripts/check-invariants.ts — pre-flight executável de invariantes editoriais

## Processo / PRs

- (#968) label "convention" + template de issue para decisões que viram regra
- (#636) política de 1 PR aberto por vez para evitar conflitos de rebase
- (#633) sprint de estabilização — freeze de features + testes de regressão obrigatórios

## Editorial

- (#962) ux: categorized/reviewed devem dizer só qual imagem é IA (não qual é real)
- (#160) Seção 'Lançamentos' deve ter apenas links de site oficial da empresa lançadora

## Pipeline / MCP

- (#738) MCP disconnect: fail-fast + recovery automática em vez de stall silencioso
- (#583) skills /diaria-N-*: assumir edição em curso quando há só uma, sem perguntar

## Outros

- (#959) link-verify-bodies/ acumula 12+ MB de HTML em _internal/, infla contexto da Stage 2
