---
name: reclassificacao-develop
description: Regra dura de reclassificação para develop-track de issue com bloqueio humano (23/08).
---

# Diária Contínuo — Pipeline de Reclassificação (referência)

Captura a regra dura definida pelo editor em 23/08: quando uma issue bloqueada
por humano precisa ser reclassificada para `develop`.

## Regra

- Se a issue tem bloqueio humano (decisão pendente, revisão de conteúdo, ação
  do editor) → adicionar a label `bloqueio-execucao` (existe no repo) e
  registrar no corpo que a issue é `develop-track`.
- A label `develop-track` NÃO existe no repo; usar `bloqueio-execucao` +
  comentário documentando o bloqueio como mecanismo equivalente.
- Isso remove a issue do runtime do continuo (o classificador lê
  `bloqueio-execucao` como `bloqueada`).

## Exemplo aplicado na sessão 23/08

- Issue #5877: aguardava decisão de reunião (24/08); label `bloqueio-execucao`
  aplicada + comentário com a regra registrada.

## Verificação

`gh label list --limit 20 --json name --jq '.[] | select(.name=="bloqueio-execucao")'`
