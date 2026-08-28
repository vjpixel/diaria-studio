---
name: reclassificacao-develop
description: Regra dura de reclassificação para develop-track de issue com bloqueio humano (23/08).
---

# Diária Contínuo — Pipeline de Reclassificação (referência)

Captura a regra dura definida pelo editor em 23/08: quando uma issue bloqueada
por humano precisa ser reclassificada para `develop`.

## Regra

- Se a issue tem bloqueio humano (decisão pendente, revisão de conteúdo, ação
  do editor) → aplicar a label **`develop-track`**, que **EXISTE no repo e
  mapeia direto pro track `develop`** (`DEVELOP_HUMAN_BLOCK_LABEL` em
  `scripts/lib/issue-exec-track.ts`, do próprio #5948).
- **Correção 28/08 (review do PR #6446):** a versão anterior deste arquivo
  afirmava que `develop-track` não existia e mandava usar `bloqueio-execucao`
  como equivalente — errado, e pior que errado: `bloqueio-execucao` classifica
  como `bloqueada` (nenhuma sessão pega), enquanto o caso descrito aqui é
  `develop` (o editor destrava ao vivo). Seguir a instrução antiga escondia a
  issue do develop.
- `bloqueio-execucao` continua válido pro que ele é: bloqueio DURO que nenhuma
  sessão destrava (classifica `bloqueada`) — não pra "precisa do editor".

## Exemplo aplicado na sessão 23/08

- Issue #5877: aguardava decisão de reunião (24/08); label `bloqueio-execucao`
  aplicada + comentário com a regra registrada.

## Verificação

`gh label list --limit 20 --json name --jq '.[] | select(.name=="bloqueio-execucao")'`
