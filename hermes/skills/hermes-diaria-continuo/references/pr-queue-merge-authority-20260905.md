---
name: pr-queue-merge-authority
description: Por que o tick processa a fila de PRs sem nunca mergear (#6864), por que "PR aberta" não encerra o tick (#6917), e a cadeia de quem de fato mergeia (pickup #6823, continuo-pr-review.sh #6926).
platforms: [linux]
metadata:
  hermes:
    tags: [continuo, pr-queue, merge, review-authenticity, pickup]
---

## §3 passo 3 — por que este tick NUNCA mergeia (#6864, 31/08/2026)

Decisão do editor, decorrente do #6849: o gate de autenticidade
(`check-pr-review-authenticity.ts`) é honor-system por CONSTRUÇÃO —
avaliador (esta delegação) e avaliado (a PR que ela mesma abriu) são o
MESMO processo, com a MESMA credencial `gh`, escrevendo no MESMO lugar. O
regex de prosa original (`INDEPENDENT_REVIEW_RE`, removido no #6849 — ver
"Marcador com nonce" em `references/changelog.md`, entrada v0.5.10) já
aprovou o texto fabricado exato do incidente #6713 uma vez, e o #6849 achou
que o revisor externo LEGÍTIMO (`continuo-pr-review.sh`) produzia a MESMA
prosa — endurecer a regex nunca teria fechado isso, era um discriminador
impossível por texto. O marcador com identidade de execução que o #6849
introduziu reduz o caso de fabricação POR ACIDENTE, mas não muda a
conclusão: avaliador e avaliado seguem sendo o MESMO processo com a MESMA
credencial `gh`. A investigação do #6849 esgotou a busca por sinal fora do
texto (autor — `["vjpixel"]` é o único ator que já comentou neste repo, sem
bot/App; `kind` do session-registry; `gh pr comment` × `gh pr review`;
telemetria de dispatch) e não achou nenhum. Remover a capacidade de merge é
mais forte que confiar no texto ou proteger um segredo de bot — este repo já
tem 3 incidentes documentados de credencial vazando pro processo errado
(#5608, #6714, #6718) pra desconfiar de "revisor com token próprio" como
solução.

Rodar `npx tsx scripts/check-pr-review-authenticity.ts --pr N` mesmo assim —
o resultado (`pass`/`self_review`/`no_review`/`error`) vira ROTULO
informativo no relatório do tick, não autorização de ação. Em TODOS os
casos, inclusive `exit 0`/`pass`: NÃO mergear — o trade-off é aceito de
propósito (ver "Custo aceito" na issue #6864), não reintroduzir merge aqui
por otimização de latência.

## "PR aberta NUNCA encerra o tick" (#6917, 01/09/2026)

Depois de rotular a PR, siga para a próxima issue/PR da fila e trabalhe
normalmente. "Há PR aguardando review externo" descreve o estado DAQUELA
PR, não uma condição de parada do tick — não existe regra que limite o
contínuo a uma PR por vez. Achado ao vivo: um tick com 36 issues
`track=overnight` elegíveis na fila terminou sem reivindicar nenhuma,
justificando com "conforme a regra de prioridade da fila" — essa regra
nunca existiu neste arquivo. O tick preencheu um vazio de instrução com uma
regra plausível; nomear e negar explicitamente a leitura errada aqui fecha
esse vazio.

## Quem de fato mergeia — pickup (#6823) e continuo-pr-review.sh (#6926)

**Pickup existe desde o #6823 (31/08/2026) — só no `/diaria-overnight`.** O
fleet review do #6820 (30/08/2026) tinha achado que nenhuma das duas skills
adotava PR órfão marcado self-review; o #6823 fechou essa lacuna no
`/diaria-overnight` (passo 2b da Fase 0): lista PRs `continuo/*` com
`check-pr-review-authenticity.ts` → `exit 1` (self_review) **ou** `exit 2`
(no_review — tick morreu antes de sequer comentar; caso da PR que motivou a
issue, #6844), roda guard de caminho sensível + review independente de
verdade via Agent tool + gate de CI genuína, mergeia se limpo.
`/diaria-develop` deliberadamente NÃO ganhou esse passo — pickup de PR
órfão do contínuo não exige presença do editor nem a máquina Windows, então
é trabalho que cabe ao `/diaria-overnight` (server, desassistido), não a
uma sessão interativa (#5751). Na prática, um PR self-reviewed do contínuo
fica aberto até a próxima rodada `/diaria-overnight` rodar a Fase 0, OU até
o próximo tick do cron próprio de `continuo-pr-review.sh` (cadência:
derivar com `hermes cron list --all`, #6928) revisar e mergear sozinho.
`opus-daily-diff-review.sh` (ex-`daily-consolidated-review.sh`) continua só
gerando achados/comentários, nunca mergeando.

**`continuo-pr-review.sh` ganhou autoridade de merge própria desde o #6926
(01/09/2026) — o pickup acima deixou de ser o único ponto de merge, virou
FALLBACK.** Motivo: o pickup só roda quando o editor inicia uma rodada
`/diaria-overnight` manualmente (sem agendador) — uma PR pronta (review
independente + CI verde) podia ficar parada indefinidamente (medido ao
vivo: PR #6901, 10h29 parada). `continuo-pr-review.sh` continua NUNCA dando
a ferramenta `gh pr merge` ao MODELO da sessão de review (`--allowedTools`
travado, `test/continuo-pr-review-never-merges.test.ts`) — quem mergeia é o
SCRIPT BASH, depois que a sessão já saiu, atrás dos portões fail-closed em
`scripts/check-continuo-merge-gate.ts` (superseded, veredito
`approve`/`reject` gravado no marcador de review, HEAD não mudou desde o
início da revisão — corrida do #5716, caminho não-sensível, CI verde +
mergeable, diff dentro do limiar de effort de `pr-create-review.mjs`). Dois
casos ainda escalam pro pickup (fallback, não mais caminho único): caminho
sensível, e diff ≥ limiar.
