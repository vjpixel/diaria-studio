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

> **REGRA INVARIÁVEL — ZERO PERGUNTAS PÓS-BRIEFING:** Toda interação com o editor acontece **exclusivamente** nesta Fase 0. Depois do briefing, nenhum `AskUserQuestion` em nenhuma fase (Fase 1, re-scans, mini-rodadas, reviews). Issue ou finding ambíguo surgido mid-round → status `pulada` + comentário na issue explicando exatamente qual decisão falta (vira pergunta do briefing da **próxima** rodada). Vale mesmo que o editor pareça online: a rodada não pode depender de presença. Única exceção: o editor intervém por iniciativa própria (mensagem no terminal) — responder a ele não é "fazer pergunta", mas a rodada segue sem aguardar follow-up.

0. **Resume**: se `data/overnight/{AAMMDD}/plan.json` de hoje já existe, **pular o briefing** — retomar a partir dos status do próprio `plan.json` usando a tabela de estados abaixo:

   | `findings_depth` | `review` do nível atual | Próxima ação |
   |---|---|---|
   | qualquer | issues sem status terminal existem | → Fase 1 (retomar issues pendentes) |
   | 0 | null ou ausente | → Fase 1.5 (review inicial) |
   | **0** | `"done (depth 0)"` ou começa com `"skipped:"` | → **Fase 2** (cadeia concluída — zero findings ou review pulado) |
   | N > 0 | null ou ausente, e há issues `finding-depth-N` sem status terminal | → continuar mini-rodada N (Fase 1 para essas issues) |
   | N > 0 | null ou ausente, sem issues `finding-depth-N` pendentes | → Fase 1.5 no nível N (iniciar review) |
   | **1** | `"done (depth 1)"` ou começa com `"skipped:"` | → verificar `review_1_5b_has_p2`: se `true` (review 1.5b encontrou ≥1 finding P2+) → mini-rodada 2; se `false` ou ausente → **Fase 2** (findings do 1.5b filados para próxima rodada) |
   | **2** | `"done (depth 2)"` ou começa com `"skipped:"` | → **Fase 2** (cadeia concluída — depth limit atingido) |

   **Compatibilidade de legado:** `review: "done"` (formato de plan.json anterior a este PR, sem `depth`) → tratar como `"done (depth {findings_depth})"` — cadeia concluída no nível corrente. `review_1_5b_has_p2` ausente em plan.json legado → tratar como `false` (encerra). Nunca re-perguntar o que já foi respondido. plan.json antigo sem `base_sha` → derivar do primeiro merge da rodada (`git log --reverse --format=%H --since="{started_at}" | head -1`, usar o pai dele) ou, falhando, pular a Fase 1.5 com warning no relatório.
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
   Motivos possíveis: `not-this-week`, `bloqueio-externo: {o que falta destravar}`, `dados imaturos até {data}`, `fora do escopo overnight`, `ambígua: {o que falta na direção}`. Usar o motivo mais específico — nunca só "pulada". Após imprimir a tabela, fazer **uma** `AskUserQuestion` com: "Alguma issue excluída deve entrar na rodada? Responda com os números das issues (ex: #1234, #5678) ou 'ok' para prosseguir." — resposta recebida antes do briefing; issues citadas são promovidas para `precisa-resposta` (ou `elegivel` se não há dúvida). Esta pergunta e o briefing do passo 5 podem ser combinados numa única `AskUserQuestion` se houver perguntas de `precisa-resposta` simultaneamente.

5. **Briefing**: para as `precisa-resposta`, fazer **todas** as perguntas de uma vez via `AskUserQuestion`, agrupadas por issue (máximo 4 perguntas por chamada e 4 opções por pergunta; header = `#NNNN`). Cada pergunta oferece opções concretas + trade-off, **e sempre inclui a opção "decido depois (pular esta issue)"**. AskUserQuestion é bloqueante — não existe "detectar que o editor não respondeu"; o briefing pressupõe editor presente (limitação documentada: se ele sair no meio, a pergunta fica pendente até ele voltar). Issue respondida → promover a `elegivel` e **postar a resposta como comentário na issue** (`gh issue comment`) — é a fonte durável, visível de qualquer máquina/sessão; `plan.json` é cache. "Decido depois" → status `pulada` (sem comentário — a issue não foi prometida).

   **Pergunta padrão de loop estendido** (incluir ao final do briefing, ou como pergunta isolada quando não há `precisa-resposta`): "Incluir toda a fila desbloqueada nesta rodada? s/n". Se `s`: ativar modo loop estendido — após esgotar a fila do briefing, varrer TODA a fila open sem bloqueio (inclui analyses, scopings com direção clara, P3s, issues que entrariam como `mid-round`); **gravar `loop_estendido: true` em `plan.json` imediatamente** (antes de prosseguir). Se `n` (default): rodada limitada à fila do briefing + issues `mid-round` com direção clara que aparecerem naturalmente; gravar `loop_estendido: false` em `plan.json`. **Racional:** o loop estendido — não o depth-2 — é o principal fator de duração da rodada (rodada 260611: 47 issues / ~16h com loop estendido ativo). O briefing é o único momento de opt-in.
6. **Agrupamento em lotes (#2024)**: agrupar as `elegivel` em **lotes coesos** — mesmo subsistema/arquivos, mesma natureza (ex: "DS/email", "playbooks Stage 4", "validator"). Critérios: o lote inteiro cabe numa revisão de diff única; nenhuma issue do lote conflita com outra; **≤4 issues ou ~300 linhas de diff estimadas por lote**. Issues grandes/arriscadas (P1, blast radius alto, migrações) ficam **solo** — o batching é só pras pequenas. Cada lote vira 1 PR (`Closes #A, closes #B, ...`); como o merge fecha todas as issues do lote, o review leve do coordenador confere que o diff cobre de fato **todas** elas.
7. **Plano da rodada**: gravar em `data/overnight/{AAMMDD}/plan.json`. **`{AAMMDD}` = data local de início da rodada, fixada AQUI e relida de `plan.json` em todas as fases seguintes — nunca recomputada de today()** (toda rodada cruza a meia-noite).
   ```json
   {
     "started_at": "ISO", "base_sha": "a67520a3f...", "review": null,
     "rescans_done": 0, "findings_depth": 0, "review_1_5b_has_p2": false, "loop_estendido": false,
     "issues": [{
       "number": 123, "priority": "P1", "status": "elegivel",
       "batch": "ds-email | null (solo)", "pr": null,
       "briefing": "resposta do editor, se houve",
       "source": "initial | mid-round | finding-depth-1 | finding-depth-2",
       "timeline": {
         "dispatch": "ISO",
         "pr_opened": "ISO",
         "fix_iteration_1": "ISO",
         "fix_iteration_2": "ISO",
         "ci_green": "ISO",
         "merged": "ISO | null",
         "draft": "ISO | null",
         "pulada": "ISO | null"
       }
     }]
   }
   ```
   `base_sha` = o hash REAL capturado no passo 1 (nunca texto descritivo). `review` é atualizado pela Fase 1.5 (`null` → `"done (depth {N})"` / `"skipped: {motivo} (depth {N})"`); plan.json legado pode conter `"done"` (sem depth) — ver tabela do Resume. `review_1_5b_has_p2` é gravado pela Fase 1.5 ao finalizar o review 1.5b (`findings_depth == 1`): `true` se ≥1 finding de severidade P2 ou superior foi identificado; `false` caso contrário. É o guard da tabela do Resume para mini-rodada 2 — ver Regra 2. `pr` recebe o número do PR no desfecho da issue (Fase 1 passo 5) — é a fonte pós-compaction do relatório. `rescans_done` conta quantos re-scans de issues novas já ocorreram após esgotar a fila principal (escopo: fila principal apenas — mini-rodadas da Fase 1.5 rodam com o guard K desligado e nunca incrementam este contador; capped em K=2). `findings_depth` registra o nível atual da cadeia de re-entrada de findings (0 = fila principal, 1 = mini-rodada 1 pós-1.5, 2 = mini-rodada 2 pós-1.5b; nunca excede o depth limit da tabela do passo 0). `source` indica a origem de cada issue no plano: `initial` (varredura Fase 0), `mid-round` (nova durante a Fase 1), `finding-depth-1` ou `finding-depth-2` (criada como `overnight-finding` e re-entrou). Status possíveis: `elegivel`, `pulada` (motivo: `sem-resposta` | `bloqueio-externo` | `ambigua` | `not-this-week` | `fora-do-escopo` | `rescan-limit`), e os terminais da Fase 1: `mergeada`, `draft-ci-vermelho`. `timeline` registra os timestamps ISO por transição de cada unidade — os marcos omitidos ficam ausentes (não null); campo ausente = transição não ocorreu ou rodada anterior ao #2099. Lotes de N issues compartilham o mesmo `timeline` (o coordenador grava no objeto da issue representante — a que tem `dispatch`).
8. Confirmar o plano com o editor (a tabela completa já foi impressa no passo 4.5; aqui confirmar os lotes formados e pedir ok final antes de entrar na Fase 1). **Se 0 elegíveis, dizer isso agora e encerrar aqui** — é a última chance do editor destravar algo respondendo mais perguntas; não rodar uma noite vazia. Com `--dry-run`, parar aqui (sem comentários postados).

## Fase 1 — Loop de resolução

Uma **unidade de trabalho** (issue solo ou lote, #2024) por vez, sempre a de maior prioridade (P0 > P1 > P2 > P3 — prioridade do lote = a mais alta entre suas issues; empate → número menor = mais antiga). **No início de cada iteração, reler `plan.json`** — após compaction de contexto, ele é a única fonte confiável do briefing e dos status. A cada iteração:

1. **Re-checar a fila**: `gh issue list --state open --limit 200 --json number,title,labels,state,createdAt` (sem `body` — corpo só de issues novas, via `gh issue view {N} --json body`; o coordenador precisa ficar enxuto). Issue fechada externamente → marcar `pulada` no plano e não trabalhar. **Issues novas criadas durante a rodada** (qualquer prioridade, qualquer autor — humano ou automação) com direção clara no corpo entram como `elegivel` com `source: "mid-round"`, com as seguintes exceções: (a) issue ambígua → **não** fazer pergunta ao editor; postar comentário explicando o que falta na direção + status `pulada` motivo `ambigua` (a questão vira pergunta do briefing da próxima rodada — Regra 1); (b) issue com label `bloqueio-externo` ou `not-this-week` → `pulada` com motivo correspondente; (c) issue com label `overnight-finding` **e `created_at >= started_at` do `plan.json`** (= gerada pela própria rodada) → **não entra agora** (fluxo da Fase 1.5 cuida da re-entrada controlada com depth limit); issue com label `overnight-finding` mas `created_at < started_at` (= finding de rodada anterior, pendente) → trata como `mid-round` normal. **Guard de convergência** (K=2 — escopo: fila principal apenas, mini-rodadas da Fase 1.5 não incrementam): cada vez que a fila elegível da fila principal é esgotada (sem itens pendentes), fazer um re-scan para capturar issues novas; **aceitar todas as novatas encontradas neste re-scan com direção clara antes de incrementar** `rescans_done`; só então incrementar `rescans_done` em `plan.json`. Quando `rescans_done >= 2` **antes de iniciar** um novo re-scan, não fazer o re-scan — encerrar a Fase 1 registrando motivo `rescan-limit` para novas issues e ir para Fase 1.5. **Só issues sem status terminal no `plan.json` são candidatas** — uma issue que já virou `draft-ci-vermelho` ou `pulada` nunca é re-escolhida na mesma rodada (anti-livelock). **Guard de colisão com a manhã**: se uma edição diária estiver em curso (`npx tsx scripts/lib/find-current-edition.ts` retorna candidato ou `data/editions/` de hoje/amanhã ganhou arquivos novos), encerrar a Fase 1 após a unidade corrente e ir pra 1.5/relatório — a pipeline editorial tem precedência.
2. **Dispatchar um subagente implementador por unidade de trabalho** — issue solo ou lote inteiro (#2024) — (`Agent`, `subagent_type: "general-purpose"`, `isolation: "worktree"` — nunca um agente especializado do repo: eles têm toolset restrito e não conseguem commitar/pushar). O prompt do subagente inclui, obrigatoriamente:
   - corpo de TODAS as issues da unidade + respostas do briefing (lidas de `plan.json`);
   - regras do repo: #633 (bugfix exige teste de regressão), convenções de commit/PR do CLAUDE.md;
   - **guard de publicação**: editar código de publisher é ok; **EXECUTAR é proibido** — nunca rodar `scripts/publish-*`, `clarice-schedule-sends`, `clarice-import-*`, `close-poll` ou qualquer script que toque Beehiiv/LinkedIn/Facebook/Brevo ao vivo, nem em "teste";
   - bootstrap do worktree: **primeiro passo é `npm ci`** (worktree novo não tem `node_modules/` nem a junction `data/`); testes = **`npm test`** (inclui o pretest guard #1948);
   - **self-review obrigatório antes de retornar (#2038) — tratado como ETAPA DE LISTAGEM**: após o `gh pr create`, o subagente faz UMA passada adversarial no próprio `git diff` contra a(s) issue(s) + briefing, checando: o diff cobre TODOS os pontos da issue (não só os fáceis)? Sobrou referência órfã de refactor (grep pelos símbolos renomeados)? O arquivo carrega (`npx tsc --noEmit` se coberto pelo tsconfig, senão import smoke via tsx)? O cenário REAL da issue tem teste (não só a aritmética adjacente)? **O output esperado do self-review são os findings listados — comentários inline no PR são o canal correto** (não fixes imediatos). Finding grande demais para o coordenador aplicar direto → comentário inline no PR detalhando a mudança necessária. Racional empírico (260610/260611): subagentes consistentemente postam findings como comentários em vez de corrigir — em vez de lutar contra o padrão, o fluxo de 2 agentes o codifica. **NUNCA fazer `AskUserQuestion` durante o self-review** — Regra 1.
   - **se um hook pós-`gh pr create` exigir code-review multi-agente, NÃO executar** — o self-review acima é a resposta; anotar no body do PR e retornar (subagente não pode dispatchar Agent, #207; o review pesado roda UMA vez, consolidado, na Fase 1.5).
   O subagente implementa, roda `npm test`, commita em branch **`overnight/fix-NNNN`** (solo) ou **`overnight/batch-{slug}`** (lote) com `(#NNNN)` / `(#A, #B, ...)` no título, push, abre PR com `Closes #NNNN` (um `closes` por issue do lote), faz o self-review listando findings como comentários inline no PR, e retorna: o número do PR **+ a linha "self-review: N findings"** — o coordenador usa isso para decidir se despacha o agente fixer (0 findings em diff não-trivial é sinal de passada rasa, não de perfeição).

   **Ainda dentro deste passo 2 — emissão de timestamp `dispatch`**: imediatamente após dispatchar o subagente (antes de aguardar a resposta), o coordenador registra `timeline.dispatch = now()` na issue (ou nas issues do lote, em todas) em `plan.json`, e emite no run-log:
   ```bash
   npx tsx scripts/log-event.ts --edition {AAMMDD} --agent overnight --level info \
     --message "dispatch" \
     --details '{"unidade": "#NNNN | lote {slug}", "issues": [123, 456], "pr": null}'
   ```
3. **Agente fixer + revisar, esperar CI e mergear** (coordenador, nunca o subagente implementador):

   **Agente fixer (fluxo de 2 agentes por unidade)**: ao receber o retorno do subagente implementador, o coordenador verifica o self-review:
   - **Findings acionáveis (>0)**: dispatchar um segundo agente `general-purpose` no **mesmo branch** com o prompt: "Leia os comentários inline no PR #{N} (branch `{branch_name}` — `overnight/fix-NNNN` para issues solo, `overnight/batch-{slug}` para lotes), aplique cada finding acionável no código, rode `npm test`, e faça re-push. Não abra novo PR — o PR #{N} já existe. Retorne: 'fixer: M findings aplicados, npm test OK/FAIL'". O coordenador substitui `{branch_name}` pelo branch real da unidade antes de dispatchar. Worktree do fixer = mesmo worktree do implementador (checkout da branch existente, não novo worktree).
   - **Findings triviais (≤3 linhas, cosméticos — ex: typo em comentário, espaçamento)**: o coordenador pode aplicar diretamente no worktree do implementador sem dispatchar o fixer.
   - **Zero findings**: prosseguir direto para o review leve + CI.

   **Review leve antes do merge**: ler o diff do PR (`gh pr diff {N}`) e sanity-checkar contra a issue + briefing — substitui o review pesado pulado pelo subagente; se o diff parecer errado, tratar como CI vermelho (tentativa de fix).
   - Ao receber o número do PR do subagente, registrar `timeline.pr_opened = now()` em `plan.json` e emitir:
     ```bash
     npx tsx scripts/log-event.ts --edition {AAMMDD} --agent overnight --level info \
       --message "pr_opened" \
       --details '{"unidade": "#NNNN | lote {slug}", "issues": [123], "pr": {N}}'
     ```
   - Esperar CI com `gh pr checks {N} --watch` em background (`run_in_background: true`) — um acordar por PR, sem poll. Interpretar com cuidado: **exit 8 / checks pendentes / lista vazia = PENDENTE, nunca verde nem vermelho** (logo após o push os jobs podem nem estar registrados). Verde = os checks do CI **presentes E concluídos com sucesso**. **O gate é um passo SEPARADO do merge (#2031 — incidente 260610: merge encadeado com `&&` após o output dos buckets passou com check vermelho):** NUNCA encadear `gh pr merge` na mesma chamada Bash que imprime os checks. Gate determinístico: `gh pr checks {N} --json bucket --jq '[.[] | select(.bucket != "pass")] | length'` deve retornar `0` (cobre fail/pending/skipping de uma vez); só então, em chamada própria, o merge. master não tem branch protection — o único guard é esta disciplina. Bônus do incidente: subagente que tocar `.claude/agents/orchestrator-*.md` deve rodar `NODE_TEST_SNAPSHOTS=1 npx tsx --test test/orchestrator-prompt.test.ts` (snapshot + budget de linhas, #634) antes do push.
   - Verde → registrar `timeline.ci_green = now()` em `plan.json`, depois `gh pr merge {N} --squash --subject "{título} (#NNNN)" --body "...\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>"` — **sem `--delete-branch`** (a branch está checked out no worktree do subagente; a deleção local falharia e o exit non-zero seria lido como merge falho). **Confirmar o estado real via `gh pr view {N} --json state,mergedAt` SEMPRE — inclusive (principalmente) quando `gh pr merge` retornar erro** (#573): merge remoto pode ter sucedido com falha local. Após confirmar merge: registrar `timeline.merged = now()` em `plan.json` e emitir:
     ```bash
     npx tsx scripts/log-event.ts --edition {AAMMDD} --agent overnight --level info \
       --message "merged" \
       --details '{"unidade": "#NNNN | lote {slug}", "issues": [123], "pr": {N}}'
     ```
     Depois: limpar o worktree do subagente (`git worktree prune` + remover diretório) e deletar a branch remota (`git push origin --delete overnight/fix-NNNN`).
   - Vermelho (de verdade) → registrar `timeline.fix_iteration_{K} = now()` (K = 1 ou 2) em `plan.json` e emitir:
     ```bash
     npx tsx scripts/log-event.ts --edition {AAMMDD} --agent overnight --level warn \
       --message "fix_iteration" \
       --details '{"unidade": "#NNNN | lote {slug}", "issues": [123], "pr": {N}, "tentativa": K}'
     ```
     Depois: até **2 tentativas de fix**: continuar o mesmo subagente via `SendMessage` com o **tail do log de falha** (`gh run view --log-failed`, últimas ~100 linhas por step — nunca o log inteiro); se o subagente não estiver mais disponível (ou `SendMessage` não existir no harness), dispatchar um novo **fazendo checkout da branch existente** (nunca refazer de master). Num **lote**: se a falha é atribuível a uma issue específica, a tentativa 2 pode **remover o item problemático do lote** (revert das mudanças dele + re-push), comentando na issue removida o diagnóstico — o resto do lote segue. Persistiu vermelho → registrar `timeline.draft = now()` em `plan.json` e emitir:
     ```bash
     npx tsx scripts/log-event.ts --edition {AAMMDD} --agent overnight --level warn \
       --message "draft" \
       --details '{"unidade": "#NNNN | lote {slug}", "issues": [123], "pr": {N}}'
     ```
     Converter pra draft (`gh pr ready --undo`), comentar na(s) issue(s) com diagnóstico + link, marcar `draft-ci-vermelho` no plano, e seguir pra próxima.
4. **Manter #636**: nunca 2 PRs não-draft abertos simultaneamente; o próximo só começa depois do desfecho do anterior. Drafts de CI-vermelho ficam abertos para triage do editor — são exceção consciente, sinalizados no relatório.
5. **Atualizar `plan.json`** com o status terminal **e o número do PR** (campo `pr`) da unidade. Os eventos de run-log (merged/draft/fix_iteration) são emitidos em tempo real dentro do passo 3 acima; aqui apenas confirmar que `plan.json` foi persistido. Para unidades **puladas** (bloqueio externo, sem-resposta, rescan-limit), gravar `timeline.pulada = now()` em `plan.json` e emitir:
   ```bash
   npx tsx scripts/log-event.ts --edition {AAMMDD} --agent overnight --level info \
     --message "pulada" \
     --details '{"unidade": "#NNNN | lote {slug}", "issues": [123], "motivo": "bloqueio-externo | sem-resposta | ..."}'
   ```
   Assim `/diaria-log` enxerga a noite inteira — desfechos de sucesso, fix-iterations e unidades puladas.
6. `git pull` em master após cada merge, antes da próxima issue.

**Condições de parada:** fila elegível esgotada → **Fase 1.5**. Erro irrecuperável (auth do gh expirada, rede fora por > 30 min) → se houver PR em CI em voo, levá-lo até merge/draft se possível (senão, comentar o estado na issue); renderizar halt banner (`npx tsx scripts/render-halt-banner.ts --stage "overnight" --reason "..." --action "..."`) + relatório antecipado com o motivo, **pulando a Fase 1.5** (estado pode estar inconsistente).

## Fase 1.5 — Code-review consolidado pós-rodada (#2039)

A Fase 1.5 segue a cadeia de re-entrada cuja terminação é garantida pelo depth limit definido na **tabela de estados do passo 0** (Resume). `findings_depth` em `plan.json` rastreia em qual nível estamos (0 = review inicial, 1 = review pós-mini-rodada 1, 2 = review pós-mini-rodada 2); o que fazer em cada nível está nos bullets de "Re-entrada de findings" abaixo, e quando parar está na tabela.

**Passo 1.5 — Review consolidado** (roda sempre que `findings_depth` avança para este nível):

Com a fila esgotada (sem PR **não-draft** aberto — drafts de CI-vermelho não bloqueiam esta fase e ficam FORA do diff consolidado, pois não mergearam), rodar **UM** code-review pesado sobre o **diff acumulado**. No `findings_depth == 0` (review inicial): diff = `{base_sha}..HEAD`. Nos níveis subsequentes (1.5b, 1.5c): diff = do SHA imediatamente antes do início da mini-rodada anterior até HEAD. **Como calcular o SHA base das mini-rodadas:** ao iniciar cada mini-rodada, gravar `minirodada_base_sha_{N}: git rev-parse HEAD` no `plan.json` ANTES de qualquer merge; no review subsequente (1.5b/1.5c), usar esse campo como base. **Fallback quando a mini-rodada não produziu nenhum merge** (todas as issues viraram `draft-ci-vermelho`): diff ficaria vazio ou idêntico ao do review anterior — **pular** com `review: "skipped: diff vazio (mini-rodada {N} sem merges) (depth {N+1})"` no plan.json e nota no relatório (mesmo comportamento do "diff < 50 linhas"). Forma executável: invocar a skill built-in via Skill tool com `args: "max {sha_range}"` (**sem `--comment`** — não há PR aberto pra ancorar threads; os findings retornam à conversa e a triagem abaixo é o destino deles). Se a skill não aceitar o range como target, fallback: `git diff {sha_range} > data/overnight/{AAMMDD}/night-diff-d{N}.patch` e passar o path. O `base_sha` vem de `plan.json`. É a rede pós-merge — 1 review consolidado custa uma fração de N por PR e enxerga interações ENTRE os PRs da mesma janela (nota: o diff inclui também merges alheios — findings sobre código alheio viram issue, nunca hotfix). Esta fase é **read-only + filing**: nenhum PR novo de feature.

Saídas explícitas: diff vazio ou < ~50 linhas (e não foi mini-rodada sem merges — coberto acima) → **pular** com `review: "skipped: diff trivial (depth {N})"` no plan.json + nota no relatório (o review leve por PR já cobriu). Zero findings → registrar `review: "done (depth {N})"` com nota "0 findings" (silêncio é indistinguível de não-rodou). Review falhou (Agent indisponível, timeout) → NÃO stall (#738): logar warn, `review: "skipped: {erro} (depth {N})"`, seguir pra Fase 2.

Triagem dos findings:
- **Crítico em produção** (corrupção de dado, publicação quebrada, master vermelho — confirmado deterministicamente, ex: `gh run list --branch master --limit 1`, nunca só pelo texto do finding, #573) → **hotfix imediato** seguindo o fluxo COMPLETO da Fase 1 passos 2–3 (subagente em worktree, `npm test`, regressão #633 quando bugfix, branch `overnight/hotfix-*`, CI + gate determinístico #2031, verify #573). A exceção é só ao "nenhum PR novo" — **nunca ao processo**.
- Demais findings → **issues filadas** seguindo o protocolo do auto-reporter (`.claude/agents/auto-reporter.md` + `scripts/lib/auto-reporter-dedup.ts`: dedup via `gh search issues` com fallback gracioso, labels tipo + prioridade), com label extra **`overnight-finding`** e corpo citando o PR de origem do diff.
- **Re-entrada de findings** (ver tabela do passo 0 para o depth limit e condição de parada): após filar as issues, verificar `findings_depth` em `plan.json`:
  - Se `findings_depth == 0` (review inicial, 1.5): issues `overnight-finding` com direção clara → registrar com `source: "finding-depth-1"`, gravar `minirodada_base_sha_1: git rev-parse HEAD` no plan.json, incrementar `findings_depth` para 1, e **rodar mini-rodada 1** (fluxo da Fase 1 **fechado sobre essas issues** — `rescans_done` NÃO é incrementado dentro de mini-rodadas; o guard K=2 é exclusivo da fila principal; **timestamps `timeline.*` emitidos normalmente** — os passos 2/3/5 da Fase 1 se aplicam sem modificação dentro das mini-rodadas); depois voltar a este passo — será o review 1.5b.
  - Se `findings_depth == 1` (review pós-mini-rodada 1, 1.5b): classificar os findings por severidade. **Heurística de classificação P2+** (o output do `/code-review` não tem campo de prioridade — o coordenador infere da descrição): finding é P2+ se descreve **corrupção de dado, funcionalidade quebrada, bug de segurança, ou bug que deveria ter sido capturado por #633 mas passou** — style/cleanup/simplificação são P3 por padrão. Em caso de dúvida, o finding é P3 (não ativa mini-rodada extra). **Ordem de escrita obrigatória**: primeiro gravar `review_1_5b_has_p2: true/false` no `plan.json`, **só depois** gravar `review: "done (depth 1)"` — assim uma falha entre os dois writes deixa `review_1_5b_has_p2` escrito mas `review` como null, e o Resume re-executa 1.5b de forma segura (em vez de pular findings com dados perdidos). Se `review_1_5b_has_p2 == true`: issues `overnight-finding` P2+ com direção clara → registrar com `source: "finding-depth-2"`, gravar `minirodada_base_sha_2: git rev-parse HEAD` no plan.json, incrementar `findings_depth` para 2, e **rodar mini-rodada 2** (mesmas restrições: fluxo Fase 1 fechado, sem incremento de `rescans_done`; **timestamps `timeline.*` emitidos normalmente**); depois voltar — será o review 1.5c. Se `review_1_5b_has_p2 == false`: **não rodar mini-rodada 2** — os findings P3 do 1.5b devem ser **filados como issues via o protocolo do auto-reporter** (label `overnight-finding`) antes de ir para Fase 2 — exatamente como os findings da Fase 1.5 nível 0; em seguida registrar `review: "done (depth 1)"` e ir para Fase 2 (o 1.5b é o review final desta noite). Registrar no relatório "cadeia encerrada no depth 1 (nenhum finding P2+ no 1.5b)".
  - Se `findings_depth == 2` (review pós-mini-rodada 2, 1.5c): issues `overnight-finding` com direção clara **não re-entram** — ficam para a próxima rodada (ver tabela do passo 0 — depth limit atingido). Registrar no relatório "findings da 1.5c ficam para próxima rodada".
  - Issues `overnight-finding` ambíguas (qualquer nível): **não fazer pergunta ao editor** — postar comentário explicando o que falta + `pulada` motivo `ambigua` (Regra 1).
- Ao final de cada nível: gravar `review: "done (depth {N})"` (+ contagem de findings/issues) no `plan.json` — é o que torna a fase idempotente no resume. Tudo listado nas seções de findings do relatório (Fase 2).

## Fase 2 — Relatório

1. Compilar o digest da noite a partir de `plan.json` + run-log (filtrado por `agent: "overnight"` + AAMMDD da rodada), **agrupado por PR** (lotes listam suas issues juntas):
   - resolvidas (com links de PR e commits de merge — estados confirmados via `gh pr view`, nunca de memória),
   - puladas e por quê (sem briefing, bloqueio externo, CI vermelho persistente — com link do draft),
   - **entraram mid-round**: issues com `source: "mid-round"` incorporadas durante a Fase 1 (número, título, PR de resolução ou motivo de exclusão),
   - **review noturno + mini-rodada(s) de findings**: hotfixes críticos aplicados (se houver) + cadeia completa com PRs — para cada nível ativo (1.5 → mini-1 → 1.5b → mini-2 → 1.5c): findings identificados, issues filadas, issues resolvidas na mini-rodada, issues que não re-entraram (depth-limit, sem P2+, ou ambíguas); se a cadeia terminou antes do depth limit (1.5b sem P2+, ou depth-2 sem findings), indicar em qual nível parou e o motivo,
   - **Timeline da noite** — gerar com o helper determinístico:
     ```bash
     npx tsx scripts/render-overnight-timeline.ts \
       --plan data/overnight/{AAMMDD}/plan.json
     ```
     O script lê o campo `timeline` de cada issue no `plan.json` e imprime a tabela markdown `unidade | início | fim | duração | fix-iterations` + total da rodada + unidade mais lenta. Degrada graciosamente: issues sem campo `timeline` (rodadas anteriores ao #2099 ou unidades interrompidas) aparecem na tabela com `—` nos campos de horário e duração — a tabela nunca quebra. Esta seção é a fonte primária de observabilidade de tempo; `plan.json` é a fonte do relatório (pós-compaction o run-log pode ser grande),
   - estado final da fila (`gh issue list` fresco).
2. Salvar em `data/overnight/{AAMMDD}/report.md` (AAMMDD do `plan.json`, não recomputado).
3. Criar **rascunho** no Gmail via MCP `create_draft` para `vjpixel@gmail.com`, subject `Diar.ia overnight {AAMMDD} — {X} resolvidas, {Y} puladas, {Z} findings` (omitir `{Z} findings` se o review não rodou; acrescentar `+ hotfix` se houve). **Atenção à semântica: `create_draft` NÃO envia** — o rascunho fica em Drafts, sem notificação. O canal primário do relatório é o **resumo no terminal** (passo 5); o draft é cópia formatada pra arquivo/encaminhamento.
4. **Fail-soft**: Gmail MCP indisponível → NÃO travar. Esta é uma exceção consciente e local ao #738 (que protege stages de edição em andamento): aqui não há pipeline pra corromper e ninguém presente pra responder ao halt — avisar no terminal que o relatório ficou só local e encerrar normalmente. Não citar esta exceção como precedente fora do relatório overnight.
5. Imprimir o resumo no terminal — é a primeira coisa que o editor vê ao voltar.

## Regras

- **NUNCA fazer perguntas ao editor durante a execução (Regra 1 — HARD RULE).** Toda interação com o editor acontece exclusivamente no briefing da Fase 0. Depois do briefing, nenhum `AskUserQuestion` em nenhuma fase (Fase 1, re-scans, mini-rodadas, reviews). Issue ou finding ambíguo mid-round → status `pulada` + comentário na issue explicando qual decisão falta (vira pergunta do briefing da próxima rodada). Única exceção: o editor intervém por iniciativa própria — responder não é "fazer pergunta", mas a rodada segue sem aguardar follow-up.
- **Nunca** disparar publicação (Beehiiv/LinkedIn/Facebook/Brevo) ou rodar stages da pipeline editorial durante a rodada — e o guard vai **dentro do prompt de cada subagente**, não só aqui.
- #636 (1 PR por vez), #633 (teste de regressão em bugfix) e validação determinística de estado externo (#573) valem a noite inteira, sem exceção.
- Toda issue **trabalhada ou bloqueada** recebe comentário com o que foi feito ou o que falta (com dedup — nunca repetir comentário equivalente). Issues resolvidas dispensam comentário extra: o merge com `Closes #NNNN` já conta a história na timeline.
- `data/overnight/` segue o blanket gitignore de `data/` — relatórios não vão pro repo.
- Stall passivo é inaceitável: toda espera usa `gh pr checks --watch` em background ou poll com intervalo explícito. Timeout por espera de CI = **30 min**; estourou → tratar como CI vermelho (tentativa de fix/draft), nunca esperar indefinidamente.
