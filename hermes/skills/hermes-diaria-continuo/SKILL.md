---
name: hermes-diaria-continuo
description: Mantém continuamente a fila técnica da Diária delegando execução ao harness do Claude Code (modelos OpenRouter) e classificação ao código real do repo.
version: 0.5.15
author: Pixel, Hermes Agent
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [diaria, backlog, github, autonomia, continuidade, telegram, cron, claude-code]
    related_skills: [requesting-code-review, claude-code]
---

# Hermes Diária Contínuo (v0.5.0 — arquitetura delegada)

## O que mudou na v0.5.0 (28/08/2026, decisão do editor)

A v0.4 **parafraseava** as regras do repo em prosa que envelhecia em silêncio —
a cópia local do `classifyExecTrack` dizia 5 categorias quando o código real
tem 6 (`epica`, #6201, nunca chegou aqui). A v0.5 troca paráfrase por
**execução**: classificação roda o código real do repo, e implementação roda
dentro do harness do Claude Code (CLAUDE.md carregado, hooks e scripts reais),
com modelos do OpenRouter — sem tocar a cota da assinatura Anthropic.

Papel do Hermes nesta skill: **orquestrador** (loop do cron, claims, fila,
relatório no Telegram). Quem pensa sobre código é o harness delegado.

## Segurança e escopo

- **Allowlist de raízes (#6817), substitui o "workdir único" da v0.4.**
  Antes de LER ou ESCREVER qualquer path fora de `data/`/`.claude/worktrees/`
  do próprio tick, rodar `npx tsx scripts/check-continuo-workdir.ts --path
  {caminho} --intent read|write`. `exit 0` (allowed) → prossegue. `exit 1`
  (denied) → não tocar esse path, registrar no relatório do tick e seguir.
  3 raízes definidas (`scripts/lib/continuo-workdir-allowlist.ts`), **todas
  `enabled: true` desde 04/09/2026** (decisão do editor: "implementar como
  especificado. Sem redução de escopo"): `diaria-studio`, `hermes-agent`
  (fork `vjpixel/hermes`) e `dot-hermes` (`~/.hermes`). **`~/.hermes/
  auth.json` é negado permanentemente, em QUALQUER cenário** — tokens
  OAuth/chaves em claro, leitura livre por um agente cujo log vai pro
  Telegram é vazamento a 1 `echo` de distância; o hard-deny vence mesmo com
  `dot-hermes` ativada.
- **Leitura de `~/.hermes/sessions/sessions.json` (#6817 item 2, decisão do
  editor 03/09/2026): SÓ via `npx tsx scripts/read-hermes-session-status.ts
  --path {caminho}`.** Nunca ler o arquivo direto, nem por conveniência de
  debug. O script devolve APENAS os campos declarados em `DEFAULT_ALLOWED_
  SESSION_FIELDS` (`scripts/lib/hermes-session-status.ts`) — desenho
  deliberado de **allowlist de saída** (campo novo não sai até ser
  adicionado de propósito), não blacklist de segredo reconhecido (que falha
  aberto pra um formato de token não previsto — ver docstring do módulo).
- **Escrita de config de runtime (#6817 item 3): SÓ via `npx tsx
  scripts/write-hermes-config.ts --path {caminho} --content-file {novo}
  --reason {motivo} [--validate-cmd ...] [--smoke-cmd ...] [--echo-to
  ~/hermes-agent/config/hermes-home/{arquivo}]`.** Nunca `Edit`/`Write`
  direto em `~/.hermes/config.yaml`, `cron/jobs.json` ou `profiles/*` —
  antes de escrever, confirmar com `npx tsx scripts/check-continuo-workdir.ts
  --check-runtime-sensitive --path {caminho} --intent write` (exit 1 =
  exige o verbo; `--intent read` sempre libera). O
  verbo faz backup automático, roda validação/smoke opcionais com revert
  automático em falha, e ecoa um snapshot REDIGIDO pro fork quando
  `--echo-to` é passado. Detalhes: `scripts/lib/hermes-config-writer.ts`.
- **Guard de auto-modificação (#6817 item 4).** Antes de aplicar qualquer
  mudança, rodar `npx tsx scripts/check-continuo-workdir.ts --check-self-mod
  --path {caminho da mudança} --active {lista separada por vírgula dos
  arquivos que ESTE tick está executando agora}` — tipicamente o próprio
  `SKILL.md`, o wrapper `claude-openrouter.sh`, o job corrente em
  `~/.hermes/cron/jobs.json`. `exit 1` (self-modification): **não aplicar
  a mudança neste tick** — abrir PR e deixar pro próximo tick ou decisão
  do editor. `exit 0`: seguro aplicar. Review da PR #6854 (P2, confiança
  alta): a versão inicial só documentava a função pura
  (`isSelfModification`, mesmo módulo) sem NENHUM comando que a
  chamasse — a delegação só sabe rodar `npx tsx scripts/...`, nunca
  importar TS direto, então a instrução original era inexecutável na
  prática. Achado #6059: o contínuo deletou a própria infra no meio do
  próprio loop, quebrando-o; revertido no #6060.
  Fail-closed é requisito aqui, não preferência — o contínuo rodando
  DENTRO do que ele modifica é a receita de um estado que ninguém desfaz
  sozinho.
- **Config de runtime é caminho SENSÍVEL** (#6817 item 5) — checar
  `--check-runtime-sensitive` (acima) ANTES de Edit/Write em
  `.hermes/config.yaml`/`cron/jobs.json`/`profiles/**`. Não entrou em
  `sensitive-path-guard.ts` (quebraria o hygiene test de lá — regra precisa
  casar arquivo RASTREADO deste repo); vive em `scripts/lib/hermes-runtime-
  sensitive-paths.ts`, módulo irmão.
- **PR no fork `vjpixel/hermes` (#6817 item 6): abrir SIM, auto-merge NÃO
  — decisão do editor 03/09/2026.** `continuo-pr-review.sh` (única
  autoridade de merge) tem `REPO=/home/vjpixel/diaria-studio` fixo — nunca
  mergeia PR de outro repo, por construção. Sem maquinaria de review
  equivalente no fork (`pr-create-review.mjs` é deste checkout), PR do
  fork fica sempre aberta aguardando review humano/externo.
- **Item 7 (2 trackers) RESIDUAL** — issues do fork `vjpixel/hermes#6/#8/#9`
  como 2ª fila não implementado: exige decisão de design (ordem de
  prioridade entre filas) que a issue não especifica. `classifyExecTrack`
  segue única fonte pras issues deste repo.
- Nunca tocar `data/editions/` de edição em curso, credenciais, ou disparar
  publicação. Fila TÉCNICA (issues/PRs), nunca fluxo editorial.
- Env vars `ANTHROPIC_*` NUNCA no ambiente global — só dentro do wrapper
  (`#5608`; elas sequestram sessões da assinatura).

## Ferramentas desta skill

| ferramenta | o que faz | modelo |
|---|---|---|
| `~/.hermes/scripts/claude-openrouter.sh` | roda `claude -p` com OpenRouter (stdin=prompt; `--tools`, `--budget`, `--timeout`) | `dots-studio/dots-3-note-preview:free` → `poolside/laguna-s-2.1:free` → `z-ai/glm-5.3-flash` |
| `npx tsx --eval` (direto, sem LLM) | classificação determinística | nenhum |
| `~/.hermes/scripts/opus-daily-diff-review.sh` | review Opus do diff ACUMULADO do dia (cron separado, 1x/dia; #6865, ex-`daily-consolidated-review.sh`) | Anthropic (assinatura) |
| `~/.hermes/scripts/continuo-pr-review.sh` | review Sonnet de toda PR aberta no repo, exceto `bot/*` (escopo ampliado além de `continuo/*` no #7446 item 4 — PR de qualquer branch podia ficar sem merger nenhum; cron separado, cadência: derivar com `hermes cron list --all` — nunca esta prosa, #6928; #6865) — o MODELO nunca mergeia (`gh pr merge` fora do `--allowedTools`); o SCRIPT BASH mergeia depois, atrás de 8 portões fail-closed (#6926) — `REPO` fixo em `diaria-studio`, nunca toca PR do fork (#6817 item 6). `escalate` label a PR (`continuo-escalado`) e notifica só na 1ª vez (#7446 item 2). | Anthropic (assinatura) |
| `npx tsx scripts/check-continuo-ci-fixer-candidate.ts` / `mark-continuo-ci-fix-attempted.ts` | antes de reivindicar issue nova, escolhe a PR `continuo/*` mais antiga com CI `fail` e sem tentativa de conserto ainda (§3b, #7446 item 3); cap de 1 tentativa via label `continuo-ci-fix-tentado` | determinístico (npx tsx), sem LLM |

## Cada ciclo (tick do cron)

### 1. Preparar e sincronizar (Hermes, shell direto)

0. **Recuperação mecânica de tick interrompido (#7130), ANTES de qualquer
   outro comando deste passo.** Medição ao vivo (#6908, 02/09): 2 de 3 ticks
   longos produziram diff real e não fecharam o laço — sem claim, sem
   commit, sem PR, árvore de trabalho deixada suja em `master` no checkout
   compartilhado (#6952: 498 linhas nunca commitadas, sessão anterior
   reportou "concluído"). `cd /home/vjpixel/diaria-studio && npx tsx
   scripts/rescue-continuo-orphaned-work.ts --push`. `outcome: "clean"`
   (exit 0, caso comum) → segue pro item 1 abaixo. `outcome: "rescued"`
   (exit 0 com `--push` OK) → trabalho órfão de um tick anterior morto foi
   commitado numa branch dedicada (`continuo/rescue-{timestamp}`) e, quando
   `gh pr create` também funcionou, virou PR `REFS #7130, NÃO CLOSES` — não
   resolve a issue original que gerou aquele diff (desconhecida por
   construção), só preserva o trabalho em vez de deixá-lo evaporar/ser
   varrido pelo `git add -A` de outra sessão; registrar no relatório do tick
   (§"Relatório de tick" abaixo). `outcome: "rescue_failed"` OU `"rescued"`
   com `--push` que falhou (exit ≠ 0) → **parar este tick e reportar como
   `Parada`** no relatório (não tentar `sync-code.ts`/dispatch neste tick —
   o checkout compartilhado pode estar num estado que outro comando `git`
   piora).
1. `cd /home/vjpixel/diaria-studio && npx tsx scripts/sync-code.ts` — fail-soft:
   warning e segue; nunca forçar pull/reset/stash.
2. Guard de colisão editorial: `npx tsx scripts/lib/find-current-edition.ts
   --stage 2` (e stages relevantes). Edição em curso → registrar pausa, não
   despachar trabalho técnico concorrente neste tick.
3. `session-registry.ts` heartbeat/registro se aplicável, **sempre com
   `--kind continuo`** — fora do harness não inventar `--session-id`.
   **Nunca `--kind overnight`, mesmo esta skill sendo derivada do overnight**
   (é justamente essa derivação que torna o erro fácil de cometer — achado
   ao vivo 28/08/2026, #6483: `register`/`heartbeat` desta skill gravou
   `"kind":"overnight"` em `data/sessions/`, sumindo da trilha "Contínuo" da
   Triagem do Studio e poluindo a trilha "Overnight" com uma entrada que não
   é overnight de verdade — usar SEMPRE o MESMO `--kind continuo` em
   `register`/`heartbeat`/`claim-issue`, nunca alternar).
   **`--session-id` é POR TICK, nunca por job (#6443, 28/08/2026)** — gerar
   UMA VEZ aqui, no início deste tick, e reusar o MESMO valor em TODOS os
   comandos `session-registry.ts` deste tick (`register`/`heartbeat`/
   `claim-issue`); nunca regerar no meio do tick, nunca reusar entre
   ticks: `SESSION_ID="hermes-cron-5d791ef6fc2c-$(date -u +%Y%m%dT%H%M%SZ)"`.
   Era um id estável do job cron (`hermes-cron-5d791ef6fc2c` sem sufixo) — o
   heartbeat de CADA tick renovava a MESMA entrada do registro, que por isso
   nunca ficava `stale`, e um claim órfão de um tick que não abriu PR nunca
   expirava sozinho (#6443). Com o sufixo por tick, a entrada do tick
   ANTERIOR simplesmente para de receber heartbeat quando o tick seguinte
   começa (mesmo sem chamar `end`) — `SOFT_STALE_MS` (90min,
   `isIssueClaimedByOther` em `session-registry.ts`, #5474) trata essa
   entrada como stale e deixa de bloquear `claim-issue`/`is-claimed` pra
   qualquer outra sessão, sem depender de nada além do que já existe.
   (`claim-staleness.ts`/#6436 é uma camada DIFERENTE e complementar — TTL
   por idade da claim em si, `claimed_issues_at`, sem PR aberto — consumida
   por `check-block-staleness.ts`; não é o mecanismo que este fix aciona.)
   Exemplo completo — `npx tsx
   scripts/lib/session-registry.ts register --kind continuo --session-id
   "$SESSION_ID"`.

### 2. Classificar — SEM LLM, executando o código real

Nunca parafrasear a regra. Para o backlog aberto:

```bash
gh issue list --state open --json number,labels,body,state --limit 200 > /tmp/issues.json
npx tsx --eval "
import('./scripts/lib/issue-exec-track.ts').then(async ({classifyExecTrackWithRule}) => {
  const issues = JSON.parse(require('fs').readFileSync('/tmp/issues.json','utf8'));
  for (const i of issues) {
    const labels = i.labels.map(l=>l.name);
    const r = classifyExecTrackWithRule({labels, body: i.body||'', state: i.state});
    console.log(JSON.stringify({n:i.number, track:r.track, rule:r.matched}));
  }
})"
```

O output é a verdade — 6 categorias (`overnight`/`develop`/`agendada`/
`bloqueada`/`epica`/`fora-de-rodada`), sempre da versão de hoje do código.
Se o `.ts` mudar, esta skill NÃO precisa mudar.

Escopo do contínuo: issues `track=overnight` não reivindicadas por outra
sessão ativa (regra de claim abaixo). `develop`/`bloqueada`/`epica`/etc.:
registrar no relatório, não trabalhar.

#### Regra dura: NUNCA parsear saída do `gh` com Python ad-hoc

Observado no 1º tick da v0.5.0 (28/08, 01:44–01:47): 3 tracebacks seguidos
(`'list' object has no attribute 'get'`, `KeyError: 'filename'`) de one-liners
Python adivinhando o schema do `gh` — cada palpite errado queima um turno e
uma chamada da cota free. O `gh` já embute `--jq`; usar SEMPRE as receitas:

```bash
gh pr list --author @me --state open --json number,title,headRefName \
  --jq '.[] | "\(.number)\t\(.title)"'
gh pr view N --json files --jq '[.files[].path]'        # campo é .path, NÃO .filename
gh pr view N --json mergeable,reviewDecision --jq '{m:.mergeable,r:.reviewDecision}'
gh issue list --state open --json number,labels \
  --jq '.[] | {n:.number, labels:[.labels[].name]}'
```

Precisou de um campo que não está aqui: `gh pr view N --json 2>&1 | head`
lista os campos válidos — consultar antes de chutar.

### 3. Fila de PRs abertos PRIMEIRO (ordem de PROCESSAMENTO no tick — não bloqueia reivindicar issue)

**Correção (#6917, 01/09/2026): a frase anterior deste cabeçalho dizia "nenhuma
issue nova é reivindicada" enquanto houvesse PR aberto pendente — e essa
frase era, lida ao pé da letra, a MESMA regra fabricada que o tick do #6917
citou pra justificar não trabalhar (já que #6864 faz o contínuo NUNCA
mergear a própria PR, "PR pendente de merge" é quase sempre verdade). "PRIMEIRO"
aqui é ordem de PROCESSAMENTO dentro do tick — rotular/decidir cada PR aberto
antes de seguir pra fila de issues — nunca uma condição de parada. Ver "PR
aberta NUNCA encerra o tick" no passo 3 abaixo, que é a afirmação
autoritativa sobre isto.** Para cada PR aberto do fluxo autônomo, nesta
ordem:

1. **Superseded-check** (pitfall real #6238, 26/08): `git log origin/master
   --oneline -- <arquivos-do-pr> | head -5` — se o master atual já tratou a
   mesma issue igual ou melhor, `gh pr close N --comment "superseded por
   <ref>"`. Nunca mergear por inércia.
2. **Guard de caminho sensível** (fail-closed, #6277): `npx tsx
   scripts/lib/sensitive-path-guard.ts --base origin/master --json`.
   `"sensitive": true`, exit ≠ 0, stdout vazio ou JSON inválido → NÃO mergear;
   comentar no PR e encaminhar.
3. **Review independente pré-merge** (pipeline `requesting-code-review`,
   inalterado): scan estático → baseline de testes → reviewer independente
   fail-closed → auto-fix loop (máx. 2).

   **Gate de autenticidade do review, obrigatório antes de mergear (#6732):**
   a delegação do passo 4 roda sem ferramenta Agent (`--tools` abaixo omite
   `Agent`/`Task`, de propósito — #6712), então ela não consegue de fato
   despachar um subagente revisor via o dispatch que
   `.claude/hooks/pr-create-review.mjs` instrui. A instrução do hook cobre
   isso (30/08/2026): sem Agent tool disponível, a sessão posta o review como
   self-review honesto, com a linha literal `<!-- self-review: true -->`, em
   vez de fabricar um comentário no formato `"Review automatizado (N
   agente(s)..."` de um dispatch que não aconteceu (era exatamente isso que
   os PRs #6713/#6715 mostravam, indistinguível de um review real).

   **#6864 (31/08/2026) — o contínuo NUNCA mergeia a própria PR, ponto.**
   Decisão do editor, decorrente do #6849: o gate de autenticidade acima
   (`check-pr-review-authenticity.ts`) é honor-system por CONSTRUÇÃO —
   avaliador (esta delegação) e avaliado (a PR que ela mesma abriu) são o
   MESMO processo, com a MESMA credencial `gh`, escrevendo no MESMO lugar.
   o regex de prosa original (`INDEPENDENT_REVIEW_RE`, removido no #6849 —
   ver "Marcador com nonce" em `references/changelog.md`, entrada v0.5.10) já aprovou o texto
   fabricado exato do incidente #6713 uma vez, e o #6849 achou que o
   revisor externo LEGÍTIMO (`continuo-pr-review.sh`) produzia a MESMA
   prosa — endurecer a regex nunca teria fechado isso, era um
   discriminador impossível por texto. O marcador com identidade de
   execução que o #6849 introduziu reduz o caso de fabricação POR ACIDENTE,
   mas não muda a conclusão desta seção: avaliador e avaliado seguem sendo
   o MESMO processo com a MESMA credencial `gh`, então nada aqui autoriza
   merge de volta pra esta delegação — a investigação do #6849 esgotou a
   busca por sinal fora do texto
   (autor — `["vjpixel"]` é o único ator que já comentou neste repo, sem
   bot/App; `kind` do session-registry; `gh pr comment` × `gh pr review`;
   telemetria de dispatch) e não achou nenhum. **Remover a capacidade de
   merge é mais forte que confiar no texto ou proteger um segredo de bot**
   — não há configuração a errar, e este repo já tem 3 incidentes
   documentados de credencial vazando pro processo errado (#5608, #6714,
   #6718) pra desconfiar de "revisor com token próprio" como solução.

   Rode `npx tsx scripts/check-pr-review-authenticity.ts --pr N` mesmo
   assim — o resultado (`pass`/`self_review`/`no_review`/`error`) vira
   ROTULO informativo no relatório do tick (ex: "review independente já
   presente" vs "aguardando review externo"), não autorização de ação. Em
   TODOS os casos, inclusive `exit 0`/`pass`: **NÃO mergear.** O merge
   acontece exclusivamente no pickup (#6823, abaixo) ou no review
   consolidado, que têm ferramenta Agent e conseguem revisar de verdade —
   nunca nesta delegação. **Se você chegou aqui pensando em reintroduzir
   merge nesta seção "por otimização" (menos latência, menos dependência
   de outro processo): não. É exatamente o trade-off que o #6864 aceitou
   de propósito — ver "Custo aceito" na issue.**

   **PR aberta NUNCA encerra o tick (#6917, 01/09/2026).** Depois de
   rotular a PR, siga para a próxima issue/PR da fila e trabalhe
   normalmente. "Há PR aguardando review externo" descreve o estado
   DAQUELA PR, não uma condição de parada do tick — não existe regra que
   limite o contínuo a uma PR por vez. Se há issue `track=overnight`
   elegível e não reivindicada, o tick trabalha. Achado ao vivo (#6917):
   um tick com 36 issues `track=overnight` elegíveis na fila terminou sem
   reivindicar nenhuma, justificando com "conforme a regra de prioridade
   da fila" — **essa regra nunca existiu neste arquivo.** O tick preencheu
   um vazio de instrução com uma regra plausível; nomear e negar
   explicitamente a leitura errada aqui fecha esse vazio, no mesmo
   princípio do aviso contra reintroduzir merge logo acima.

   **Pickup existe desde o #6823 (31/08/2026) — só no `/diaria-overnight`.**
   O fleet review do #6820 (30/08/2026) tinha achado que nenhuma das duas
   skills adotava PR órfão marcado self-review; o #6823 fechou essa lacuna
   no `/diaria-overnight` (passo 2b da Fase 0): lista PRs `continuo/*` com
   `check-pr-review-authenticity.ts` → `exit 1` (self_review) **ou** `exit 2`
   (no_review — tick morreu antes de sequer comentar; caso da PR que motivou
   a issue, #6844), roda guard de caminho sensível + review independente de
   verdade via Agent tool + gate de CI genuína, mergeia se limpo.
   **`/diaria-develop` deliberadamente NÃO ganhou esse passo** — pickup de
   PR órfão do contínuo não exige presença
   do editor nem a máquina Windows, então é trabalho que cabe ao
   `/diaria-overnight` (server, desassistido), não a uma sessão interativa
   (#5751, "sessão interativa não faz o que o helios faria sozinho"). Na
   prática, um PR self-reviewed do contínuo fica aberto até a próxima rodada
   `/diaria-overnight` rodar a Fase 0, OU até o próximo tick do cron
   próprio de `continuo-pr-review.sh` (cadência: derivar com
   `hermes cron list --all`, #6928) revisar e mergear sozinho — ver
   próximo parágrafo. `opus-daily-diff-review.sh` (ex-`daily-consolidated-
   review.sh`) continua só gerando achados/comentários, nunca mergeando.

   **`continuo-pr-review.sh` ganhou autoridade de merge própria desde o
   #6926 (01/09/2026) — o pickup acima deixou de ser o único ponto de
   merge, virou FALLBACK.** Motivo: o pickup só roda quando o editor inicia
   uma rodada `/diaria-overnight` manualmente (sem agendador) — uma PR
   pronta (review independente + CI verde) podia ficar parada indefinidamente
   (medido ao vivo: PR #6901, 10h29 parada). `continuo-pr-review.sh`
   continua NUNCA dando a ferramenta `gh pr merge` ao MODELO da sessão de
   review (`--allowedTools` travado, `test/continuo-pr-review-never-
   merges.test.ts`) — quem mergeia é o SCRIPT BASH, depois que a sessão já
   saiu, atrás de 5 portões fail-closed em `scripts/check-continuo-merge-
   gate.ts` (superseded, veredito `approve`/`reject` gravado no marcador
   de review, HEAD não mudou desde o início da revisão — corrida do #5716,
   caminho não-sensível, CI verde + mergeable, diff dentro do limiar de
   effort de `pr-create-review.mjs`). Dois casos ainda escalam pro pickup
   (fallback, não mais caminho único): caminho sensível, e diff ≥ limiar —
   a revisão desta sessão é rasa por design, só decide sobre o que
   consegue julgar.

### 3b. Antes de reivindicar issue nova: candidata de conserto de CI (#7446 item 3)

**Medido ao vivo (04-05/09/2026): PR #7429/#7432 com CI em FAILURE há
17h/15h, sem ninguém tentar consertar** — o tick que abre a PR morre
(budget/crash/fim) antes do CI terminar, e o próximo reivindica outra
issue sem voltar. **NÃO reintroduz "PR pendente bloqueia o tick"** (#6917:
"PR aberta NUNCA encerra o tick" segue valendo — aquilo é PR aguardando
REVIEW, estado normal; isto é CI **vermelho**, estado quebrado que ninguém
mais conserta sozinho). Só muda a PRIORIDADE do que o tick faz primeiro.

Logo antes de reivindicar uma issue nova (depois de processar a fila de PRs
do passo 3 acima), rodar:

```
npx tsx scripts/check-continuo-ci-fixer-candidate.ts
```

Retorna `{"candidate": number | null, "checked": number}`. `candidate` não
nulo = PR `continuo/*` aberta com CI reprovado de verdade (`fail` — nunca
`pending`/`error`/`blocked_by_conflict`) sem label `continuo-ci-fix-tentado`
ainda. Se houver candidata:

1. **Antes de tocar em qualquer código**, rodar
   `npx tsx scripts/mark-continuo-ci-fix-attempted.ts --pr N` — aplica
   `continuo-ci-fix-tentado`, fechando o cap de 1 tentativa por PR
   (`selectCiFixCandidate`, `scripts/lib/continuo-ci-fixer-eligibility.ts`)
   ANTES de gastar tempo consertando (review da PR #7450: marcar só DEPOIS
   deixaria uma janela de corrida do tamanho do conserto inteiro entre 2
   ticks escolhendo a MESMA PR; marcar antes reduz a janela pro intervalo
   entre "escolher" e "marcar"). Exit ≠ 0 = o label NÃO pegou de verdade —
   tratar como falha real (não seguir como se tivesse fechado o cap; a PR
   segue candidata no próximo tick, o que é aceitável — a alternativa,
   assumir sucesso silenciosamente, É o livelock que este mecanismo existe
   pra evitar).
2. Consertar o CI dessa PR (harness delegado do passo 4, sobre a branch já
   existente — nunca abrir PR novo pra isto). Sucesso ou falha do conserto
   não muda nada aqui — o label já está aplicado, o cap já fechou.
3. Seguir o tick normalmente (reivindicar issue nova se sobrar budget).

`checked: -1` (`gh pr list` falhou) = "nenhuma candidata", fail-soft. PR que
recebeu a tentativa e segue vermelha fica coberta pelo `escalate` do
gate de merge (#7446 item 2, label `continuo-escalado`) e pela checagem 9
de `watch-continuo-health.sh` (#7446 item 6, alarme de fila) — nunca fica
invisível, só para de ser retentada mecanicamente.

### 4. Implementar issues elegíveis — via harness delegado

Para cada issue elegível (após claim):

0. **Gate de coerência (#6752), ANTES do claim — barra cedo, não depois de
   implementar.** Auditoria de 29/08/2026 mediu 2,4× de retrabalho em PRs
   `continuo` vs `overnight`/`develop` da mesma janela — não por qualidade
   de diff isolado (notas próximas), mas por FALTA DE MEMÓRIA ENTRE PRs: o
   caso canônico (#6699) é uma PR criando um módulo canônico em
   `scripts/lib/shared/` e, dois commits depois, outra PR do mesmo dia
   contornando essa mesma abstração com um literal hardcoded — a abstração
   foi criada e imediatamente pisada pelo próprio autor. Decisão do editor
   (#6752, 30/08/2026): checagem MECÂNICA aqui no passo de seleção, **sem**
   eixo novo em `classifyExecTrack` nem label dedicada — rejeitar aqui não
   grava NADA na issue, ela só não é reivindicada NESTE tick, continua
   `track=overnight` normal pro overnight/develop.

   Rodar, pra cada candidata ANTES de `claim-issue`:
   ```bash
   npx tsx scripts/check-continuo-coherence.ts --issue N
   ```
   `exit 0` (`admit`) → prossegue pro passo 1 (claim). `exit 1` (`reject`) →
   **NÃO reivindicar** — registrar no relatório do tick ("pulada por
   coerência: {motivo}") e ir pra próxima candidata da fila. `exit 2`
   (`error` — `gh`/`git` falhou, inconclusivo) → tratar como `reject`
   também (fail-closed, mesma disciplina do guard de caminho sensível do
   §3 passo 2: não sabe responder ⇒ não arrisca). Ver
   `scripts/lib/continuo-coherence-gate.ts` pro que o gate mede
   (overlap de path com PR aberta/merge recente, refactor/consolidação,
   abstração compartilhada, fatia de épico, dependência cruzada explícita
   de outra PR) e por que é mecânico em vez de julgamento — não é um
   classificador perfeito (decide ANTES do diff existir), mas erra pro
   lado de barrar mais, porque o custo do falso-positivo (issue boa espera
   o overnight) é muito menor que o do falso-negativo medido (retrabalho
   2,4×, 3 das 4 quebras recentes de master).
1. **Claim é LEASE de trabalho imediato, nunca reserva de fila** (regra dura,
   28/08 — incidente recorrente antes do #6443: o contínuo acumulava claims
   sem PR nenhum e travava as issues para o develop indefinidamente, porque
   o session-id do cron era por JOB (fixo entre ticks) e o heartbeat renovava
   a MESMA entrada a cada tick — a sessão nunca ficava stale, então claim
   órfão nunca expirava sozinho. Corrigido pelo session-id por TICK do passo
   1.3 — usar sempre `$SESSION_ID` (a variável gerada naquele passo), nunca
   mais o literal fixo):
   - Reivindicar **UMA issue por vez**, e somente no instante em que a
     implementação dela vai começar NESTE tick. Nunca reivindicar "as
     elegíveis" em lote no início do ciclo. Comando: `session-registry.ts
     claim-issue --kind continuo --issue N --session-id "$SESSION_ID"`
     (sempre `--kind continuo`, nunca `overnight` — ver passo 1.3).
   - Só issues `track=overnight` podem ser reivindicadas. `bloqueada`/
     `develop`/`epica`/`agendada` NUNCA — mesmo que pareçam fáceis.
   - **Fim de tick = higiene obrigatória**: para cada issue em
     `claimed_issues` SEM PR aberto referenciando-a e sem worktree ativo,
     rodar `session-registry.ts unclaim-issue --kind continuo --issue N
     --session-id "$SESSION_ID"` ANTES do relatório (`--kind` e
     `--session-id` são ambos obrigatórios no CLI — `requireKind`/
     `requireSessionId` lançam sem eles; `--kind` sempre `continuo`, nunca
     `overnight`, mesmo motivo do passo 1.3). Claim que sobrevive ao
     tick precisa de evidência de trabalho em curso. **Rede de segurança**
     (#6443): mesmo que esta higiene falhe/seja pulada num tick, o
     session-id por tick (passo 1.3) garante que a entrada do tick pare de
     receber heartbeat quando ele termina — `SOFT_STALE_MS` (90min) trata
     essa entrada como stale sozinha, sem depender desta higiene ter
     rodado.
   - `claim-issue` com `exit 1` = outra sessão segura a issue → pular só ela.
     Sessões stale (heartbeat > 90min) não bloqueiam.
2. **Delegar a implementação ao harness — com renovador de heartbeat em
   background (#6885).** A delegação abaixo é uma chamada ÚNICA e
   BLOQUEANTE de até `--timeout 2400` (40min) — durante esse tempo inteiro,
   `session-registry.ts heartbeat` (passo 1.3) não roda de novo, porque
   esta sessão está travada esperando o subprocesso. Um tick vivo rodando
   há 30min fica com o MESMO heartbeat "velho" que um tick morto há 30min —
   indistinguíveis pro guard de merge (#5716), que só sabe ler idade de
   heartbeat.
   
   **Por que é um processo em background, não uma instrução pra chamar
   heartbeat "de vez em quando"**: uma instrução em prosa depende do
   agente lembrar de executá-la no meio de um trabalho que está
   absorvendo a atenção dele — falha exatamente como a #6849 mediu pro
   marcador de review (o comportamento correto existe só enquanto quem
   executa coopera). Um renovador destacado, iniciado ANTES da delegação
   e morto DEPOIS dela, não depende de julgamento nenhum: se o processo
   pai (este tick) está vivo, o `wait`/`kill` no fim do bloco garante que
   ele para; se o pai morre no meio (SIGKILL do gateway, #6885), o teto de
   15 iterações (~45min, folga sobre os 40min do `--timeout`) garante que
   o renovador nunca fica batendo heartbeat pra sempre num tick que já
   morreu — o mesmo problema que existe pra resolver, só que órfão em vez
   de esquecido.

```bash
(
  for _ in $(seq 1 15); do
    sleep 180
    npx tsx scripts/lib/session-registry.ts heartbeat \
      --kind continuo --session-id "$SESSION_ID" >/dev/null 2>&1 || true
  done
) &
HEARTBEAT_PID=$!

printf '%s' "Implemente a issue #N do repo atual (leia com gh issue view N).
Siga o CLAUDE.md. Crie branch com o prefixo continuo/ (convenção
continuo/fix-N-slug — é o que faz o PR aparecer como CONTINUO na Triagem
do Studio, #6446), implemente com edições cirúrgicas, adicione
teste de regressão se for bugfix (#633), rode os testes afetados, abra PR
com gh pr create referenciando a issue. NÃO mergeie — desde o #6864, nem
o coordenador deste tick mergeia mais: o merge acontece exclusivamente no
pickup (#6823) ou no review consolidado. Se a issue for inviável/ambígua
além do trivial, comente nela o bloqueio via gh issue comment e pare." | \
  ~/.hermes/scripts/claude-openrouter.sh \
    --tools "Read,Grep,Glob,Bash,Edit,Write" \
    --budget 20.0 --timeout 2400

kill "$HEARTBEAT_PID" 2>/dev/null || true
wait "$HEARTBEAT_PID" 2>/dev/null || true
```

Mesmo padrão se aplica a qualquer OUTRA chamada de subprocesso de duração
comparável dentro do mesmo tick (nenhuma identificada hoje além desta —
classificação é mecânica/rápida, os checks dos passos 0/3 são scripts
curtos) — se um novo passo longo e bloqueante entrar na skill no futuro,
envolvê-lo com o mesmo renovador em vez de assumir que o heartbeat do
passo 1.3 ainda está fresco.

**NUNCA baixar o `--budget` para "economizar" (#6712).** Ele não controla o
gasto desta pipeline — o CLI não reconhece o slug do gateway e estima o custo
a preço da Anthropic, ~14-18x o real, então um teto "econômico" aborta a
delegação no meio gastando centavos. Quem limita gasto é o teto diário da key
na OpenRouter, aplicado pelo provedor. Em 29/08/2026 o tick reagiu a
`Exceeded USD budget` tentando 1.5 e depois 1.0 — a direção errada: 3
delegações morreram, o tick de 40min produziu zero PRs e deixou worktree
órfão. Se este erro aparecer, o valor a mexer é para CIMA.

3. **Antes** de entrar na fila (próximo item): `npx tsx
   scripts/check-branch-issue-consistency.ts --pr N`. **Rastreabilidade
   (#6804)**, achado ao limpar 61 branches `continuo/`: branch nomeada
   `continuo/fix-6043-onboarding` (P0 de mass-send indevido) chegou a
   carregar só trabalho do #6005 (carrossel do Instagram) — quem investigar
   o P0 pelo nome da branch encontra outra coisa. `exit 1` (`mismatch` — o
   número no nome da branch não aparece em NENHUM commit) → comentar no PR
   com o achado (`gh pr comment N --body "..."`, texto que o CLI já imprime
   em stderr) — **não bloqueia o merge nem o review** (o conteúdo já chega
   correto ao master, é achado de arqueologia, não de correção — #6804 é
   P3). `exit 0` (`consistent`) → nada a fazer. `exit 2` (`error` — `gh`
   falhou, inconclusivo, review da PR #6848: esta branch tinha ficado sem
   instrução, assimétrica com o passo 0 acima que já trata `exit 2`) →
   registrar no relatório do tick ("rastreabilidade não verificada pro PR
   #N: {motivo}") e seguir — não é `consistent`, mas também não bloqueia
   nada (mesmo caráter não-bloqueante do `mismatch`, só que sem o achado
   pra comentar). O PR aberto entra na fila do passo 3 (review independente
   continua sendo o gate — o harness implementa, o pipeline do Hermes
   revisa e mergeia).
4. **Falha do wrapper (exit ≠ 0, todos os modelos) — verificar ANTES de
   desfazer o claim (#6712, achado 29/08/2026, 2 ocorrências no mesmo dia):**
   o wrapper pode estourar `--max-budget-usd` (ou outro erro classificado
   como falha) **DEPOIS** de já ter commitado e aberto PR — o relatório do
   tick então lê "nada foi feito" quando na real o trabalho existe,
   `unclaim-issue` libera a issue de volta pra fila, e o próximo tick (ou o
   overnight/develop) refaz trabalho que já tem PR aberto. 1ª ocorrência:
   #6702 desfeito por engano (PR #6713 já existia). 2ª forma, mais sutil,
   no mesmo dia: um WORKTREE criado durante o próprio tick (`.claude/worktrees/`,
   não commitado) foi relatado como "trabalho de OUTRA sessão em curso" —
   verificado que o worktree nascera dentro da janela do tick.

   Antes de rodar `unclaim-issue` por causa de erro de delegação, checar
   AMBOS:
   ```bash
   gh pr list --author @me --state open --json number,headRefName,createdAt \
     --jq '.[] | select(.headRefName | startswith("continuo/fix-'"$ISSUE_NUM"'"))'
   ls -la .claude/worktrees/ 2>/dev/null   # worktree da unidade já existe?
   ```
   Se PR ou worktree da unidade já existir: **não desfazer o claim** — o
   trabalho está em curso ou concluído; registrar isso no relatório e deixar
   o próximo tick continuar de onde parou (worktree) ou só aguardar o review
   (PR já aberto). Só desfazer o claim quando NENHUM dos dois existir — aí
   sim é falha real de infra, sem trabalho a preservar.

   Falha do wrapper **sem** PR nem worktree da unidade: registrar no
   relatório, NÃO reimplementar no modelo do próprio Hermes — o fallback já
   está dentro do wrapper; falha total é sinal de infra, não de modelo.

### 5. Sem trabalho elegível → perguntar/registrar (inalterado da v0.4)

1. Revarrer issues novas/atualizadas; reclassificar (passo 2).
2. `precisa-resposta` → pergunta objetiva ao editor no Telegram; resposta
   vira comentário na issue (`gh issue comment`), nunca só memória de chat.
3. Bloqueio externo → registrar com label, sem confundir com decisão.
4. Resposta do editor no tópico → processar IMEDIATAMENTE (não esperar tick).

### 6. Review consolidado diário (cron separado — NÃO por tick)

`opus-daily-diff-review.sh` (#6865, ex-`daily-consolidated-review.sh` —
renomeado porque "daily-consolidated-review" deixou de distinguir qual dos
dois scripts de review é qual, ver seção 7) roda 1x/dia (cron próprio,
09:00 BRT) com a **assinatura Anthropic** (Opus) sobre o diff acumulado
desde o último marco. Findings viram issues `[daily-review]` com
prioridade — que caem nesta fila e são drenadas pelos modelos free. O
loop se fecha: Opus audita, free corrige. Esta skill NÃO chama esse
script no tick; só registra no relatório se as issues `[daily-review]`
aparecerem na classificação.

### 7. Review de PR individual (cron separado — NÃO por tick, #6865)

`continuo-pr-review.sh` roda em cron próprio — a cadência NÃO vive nesta
prosa: derivar com `hermes cron list --all` (#6928; já foi registrada
errada aqui duas vezes) — com **assinatura
Anthropic** (Sonnet) — review de TODA PR aberta no repo, exceto `bot/*`
(escopo ampliado além de `continuo/*` no #7446 item 4; #7242 já havia
corrigido a prosa de "1 PR por vez" para "todas as PRs elegíveis abertas por
execução" — o loop sempre iterou todas, nunca uma só), não o
diff acumulado do dia (papel distinto do #6). Existe pra dar ao contínuo
um revisor externo separado do tick, já que o contínuo é impedido de
mergear a própria PR (#6864) e o review diário sozinho deixava PRs
esperando até ~1 dia (#6849/#6864/#6865). O descompasso "12:1" que
entrou nesta prosa e no script era derivado de cadências erradas —
corrigido no #6928, e o motivo do script não depende da razão. Posta comentário de
review no formato que `check-pr-review-authenticity.ts` reconhece como
`independent-review` (#6732) — um review de verdade, de uma sessão
distinta da que abriu a PR, então o formato reconhecido passa a
corresponder a um dispatch real, não a texto auto-declarado pela
delegação (#6849). **Autoridade de merge desde #6926** (esta seção dizia
"NUNCA mergeia" — desatualizado; ver tabela da seção "Ferramentas desta
skill" acima e `scripts/lib/continuo-merge-gate.ts` para os 8 portões
fail-closed que decidem `merge`/`escalate`/`reject`). `escalate` labela a PR
(`continuo-escalado`) e notifica só na 1ª vez que ela escala (#7446 item 2)
— o pickup do `/diaria-overnight` (seção 3, passo 3, #6823) e a revisão
humana continuam sendo os dois caminhos que resolvem uma PR escalada.

## Relatório de tick (formato inalterado)

```
## Tick HH:MM
### Trabalhado
### Pendente para próximo tick
### Decisões/bloqueios registrados
### Parada
### Perguntas (se houver)
```

Relatório de uma linha quando não houver trabalho — nunca reimprimir backlog
inteiro/git status/worktree list se normal (pitfall do ciclo 26/08).

## Definição de sucesso do ciclo (critério do editor, 23/08, inalterado)

O ciclo termina quando NÃO existir issue aberta elegível — fila vazia de
implementáveis, com as `precisa-resposta` perguntadas e os bloqueios
registrados. Refactors multi-batch: terminou um batch, inicia o próximo NO
MESMO ciclo enquanto houver orçamento.

## Pitfalls herdados (ver references/)

- `subagent-mcp-drain-20260828.md` (references/) — drain subagente MCP (#6465, epic #6464): lote 5-10 (#6496), anti-fabricação (verificar `.jsonl` + manifest, NÃO confiar só em EXIT=0), dedup obrigatório (`subscriber_id` + `(sub, url_hash, clicked_at)`) devido a duplicados em fronteiras de página, fonte única Helios/Neo (`data/beehiiv-backup/subscriber-engagement/` — `.worktrees/agent-*` NÃO sincronizam automaticamente), claim hygiene (`--kind continuo`).
- `tick-20260828-claim-collision-and-subagent.md` (references/) — aprendizados operacionais do tick 21:05 BRT 28/08: claim colisão `continuo` vs `develop` (sessão stale não bloqueia claim ativo) + delegação de drain a subagente + detecção de claim obsoleto.
- Rotação de modelo do Hermes (v0.4 §rotação): OBSOLETA para implementação —
  o fallback de modelo agora vive no wrapper. Mantida só para o modelo que o
  próprio Hermes usa para orquestrar/relatar.
- `tick-truncation-error-6847.md` (references/) — `Response truncated due to
  output length limit` pode estar mentindo: 2 causas indistinguíveis no log
  atual (truncagem real vs. provedor derrubando o stream). Até a lacuna de
  observabilidade do #6847 fechar: não tratar como "diminua o output" por
  padrão — checar se o tick seguinte com o mesmo job reproduz (a favor de
  truncagem real) ou não (a favor de instabilidade transitória de provedor).

## Changelog

Histórico completo (versão a versão, narrativa de incidente + rationale de
cada mudança) movido para `references/changelog.md` (#6712 Parte B,
02/09/2026) — este SKILL.md manteria só narrativa histórica sem instrução
nova em cada entrada, e é exatamente esse tipo de conteúdo (documenta o
PORQUÊ, não o COMO de rodar um tick) que o teto de tamanho pede pra tirar
daqui. `version:` no frontmatter no topo deste arquivo é a versão corrente;
`references/changelog.md` explica como se chegou até ela.
