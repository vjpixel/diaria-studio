---
name: ci-fixer-rationale
description: Por que o tick do contínuo prioriza consertar CI vermelho de PR continuo/* antes de reivindicar issue nova (#7446 item 3), e por que o label de tentativa é aplicado ANTES do conserto e não depois (review da PR #7450).
platforms: [linux]
metadata:
  hermes:
    tags: [continuo, ci, pr-queue, livelock]
---

## O incidente (04-05/09/2026)

Medido ao vivo: PR #7429 e #7432 com CI em FAILURE há 17h e 15h, sem ninguém
tentar consertar. A causa é estrutural, não descuido: o tick que abre a PR
morre (budget/crash/fim do ciclo) antes do CI terminar, e o tick seguinte
reivindica outra issue sem nunca voltar à anterior. A PR fica vermelha
indefinidamente enquanto o contínuo segue produzindo PRs novas.

Isto **NÃO** reintroduz "PR pendente bloqueia o tick". O #6917 ("PR aberta
NUNCA encerra o tick") segue valendo, e trata de coisa diferente: PR
aguardando REVIEW é estado normal, esperado, que não exige ação de ninguém.
CI **vermelho** é estado quebrado que ninguém mais conserta sozinho. O §3b
muda a PRIORIDADE do que o tick faz primeiro — nunca se ele roda.

## Por que marcar o label ANTES de consertar (review da PR #7450)

`mark-continuo-ci-fix-attempted.ts --pr N` roda **antes** de tocar em
qualquer código, não depois do conserto.

Marcar só DEPOIS deixaria uma janela de corrida do tamanho do conserto
inteiro — dois ticks concorrentes escolheriam a MESMA PR e gastariam o
orçamento duas vezes no mesmo trabalho. Marcar antes reduz a janela ao
intervalo entre "escolher" e "marcar", que é uma chamada de `gh`.

O custo aceito é o oposto: se o conserto falhar depois do label aplicado, a
PR não é retentada mecanicamente. Isso é deliberado — é o cap de 1 tentativa
por PR (`selectCiFixCandidate`, `scripts/lib/continuo-ci-fixer-eligibility.ts`).
A PR não fica invisível: segue coberta pelo `escalate` do gate de merge
(#7446 item 2, label `continuo-escalado`) e pela checagem 9 de
`watch-continuo-health.sh` (#7446 item 6, alarme de fila).
