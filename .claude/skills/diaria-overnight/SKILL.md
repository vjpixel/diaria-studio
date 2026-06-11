---
name: diaria-overnight
description: Assume o turno no fim do dia (#2021) — varre as issues abertas, faz briefing interativo com o editor antes dele sair, e resolve a fila autonomamente até esgotá-la (PR → CI → auto-merge), com code-review consolidado pós-rodada (#2039). Ao final, deixa rascunho de relatório no Gmail + resumo no terminal. Uso — `/diaria-overnight [--dry-run]`.
disable-model-invocation: true
---

# /diaria-overnight

O editor invoca esta skill ao encerrar o expediente. Você assume o turno: varre a fila de issues do GitHub, tira todas as dúvidas com o editor **antes** dele sair (briefing único), e depois trabalha a fila de forma 100% autônoma **até esgotá-la** (#2039 — sem deadline de tempo). Ao final, roda um code-review consolidado do diff da noite e compila o relatório (rascunho no Gmail + resumo no terminal).

Escopo = **resolver issues de código/config/docs do repo**. Fora de escopo: executar a pipeline editorial (pesquisa, escrita, publicação de edição) — mudanças em código de publishers/Workers SÃO elegíveis, mas *disparar* publicação não.

Esta skill só roda por invocação explícita do editor (`disable-model-invocation: true`) — o blast radius (merges autônomos em master) exige que a invocação seja o consentimento, mesmo padrão de `/diaria-remover-votos-pixel`.

## Argumentos

- `--dry-run` (opcional) — executa só a Fase 0 **sem nenhum side-effect externo** (não comenta em issues, não mexe em PRs) e imprime o plano. Serve de ensaio seguro.

## Fase 0 — Varredura + briefing interativo (editor ainda presente)

O objetivo é converter o máximo da fila em trabalho autônomo enquanto o editor ainda está aí pra responder. **Depois desta fase, zero interação.**

0. **Resume**: se `data/overnight/{AAMMDD}/plan.json` de hoje já existe, **pular o briefing** — retomar a partir dos status do próprio `plan.json`: issues sem status terminal → Fase 1; todas terminais mas cadeia da Fase 1.5 não concluída → **Fase 1.5** (retomada no nível `findings_depth` atual: se `findings_depth == 0` e `review` é null ou ausente → review inicial; se `findings_depth > 0` e há issues `finding-depth-{N}` sem status terminal → mini-rodada em andamento; se `review` do nível atual está em `"done (depth {N})"` e ainda há nível pendente → continuar cadeia); cadeia concluída (último nível gravou `"done (depth ...)"` e `findings_depth` não avançaria mais) → Fase 2. Nunca re-perguntar o que já foi respondido. plan.json antigo sem `base_sha` → derivar do primeiro merge da rodada (`git log --reverse --format=%H --since="{started_at}" | head -1`, usar o pai dele) ou, falhando, pular a Fase 1.5 com warning no relatório.
1. **Sync**: `git checkout master && git pull` (o coordenador pode estar em outra branch — pull na branch errada faria os worktrees forkarem de HEAD não-master e os PRs da noite carregarem diff alheio). **Capturar `base_sha = git rev-parse HEAD` AGORA (pós-pull)** — é o ponto de partida do diff consolidado da Fase 1.5; capturado antes do pull, o diff incluiria commits alheios. Verificar `gh auth status`.
2. **PRs abertos remanescentes**: listar PRs abertos. Auto-resolver **só os de autoria desta skill** (branch prefix `overnight/`): CI verde e não-draft → merge (fluxo da Fase 1, passo 3). Qualquer outro PR aberto (bot, WIP do editor, draft de noite anterior) → vira pergunta no briefing; **nunca** auto-mergear PR que a skill não criou.
3. **Varredura**: `gh issue list --state open --limit 200 --json number,title,labels,body,url`.
4. **Classificar cada issue** em:
   - `elegivel` — direção clara e completa na issue; dá pra resolver sem perguntar nada. Issue sem label de prioridade → tratar como `P2` e anotar no plano (não inventar prioridade alta nem descartar).
   - `precisa-resposta` — ambiguidade que bloquearia autonomia: decisão editorial/produto, trade-off real entre opções equivalentes, direção não documentada, escolha de abordagem com impacto em usuário final.
   - `bloqueada-externa` — precisa de ação que só o editor pode fazer (conta de terceiro, allowlist, credencial). Comentar na issue o que falta e pular (com dedup: checar antes se já existe comentário overnight equivalente — não comentar de novo).
   - `not-this-week` / `fora-do-escopo` — labels ou critério explícito que exclui da rodada.
4.5. **Tabela da fila completa** — imprimir ANTES do briefing, para o editor ver o escopo inteiro da noite e poder resgatar exclusões imediatamente:

   **Entram na rodada** (elegível + precisa-resposta), ordenadas P0 > P1 > P2 > P3:
   ```
   #NNNN | P?  | elegivel / precisa-resposta | título resumido
   ```

   **Ficam de fora**, com motivo explícito por issue:
   ```
   #NNNN | P?  | motivo                                         | título resumido
   ```
   Motivos possíveis: `not-this-week`, `external-blocker: {o que falta destravar}`, `dados imaturos até {data}`, `fora do escopo overnight`, `ambígua: {o que falta na direção}`. Usar o motivo mais específico — nunca só "pulada". Se o editor discordar de uma exclusão (ex: um `not-this-week` que já venceu), ele responde antes do briefing e a issue é promovida para `precisa-resposta` ou `elegivel` na hora.

5. **Briefing**: para as `precisa-resposta`, fazer **todas** as perguntas de uma vez via `AskUserQuestion`, agrupadas por issue (máximo 4 perguntas por chamada e 4 opções por pergunta; header = `#NNNN`). Cada pergunta oferece opções concretas + trade-off, **e sempre inclui a opção "decido depois (pular esta issue)"**. AskUserQuestion é bloqueante — não existe "detectar que o editor não respondeu"; o briefing pressupõe editor presente (limitação documentada: se ele sair no meio, a pergunta fica pendente até ele voltar). Issue respondida → promover a `elegivel` e **postar a resposta como comentário na issue** (`gh issue comment`) — é a fonte durável, visível de qualquer máquina/sessão; `plan.json` é cache. "Decido depois" → status `pulada` (sem comentário — a issue não foi prometida).
6. **Agrupamento em lotes (#2024)**: agrupar as `elegivel` em **lotes coesos** — mesmo subsistema/arquivos, mesma natureza (ex: "DS/email", "playbooks Stage 4", "validator"). Critérios: o lote inteiro cabe numa revisão de diff única; nenhuma issue do lote conflita com outra; **≤4 issues ou ~300 linhas de diff estimadas por lote**. Issues grandes/arriscadas (P1, blast radius alto, migrações) ficam **solo** — o batching é só pras pequenas. Cada lote vira 1 PR (`Closes #A, closes #B, ...`); como o merge fecha todas as issues do lote, o review leve do coordenador confere que o diff cobre de fato **todas** elas.
7. **Plano da rodada**: gravar em `data/overnight/{AAMMDD}/plan.json`. **`{AAMMDD}` = data local de início da rodada, fixada AQUI e relida de `plan.json` em todas as fases seguintes — nunca recomputada de today()** (toda rodada cruza a meia-noite).
   ```json
   {
     "started_at": "ISO", "base_sha": "a67520a3f...", "review": null,
     "rescans_done": 0, "findings_depth": 0,
     "issues": [{ "number": 123, "priority": "P1", "status": "elegivel", "batch": "ds-email | null (solo)", "pr": null, "briefing": "resposta do editor, se houve", "source": "initial | mid-round | finding-depth-1 | finding-depth-2" }]
   }
   ```
   `base_sha` = o hash REAL capturado no passo 1 (nunca texto descritivo). `review` é atualizado pela Fase 1.5 (`null` → `"done"` / `"skipped: {motivo}"`). `pr` recebe o número do PR no desfecho da issue (Fase 1 passo 5) — é a fonte pós-compaction do relatório. `rescans_done` conta quantos re-scans de issues novas já ocorreram após esgotar a fila (incrementado a cada re-scan, capped em K=2). `findings_depth` registra o nível atual da cadeia de re-entrada de findings (0 = fila principal, 1 = mini-rodada 1 pós-1.5, 2 = mini-rodada 2 pós-1.5b; nunca excede 2). `source` indica a origem de cada issue no plano: `initial` (varredura Fase 0), `mid-round` (nova durante a Fase 1), `finding-depth-1` ou `finding-depth-2` (criada como `overnight-finding` e re-entrou). Status possíveis: `elegivel`, `pulada` (motivo: `sem-resposta` | `bloqueio-externo` | `ambigua` | `not-this-week` | `fora-do-escopo` | `rescan-limit`), e os terminais da Fase 1: `mergeada`, `draft-ci-vermelho`.
8. Confirmar o plano com o editor (a tabela completa já foi impressa no passo 4.5; aqui confirmar os lotes formados e pedir ok final antes de entrar na Fase 1). **Se 0 elegíveis, dizer isso agora e encerrar aqui** — é a última chance do editor destravar algo respondendo mais perguntas; não rodar uma noite vazia. Com `--dry-run`, parar aqui (sem comentários postados).

## Fase 1 — Loop de resolução

Uma **unidade de trabalho** (issue solo ou lote, #2024) por vez, sempre a de maior prioridade (P0 > P1 > P2 > P3 — prioridade do lote = a mais alta entre suas issues; empate → número menor = mais antiga). **No início de cada iteração, reler `plan.json`** — após compaction de contexto, ele é a única fonte confiável do briefing e dos status. A cada iteração:

1. **Re-checar a fila**: `gh issue list --state open --limit 200 --json number,title,labels,state` (sem `body` — corpo só de issues novas, via `gh issue view {N} --json body`; o coordenador precisa ficar enxuto). Issue fechada externamente → marcar `pulada` no plano e não trabalhar. **Issues novas criadas durante a rodada** (qualquer prioridade, qualquer autor — humano ou automação) com direção clara no corpo entram como `elegivel` com `source: "mid-round"`, com as seguintes exceções: (a) issue ambígua → postar comentário explicando o que falta na direção + status `pulada` motivo `ambigua`; (b) issue com label `external-blocker` ou `not-this-week` → `pulada` com motivo correspondente; (c) issue com label `overnight-finding` da própria rodada → **não entra agora** (fluxo da Fase 1.5 cuida da re-entrada controlada com depth limit). **Guard de convergência** (K=2): cada vez que a fila elegível é esgotada (sem itens pendentes), fazer um re-scan para capturar issues novas e incrementar `rescans_done` em `plan.json`. Após o 2º re-scan (`rescans_done == 2`), novas issues encontradas ficam para a próxima rodada mesmo com direção clara — registrar motivo `rescan-limit` no plano e encerrar a Fase 1 sem aceitar mais novatas. **Só issues sem status terminal no `plan.json` são candidatas** — uma issue que já virou `draft-ci-vermelho` ou `pulada` nunca é re-escolhida na mesma rodada (anti-livelock). **Guard de colisão com a manhã**: se uma edição diária estiver em curso (`npx tsx scripts/lib/find-current-edition.ts` retorna candidato ou `data/editions/` de hoje/amanhã ganhou arquivos novos), encerrar a Fase 1 após a unidade corrente e ir pra 1.5/relatório — a pipeline editorial tem precedência.
2. **Dispatchar um subagente por unidade de trabalho** — issue solo ou lote inteiro (#2024) — (`Agent`, `subagent_type: "general-purpose"`, `isolation: "worktree"` — nunca um agente especializado do repo: eles têm toolset restrito e não conseguem commitar/pushar). O prompt do subagente inclui, obrigatoriamente:
   - corpo de TODAS as issues da unidade + respostas do briefing (lidas de `plan.json`);
   - regras do repo: #633 (bugfix exige teste de regressão), convenções de commit/PR do CLAUDE.md;
   - **guard de publicação**: editar código de publisher é ok; **EXECUTAR é proibido** — nunca rodar `scripts/publish-*`, `clarice-schedule-sends`, `clarice-import-*`, `close-poll`, `inject-poll-sig` ou qualquer script que toque Beehiiv/LinkedIn/Facebook/Brevo ao vivo, nem em "teste";
   - bootstrap do worktree: **primeiro passo é `npm ci`** (worktree novo não tem `node_modules/` nem a junction `data/`); testes = **`npm test`** (inclui o pretest guard #1948);
   - **self-review obrigatório antes de retornar (#2038)**: após o `gh pr create`, o subagente faz UMA passada adversarial no próprio `git diff` contra a(s) issue(s) + briefing, checando: o diff cobre TODOS os pontos da issue (não só os fáceis)? Sobrou referência órfã de refactor (grep pelos símbolos renomeados)? O arquivo carrega (`npx tsc --noEmit` se coberto pelo tsconfig, senão import smoke via tsx)? O cenário REAL da issue tem teste (não só a aritmética adjacente)? Findings → **fixes imediatos no mesmo branch + re-push** (não comentários); finding grande demais → comentário inline no PR pro coordenador decidir. Racional empírico (260610): 4 bugs confirmados invisíveis pro `npm test` foram pegos por esse tipo de passada, incluindo um `ReferenceError` que nem typecheckava.
   - **se um hook pós-`gh pr create` exigir code-review multi-agente, NÃO executar** — o self-review acima é a resposta; anotar no body do PR e retornar (subagente não pode dispatchar Agent, #207; o review pesado roda UMA vez, consolidado, na Fase 1.5).
   O subagente implementa, roda `npm test`, commita em branch **`overnight/fix-NNNN`** (solo) ou **`overnight/batch-{slug}`** (lote) com `(#NNNN)` / `(#A, #B, ...)` no título, push, abre PR com `Closes #NNNN` (um `closes` por issue do lote), faz o self-review, e retorna: o número do PR **+ a linha "self-review: N findings, M corrigidos"** — o coordenador usa isso no review leve (0 findings em diff não-trivial é sinal de passada rasa, não de perfeição).
3. **Revisar, esperar CI e mergear** (coordenador, nunca o subagente):
   - **Review leve antes do merge**: ler o diff do PR (`gh pr diff {N}`) e sanity-checkar contra a issue + briefing — substitui o review pesado pulado pelo subagente; se o diff parecer errado, tratar como CI vermelho (tentativa de fix).
   - Esperar CI com `gh pr checks {N} --watch` em background (`run_in_background: true`) — um acordar por PR, sem poll. Interpretar com cuidado: **exit 8 / checks pendentes / lista vazia = PENDENTE, nunca verde nem vermelho** (logo após o push os jobs podem nem estar registrados). Verde = os checks do CI **presentes E concluídos com sucesso**. **O gate é um passo SEPARADO do merge (#2031 — incidente 260610: merge encadeado com `&&` após o output dos buckets passou com check vermelho):** NUNCA encadear `gh pr merge` na mesma chamada Bash que imprime os checks. Gate determinístico: `gh pr checks {N} --json bucket --jq '[.[] | select(.bucket != "pass")] | length'` deve retornar `0` (cobre fail/pending/skipping de uma vez); só então, em chamada própria, o merge. master não tem branch protection — o único guard é esta disciplina. Bônus do incidente: subagente que tocar `.claude/agents/orchestrator-*.md` deve rodar `NODE_TEST_SNAPSHOTS=1 npx tsx --test test/orchestrator-prompt.test.ts` (snapshot + budget de linhas, #634) antes do push.
   - Verde → `gh pr merge {N} --squash --subject "{título} (#NNNN)" --body "...\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>"` — **sem `--delete-branch`** (a branch está checked out no worktree do subagente; a deleção local falharia e o exit non-zero seria lido como merge falho). **Confirmar o estado real via `gh pr view {N} --json state,mergedAt` SEMPRE — inclusive (principalmente) quando `gh pr merge` retornar erro** (#573): merge remoto pode ter sucedido com falha local. Depois: limpar o worktree do subagente (`git worktree prune` + remover diretório) e deletar a branch remota (`git push origin --delete overnight/fix-NNNN`).
   - Vermelho (de verdade) → até **2 tentativas de fix**: continuar o mesmo subagente via `SendMessage` com o **tail do log de falha** (`gh run view --log-failed`, últimas ~100 linhas por step — nunca o log inteiro); se o subagente não estiver mais disponível (ou `SendMessage` não existir no harness), dispatchar um novo **fazendo checkout da branch existente** (nunca refazer de master). Num **lote**: se a falha é atribuível a uma issue específica, a tentativa 2 pode **remover o item problemático do lote** (revert das mudanças dele + re-push), comentando na issue removida o diagnóstico — o resto do lote segue. Persistiu vermelho → converter pra draft (`gh pr ready --undo`), comentar na(s) issue(s) com diagnóstico + link, marcar `draft-ci-vermelho` no plano, e seguir pra próxima.
4. **Manter #636**: nunca 2 PRs não-draft abertos simultaneamente; o próximo só começa depois do desfecho do anterior. Drafts de CI-vermelho ficam abertos para triage do editor — são exceção consciente, sinalizados no relatório.
5. **Atualizar `plan.json`** com o status terminal **e o número do PR** (campo `pr`) da unidade, e **logar a iteração** via `npx tsx scripts/log-event.ts` (run-log canônico, `agent: "overnight"`, edition = AAMMDD da rodada) — assim `/diaria-log` enxerga a noite.
6. `git pull` em master após cada merge, antes da próxima issue.

**Condições de parada:** fila elegível esgotada → **Fase 1.5**. Erro irrecuperável (auth do gh expirada, rede fora por > 30 min) → se houver PR em CI em voo, levá-lo até merge/draft se possível (senão, comentar o estado na issue); renderizar halt banner (`npx tsx scripts/render-halt-banner.ts --stage "overnight" --reason "..." --action "..."`) + relatório antecipado com o motivo, **pulando a Fase 1.5** (estado pode estar inconsistente).

## Fase 1.5 — Code-review consolidado pós-rodada (#2039)

A Fase 1.5 segue a cadeia de re-entrada com **depth limit = 2**, garantindo terminação. Cadeia máxima: Fase 1.5 → mini-rodada 1 → Fase 1.5b → mini-rodada 2 → Fase 1.5c → fim. `findings_depth` em `plan.json` rastreia em qual nível estamos (0 = review inicial, 1 = review pós-mini-rodada 1, 2 = review pós-mini-rodada 2).

**Passo 1.5 — Review consolidado** (roda sempre que `findings_depth` avança para este nível):

Com a fila esgotada (sem PR **não-draft** aberto — drafts de CI-vermelho não bloqueiam esta fase e ficam FORA do diff consolidado, pois não mergearam), rodar **UM** code-review pesado sobre o **diff acumulado**. No `findings_depth == 0` (review inicial): diff = `{base_sha}..HEAD`. Nos níveis subsequentes (1.5b, 1.5c): diff = do último merge da mini-rodada anterior até HEAD. Forma executável: invocar a skill built-in via Skill tool com `args: "max {sha_range}"` (**sem `--comment`** — não há PR aberto pra ancorar threads; os findings retornam à conversa e a triagem abaixo é o destino deles). Se a skill não aceitar o range como target, fallback: `git diff {sha_range} > data/overnight/{AAMMDD}/night-diff-d{N}.patch` e passar o path. O `base_sha` vem de `plan.json`. É a rede pós-merge — 1 review consolidado custa uma fração de N por PR e enxerga interações ENTRE os PRs da mesma janela (nota: o diff inclui também merges alheios — findings sobre código alheio viram issue, nunca hotfix). Esta fase é **read-only + filing**: nenhum PR novo de feature.

Saídas explícitas: diff vazio ou < ~50 linhas → **pular** com `review: "skipped: diff trivial (depth {N})"` no plan.json + nota no relatório (o review leve por PR já cobriu). Zero findings → registrar "review rodou, 0 findings (depth {N})" (silêncio é indistinguível de não-rodou). Review falhou (Agent indisponível, timeout) → NÃO stall (#738): logar warn, `review: "skipped: {erro} (depth {N})"`, seguir pra Fase 2.

Triagem dos findings:
- **Crítico em produção** (corrupção de dado, publicação quebrada, master vermelho — confirmado deterministicamente, ex: `gh run list --branch master --limit 1`, nunca só pelo texto do finding, #573) → **hotfix imediato** seguindo o fluxo COMPLETO da Fase 1 passos 2–3 (subagente em worktree, `npm test`, regressão #633 quando bugfix, branch `overnight/hotfix-*`, CI + gate determinístico #2031, verify #573). A exceção é só ao "nenhum PR novo" — **nunca ao processo**.
- Demais findings → **issues filadas** seguindo o protocolo do auto-reporter (`.claude/agents/auto-reporter.md` + `scripts/lib/auto-reporter-dedup.ts`: dedup via `gh search issues` com fallback gracioso, labels tipo + prioridade), com label extra **`overnight-finding`** e corpo citando o PR de origem do diff.
- **Re-entrada de findings** (depth limit = 2): após filar as issues, verificar `findings_depth` em `plan.json`:
  - Se `findings_depth == 0` (review inicial, 1.5): issues `overnight-finding` com direção clara → registrar com `source: "finding-depth-1"`, incrementar `findings_depth` para 1, e **rodar mini-rodada 1** (fluxo completo da Fase 1 para essas issues, depois voltar a este passo — será o review 1.5b).
  - Se `findings_depth == 1` (review pós-mini-rodada 1, 1.5b): issues `overnight-finding` com direção clara → registrar com `source: "finding-depth-2"`, incrementar `findings_depth` para 2, e **rodar mini-rodada 2** (fluxo completo da Fase 1, depois voltar — será o review 1.5c).
  - Se `findings_depth == 2` (review pós-mini-rodada 2, 1.5c): issues `overnight-finding` com direção clara **não re-entram** — ficam para a próxima rodada. **Esta é a condição de parada garantida da cadeia.** Registrar no relatório "findings da 1.5c ficam para próxima rodada".
  - Issues `overnight-finding` ambíguas (qualquer nível): postar comentário explicando o que falta + `pulada` motivo `ambigua`.
- Ao final de cada nível: gravar `review: "done (depth {N})"` (+ contagem de findings/issues) no `plan.json` — é o que torna a fase idempotente no resume. Tudo listado nas seções de findings do relatório (Fase 2).

## Fase 2 — Relatório

1. Compilar o digest da noite a partir de `plan.json` + run-log (filtrado por `agent: "overnight"` + AAMMDD da rodada), **agrupado por PR** (lotes listam suas issues juntas):
   - resolvidas (com links de PR e commits de merge — estados confirmados via `gh pr view`, nunca de memória),
   - puladas e por quê (sem briefing, bloqueio externo, CI vermelho persistente — com link do draft),
   - **entraram mid-round**: issues com `source: "mid-round"` incorporadas durante a Fase 1 (número, título, PR de resolução ou motivo de exclusão),
   - **review noturno + mini-rodada(s) de findings**: hotfixes críticos aplicados (se houver) + cadeia completa com PRs — para cada nível ativo (1.5 → mini-1 → 1.5b → mini-2 → 1.5c): findings identificados, issues filadas, issues resolvidas na mini-rodada, issues que não re-entraram (depth-limit ou ambíguas); se a cadeia terminou antes de depth 2 (nenhum finding na 1.5b ou 1.5c), indicar em qual nível parou,
   - estado final da fila (`gh issue list` fresco).
2. Salvar em `data/overnight/{AAMMDD}/report.md` (AAMMDD do `plan.json`, não recomputado).
3. Criar **rascunho** no Gmail via MCP `create_draft` para `vjpixel@gmail.com`, subject `Diar.ia overnight {AAMMDD} — {X} resolvidas, {Y} puladas, {Z} findings` (omitir `{Z} findings` se o review não rodou; acrescentar `+ hotfix` se houve). **Atenção à semântica: `create_draft` NÃO envia** — o rascunho fica em Drafts, sem notificação. O canal primário do relatório é o **resumo no terminal** (passo 5); o draft é cópia formatada pra arquivo/encaminhamento.
4. **Fail-soft**: Gmail MCP indisponível → NÃO travar. Esta é uma exceção consciente e local ao #738 (que protege stages de edição em andamento): aqui não há pipeline pra corromper e ninguém presente pra responder ao halt — avisar no terminal que o relatório ficou só local e encerrar normalmente. Não citar esta exceção como precedente fora do relatório overnight.
5. Imprimir o resumo no terminal — é a primeira coisa que o editor vê ao voltar.

## Regras

- **Nunca** disparar publicação (Beehiiv/LinkedIn/Facebook/Brevo) ou rodar stages da pipeline editorial durante a rodada — e o guard vai **dentro do prompt de cada subagente**, não só aqui.
- #636 (1 PR por vez), #633 (teste de regressão em bugfix) e validação determinística de estado externo (#573) valem a noite inteira, sem exceção.
- Toda issue **trabalhada ou bloqueada** recebe comentário com o que foi feito ou o que falta (com dedup — nunca repetir comentário equivalente). Issues resolvidas dispensam comentário extra: o merge com `Closes #NNNN` já conta a história na timeline.
- `data/overnight/` segue o blanket gitignore de `data/` — relatórios não vão pro repo.
- Stall passivo é inaceitável: toda espera usa `gh pr checks --watch` em background ou poll com intervalo explícito. Timeout por espera de CI = **30 min**; estourou → tratar como CI vermelho (tentativa de fix/draft), nunca esperar indefinidamente.
