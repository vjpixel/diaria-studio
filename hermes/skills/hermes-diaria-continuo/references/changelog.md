---
name: hermes-diaria-continuo-changelog
description: Changelog completo (histórico versão a versão) do hermes-diaria-continuo — narrativa de incidentes, decisões e rationale por release. Extraído do SKILL.md (#6712 Parte B) para manter o arquivo operacional dentro do teto de tamanho.
platforms: [linux]
metadata:
  hermes:
    tags: [continuo, changelog, historico]
---

Histórico completo de versões desta skill, movido do SKILL.md em 02/09/2026
(#6712 Parte B — teto de tamanho do SKILL.md). O SKILL.md mantém só a versão
corrente no frontmatter (`version:`) e o comportamento ATUAL/operacional;
este arquivo é o "porquê" de cada mudança — para quem investiga uma decisão
passada, não para quem está rodando um tick.

- 0.5.15 (04/09/2026): #6817 residual — as 2 raízes novas da allowlist
  (`hermes-agent`, `dot-hermes`) ativadas (`enabled: true`, decisão do
  editor 04/09: "implementar como especificado. Sem redução de escopo"),
  guards no lugar antes da ativação: item 2 (`scripts/read-hermes-session-
  status.ts`, leitor allowlist-de-saída de `sessions.json` — decisão do
  editor 03/09, distinta de blacklist-de-segredo por design, não só por
  cobertura), item 3 (`scripts/write-hermes-config.ts`, verbo único de
  escrita de config com backup/validate/smoke/revert e eco redigido pro
  fork), item 5 (`scripts/lib/hermes-runtime-sensitive-paths.ts`, irmão de
  `sensitive-path-guard.ts` — não entrou lá porque o hygiene test de lá
  exige regra casando com arquivo RASTREADO deste repo, e paths de
  `~/.hermes` nascem mortos por esse critério). Item 6 (PR autônoma no fork
  `vjpixel/hermes`) confirmado JÁ coberto mecanicamente: `continuo-pr-
  review.sh` tem `REPO=/home/vjpixel/diaria-studio` fixo, nunca mergeia PR
  de outro repo — decisão do editor (03/09: abrir SIM, auto-merge NÃO) só
  precisou de documentação, não de código novo. Item 7 (2 trackers) segue
  residual — exige decisão de design (ordem de prioridade entre filas) que
  a issue não especifica.
- 0.5.14 (01/09/2026): #6928 — cadências dos 2 crons do contínuo estavam
  erradas em prosa, ambas registrando o dobro do valor real, e o
  descompasso/espera máxima que o #6865 citava era derivado desses números
  errados (os valores de agora não são re-registrados aqui de propósito:
  deriva com `hermes cron list --all`). Todas as menções numéricas de cadência
  saíram da prosa deste arquivo, do `hermes/README.md` e dos 2 scripts de
  review — substituídas pelo ponteiro de derivação. Guard:
  `test/continuo-cadence-prose-drift-6928.test.ts` falha se os tokens
  obsoletos voltarem.
- 0.5.13 (01/09/2026): #6926 — `continuo-pr-review.sh` ganha autoridade de
  merge própria; o pickup do `/diaria-overnight` (§3 acima, #6823) deixa
  de ser o único ponto de merge, vira FALLBACK (caminho sensível, diff ≥
  limiar). Motivo: pickup só roda quando o editor inicia rodada manual —
  PR pronta podia ficar parada indefinidamente (PR #6901, 10h29). O
  MODELO da sessão de review continua sem `gh pr merge` (`--allowedTools`
  intocado, #6864/#6865 seguem valendo) — quem mergeia é o script bash,
  atrás de 5 portões fail-closed (`scripts/check-continuo-merge-gate.ts`):
  superseded, veredito `approve`/`reject` no marcador de review, HEAD
  inalterado desde o início da revisão (corrida do #5716), caminho
  não-sensível, CI verde + mergeable, diff dentro do limiar de effort de
  `pr-create-review.mjs`. Corrige junto (#6928): a cadência que entradas
  anteriores deste changelog registravam pro job estava errada (metade do
  valor real) — não citar número de cadência em prosa; derivar com
  `hermes cron list --all` (CLAUDE.md).
- 0.5.12 (01/09/2026): #6917 — "PR aberta NUNCA encerra o tick" ganha
  estatuto de afirmação própria, em negrito, separada do bloco de
  proibição de merge (§3). Achado ao vivo: um tick com 36 issues
  `track=overnight` elegíveis terminou sem reivindicar nenhuma,
  justificando com "regra de prioridade da fila" que nunca existiu neste
  arquivo — a instrução real ("passar para a próxima issue/PR da fila")
  era 8 palavras sem negrito, em oração subordinada, no fim de 25 linhas
  cujo peso retórico inteiro estava em "NÃO mergear". O tick não ignorou
  o texto — preencheu um vazio de ênfase com uma regra plausível. Fix
  nomeia e nega explicitamente a leitura errada (mesmo princípio do aviso
  já existente contra reintroduzir merge "por otimização"). Puramente
  textual — nenhum mecanismo/script mudou. Detectores de tick improdutivo
  (propostas 1-3 do #6917) ficam para depois, calibrados com a taxa
  medida PÓS-conserto (senão a linha de base fica contaminada pelo
  próprio defeito). **Review do #6919 (achado P1, confiança alta):** o
  CABEÇALHO da própria §3 ("Fila de PRs abertos PRIMEIRO... enquanto
  houver PR aberto... nenhuma issue nova é reivindicada") era, lido ao
  pé da letra, a MESMA regra fabricada que o tick citou — corrigido
  também: "PRIMEIRO" agora é explicitamente ordem de PROCESSAMENTO
  dentro do tick, não condição de parada; a frase fabricada é citada e
  negada no próprio cabeçalho, mesmo princípio aplicado ao corpo.
- 0.5.11 (01/09/2026): #6885 — renovador de heartbeat em background durante
  a delegação (passo 4.2). Achado: heartbeat só era gravado 1x por tick
  (passo 1.3), nunca renovado — durante a delegação bloqueante (até 40min,
  `--timeout 2400`), um tick vivo e um tick morto no mesmo instante ficam
  com heartbeat igualmente "velho", indistinguíveis pro guard de merge
  (#5716). Fix MECÂNICO (não instrução em prosa pro agente lembrar — mesma
  lição do #6849 sobre honor-system): subshell em background, iniciado
  antes da delegação, renovando a cada 3min, morto (`kill`/`wait`) depois
  dela retornar; teto de 15 iterações (~45min) faz o renovador se
  auto-extinguir mesmo se o processo pai morrer sem matá-lo (SIGKILL do
  gateway), nunca ficando órfão batendo heartbeat pra sempre. Medição de
  duração real dos ticks (p50 7,6min, p99 59,1min, n=97) confirma que
  `SOFT_STALE_MS` (90min) já é a calibração correta pro desenho ATUAL
  (heartbeat sem renovação) — **não foi alterado nesta versão**: a
  sequência decidida é entregar a renovação, medir algumas semanas que ela
  de fato acontece em produção, só então encurtar o limiar. Encurtar em
  cima de uma renovação não confirmada trocaria "merge espera demais" por
  "merge concorrente por cima de tick ainda vivo" — a corrida que o #5716
  existe pra impedir.
- 0.5.10 (01/09/2026): #6849 — "Marcador com nonce": o sinal positivo de
  `pr-review-authenticity.ts` deixou de ser `INDEPENDENT_REVIEW_RE` (regex
  sobre a prosa "Review automatizado (N agentes, effort X): ..."). Achado
  ao vivo (corrigindo uma leitura errada anterior desta mesma issue): o
  revisor externo LEGÍTIMO — `continuo-pr-review.sh` — é instruído a
  produzir exatamente essa prosa, então nenhum regex textual distinguia
  fabricação de review real; endurecer o regex era correção impossível,
  não parcial. Fix: `continuo-pr-review.sh` gera `RUN_ID`/`AT` (identidade
  da execução) ANTES de invocar a sessão de review e instrui-a a colar o
  marcador `<!-- continuo-review: run=<id> at=<iso> -->`; o gate passa a
  exigir esse marcador, em linha própria (mesmo tratamento que o #6820 deu
  ao `SELF_REVIEW_MARKER`). A prosa "Review automatizado (...)" continua
  sendo a primeira linha, só pra leitura humana — não decide mais nada.
  **Não fecha o honor-system** (avaliador e avaliado seguem o mesmo
  processo/credencial `gh`, e o formato do marcador é público, num script
  versionado) — o que muda é que fabricar deixa de sair por ACIDENTE,
  porque o `run`/`at` só existem porque o script externo os gerou agora. A
  conclusão do #6864 abaixo (nunca mergear a própria PR) segue de pé —
  este item não a revoga nem depende dela.
- 0.5.9 (31/08/2026): #6864 — a delegação PARA de mergear a própria PR.
  §3 (fila de PRs abertos) removeu a instrução "exit 0 → merge no mesmo
  tick" — `check-pr-review-authenticity.ts` vira rótulo informativo pro
  relatório do tick, nunca autorização de ação; em TODO veredito
  (inclusive `pass`), a decisão é NÃO mergear e passar pra próxima
  issue/PR. Decorre do #6849: o gate é honor-system por construção
  (avaliador e avaliado são o mesmo processo/credencial) — endurecer a
  regex de reconhecimento não muda quem decide, só encarece fabricar.
  Só seguro porque o #6865 (v0.5.8, acima) já colocou um revisor externo
  de verdade em cron próprio (`continuo-pr-review.sh`; cadência — derivar
  com `hermes cron list --all`, #6928) — sem essa peça, PRs do
  contínuo ficariam órfãs até o pickup diário. Merge continua exclusivo
  do pickup (#6823) e do review consolidado — nunca desta delegação.
  Guard: `test/continuo-never-merges-own-pr.test.ts` falha se a instrução
  antiga voltar.
- 0.5.8 (31/08/2026): #6865 — review externo do contínuo separado em 2
  papéis (decisão do editor, decorrente do #6849). `daily-consolidated-
  review.sh` renomeado pra `opus-daily-diff-review.sh` (mesma cadência
  1x/dia, mesmo modelo Opus, mesmo papel — só o nome deixou de valer
  "o único review" com um irmão novo no diretório). Novo
  `continuo-pr-review.sh`: Sonnet, cron próprio, review de 1 PR `continuo/*` por
  vez, fecha o descompasso entre o contínuo e o
  review diário antigo (`0 12 * * *`) sem trocar o modelo do review
  profundo por um mais barato. Os dois scripts NUNCA mergeiam — o pickup
  (seção 3, passo 3, #6823) continua sendo o único ponto de merge, o que
  evita a corrida de dois processos mergeando a mesma PR (guard do
  #5716). Item 4 do #6865 (risco de corrida) resolvido por construção,
  não por lock. **Passo manual pendente fora do repo** (symlink +
  `hermes cron`), documentado em `hermes/README.md`.
- 0.5.7 (31/08/2026): "Segurança e escopo" — workdir único trocado por
  allowlist de raízes (#6817). `npx tsx scripts/check-continuo-workdir.ts
  --path {caminho} --intent read|write` antes de tocar qualquer path fora
  do tick corrente. 3 raízes definidas (`diaria-studio`/`hermes-agent`/
  `dot-hermes`) — só `diaria-studio` nasce `enabled: true`; as outras duas
  ficam desligadas de propósito (colisão com sessão trabalhando ao vivo em
  `~/hermes-agent`/`~/.hermes`, achado no mesmo dia). `~/.hermes/auth.json`
  negado permanentemente, em qualquer cenário. Novo guard de
  auto-modificação (`isSelfModification`) — mudança que toca o que o tick
  corrente está executando não se aplica agora, vira PR pro próximo tick.
  5 dos 7 sub-itens da issue (redação de auth.json, verbo de escrita de
  config, extensão do sensitive-path-guard, gate de review do fork, 2º
  tracker) deliberadamente NÃO implementados — dependem das raízes
  desligadas pra fazer sentido.
- 0.5.6 (31/08/2026): §4 passo 3 — checagem de rastreabilidade
  branch↔commit ANTES da PR entrar na fila de review (#6804). Achado ao
  limpar 61 branches `continuo/`: nome referenciando uma issue (inclusive
  um caso com #6043, P0) carregando commits de outra issue inteiramente —
  `watch-continuo-health.sh` item 5 só checa PREFIXO de trilha, nunca o
  número; e é alarme pós-fato (0 correções medidas na auditoria do #6798).
  `npx tsx scripts/check-branch-issue-consistency.ts --pr N` — `exit 1`
  comenta no PR com o achado, não bloqueia merge (rastreabilidade, não
  correção — conteúdo já chega certo ao master). Lógica pura em
  `scripts/lib/branch-issue-consistency.ts`.
- 0.5.5 (31/08/2026): §4 novo passo 0 — gate de coerência ANTES do claim
  (#6752). Auditoria mediu 2,4× de retrabalho em PRs `continuo` vs
  `overnight`/`develop`, causa raiz não é qualidade de diff isolado, é
  falta de memória entre PRs (caso canônico #6699: módulo compartilhado
  criado numa PR, contornado com hardcode duas PRs depois, mesma sessão).
  `npx tsx scripts/check-continuo-coherence.ts --issue N` roda antes de
  `session-registry.ts claim-issue` — `exit 1`/`2` pula a issue neste tick
  sem gravar nada nela (sem label, sem eixo novo em `classifyExecTrack` —
  decisão explícita do editor, opção 2 do #6752). Critério mecânico:
  overlap de path com PR aberta/merge recente de master, palavras-chave de
  refactor/abstração-compartilhada/fatia-de-épico/dependência-cruzada no
  corpo da issue (`scripts/lib/continuo-coherence-gate.ts`).
- 0.5.4 (31/08/2026): §3 passo 3 atualizado — pickup de PR órfão do
  `continuo` deixou de ser lacuna documentada e passou a existir de fato
  (#6823), implementado como passo 2b da Fase 0 do `/diaria-overnight`
  (fora deste arquivo — este SKILL.md só reflete o estado, não implementa
  o passo). Cobre tanto `exit 1` (`self_review`) quanto `exit 2`
  (`no_review` — tick que morreu antes de sequer comentar, o cenário real
  da PR que motivou a issue, #6844). Deliberadamente **só** no overnight,
  nunca no `/diaria-develop` (#5751). A entrada 0.5.3 abaixo, que dizia
  "aguardando review externo (Opus diário ou pickup do overnight/develop)",
  ficava desatualizada nesse detalhe (mencionava develop) até esta entrada.
- 0.5.3 (30/08/2026): gate de autenticidade de review pré-merge (#6732) —
  a delegação (sem ferramenta Agent) fabricava um comentário no formato de
  review independente, satisfazendo o gate de auto-merge do #5251 com
  self-review disfarçado (medido nos PRs #6713/#6715). A instrução do hook
  (`.claude/hooks/pr-create-review.mjs`) agora manda postar self-review
  honesto (`<!-- self-review: true -->`) quando o Agent tool não está
  disponível; o passo 3 do §3 acima roda
  `scripts/check-pr-review-authenticity.ts --pr N` antes de mergear —
  `exit 0` = review independente confirmado, mergeia; qualquer outro código
  = fail-closed, PR fica aberto aguardando review externo (Opus diário ou
  pickup do overnight/develop). Opção (2) da decisão do editor de 29/08,
  liberada para execução em 30/08.
- 0.5.2 (28/08/2026): session-id do cron por TICK, não por JOB (#6443,
  raiz da issue — itens 2/3 da decisão do editor já tinham sido resolvidos
  via #6436). `$SESSION_ID` agora inclui timestamp UTC do início do tick
  (`hermes-cron-{job}-{YYYYMMDDTHHMMSSZ}`), gerado uma vez no passo 1.3 e
  reusado nos demais comandos `session-registry.ts` do tick. Antes, o id
  fixo por job fazia o heartbeat de cada tick renovar a MESMA entrada do
  registro indefinidamente — a sessão nunca ficava `stale`, e um claim
  órfão de um tick sem PR nunca expirava sozinho (medido em 28/08: 7 issues
  em `claimed_issues`, 6 sem PR aberto). Passos 1.3 e 4.1 atualizados.
- 0.5.1 (28/08/2026): subagent MCP drain (#6465, epic #6464) — lote 5 posts (`claude -p` + MCP Beehiiv, `proc_...` EXIT=0). Padrões: (a) limite #6496 (5-10, nunca 20+); (b) anti-fabricação (`.jsonl` + manifest, não só EXIT=0); (c) dedup obrigatório (`subscriber_id` + `(sub, url_hash, clicked_at)`); (d) fonte única Helios/Neo (`data/beehiiv-backup/subscriber-engagement/` — `.worktrees/agent-*` NÃO sincronizam automaticamente); (e) claim hygiene (`--kind continuo`, unclaim só sem worktree ativo). Ver `references/subagent-mcp-drain-20260828.md`. Corrigido erro de assumir que `worktree` era fonte sincronizada; fonte real é `.jsonl` + manifest.
- 0.5.0 (28/08/2026): arquitetura delegada — classificação via código real
  (`classifyExecTrackWithRule`, 6 categorias), implementação via
  `claude-openrouter.sh` (harness Claude Code + OpenRouter), review diário
  consolidado Opus via `daily-consolidated-review.sh`. Remove a paráfrase da
  regra de classificação (fonte do bug das 5-vs-6 categorias).
- 0.4.0: ver SKILL.md.bak-v0.4-20260828.
