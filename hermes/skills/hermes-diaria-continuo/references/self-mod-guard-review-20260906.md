---
name: self-mod-guard-review
description: Por que o guard de auto-modificação (#6817 item 4) é fail-closed por requisito e não preferência — o review da PR #6854 que achou a versão inicial inexecutável, e o achado #6059/#6060 que motivou a regra.
platforms: [linux]
metadata:
  hermes:
    tags: [continuo, self-modification, guard, review]
---

## Review da PR #6854 (P2, confiança alta)

A versão inicial do guard de auto-modificação só documentava a função pura
(`isSelfModification`, `scripts/lib/continuo-workdir-allowlist.ts`) sem NENHUM
comando que a chamasse — a delegação só sabe rodar `npx tsx scripts/...`,
nunca importar TS direto, então a instrução original era inexecutável na
prática. Corrigido para expor o comando (`check-continuo-workdir.ts
--check-self-mod`) que a delegação de fato consegue rodar.

## Achado #6059/#6060

O contínuo deletou a própria infra no meio do próprio loop, quebrando-o;
revertido no #6060. Fail-closed é requisito aqui, não preferência — o
contínuo rodando DENTRO do que ele modifica é a receita de um estado que
ninguém desfaz sozinho: se o guard falhasse aberto, um tick que decidisse
apagar seu próprio mecanismo de proteção (SKILL.md, wrapper, job do cron)
não teria mais chance de ser interrompido por nada dentro do próprio loop.
