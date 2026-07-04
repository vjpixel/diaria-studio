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

0. **Resume**: se `data/overnight/{AAMMDD}/plan.json` de hoje já existe, **pular o briefing** — retomar a partir dos status do próprio `plan.json` usando a tabela de estados abaixo. Se `plan.json` contém `resume_state` estruturado (ver passo 7), usar seus campos para retomada determinística (phase + pending_issues + next_action) em vez de parsing de texto livre, confirmando ao editor o que falta antes de prosseguir:

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
1. **Sync**: `git checkout master && git pull` (o coordenador pode estar em outra branch — pull na branch errada faria os worktrees forkarem de HEAD não-master e os PRs da noite carregarem diff alheio). **Capturar `base_sha = git rev-parse HEAD` AGORA (pós-pull)** — é o ponto de partida do diff consolidado da Fase 1.5; capturado antes do pull, o diff incluiria commits alheios. Verificar `gh auth status`. **Checar arming do watchdog externo (#2688, causa raiz #1 do incidente #2768):** rodar `npx tsx scripts/lib/check-watchdog-armed.ts` — em sessão local, verifica se a task "Diaria-Overnight-Watchdog" está registrada no Task Scheduler. **Arming mais assertivo (#2896 proposta 3):** se o resultado for `not_armed_warn`, o coordenador **tenta armar automaticamente** rodando `scripts/overnight/setup-watchdog-schedule.ps1` (rodou sem elevação no incidente 260702-r2, então é seguro tentar sem pedir permissão elevada primeiro) e então re-checa (`check-watchdog-armed.ts` de novo) — se agora reportar `armed`, seguir normalmente; **só cai pro warning fail-soft** (loga warning no run-log — `agent: "overnight"`, `message: "watchdog_not_armed"` — e imprime instrução manual) **se o auto-arm falhar** (script ausente, erro de execução, ou re-check ainda `not_armed_warn`). Auto-arm em si **nunca bloqueia** a rodada — é tentativa best-effort antes do fail-soft, não um novo ponto de falha (mesmo padrão do #738). Em sessão cloud, o check inteiro é no-op (Task Scheduler é recurso local; nem check nem auto-arm rodam). Incluir o resultado final (`armed` — direto ou via auto-arm —, `not_armed_warn`, ou `skip_cloud`) no relatório da Fase 2 se `not_armed_warn` — o editor precisa saber que a segunda camada de proteção contra stall não está ativa nesta máquina mesmo após a tentativa automática. Note que esta é apenas uma das três sub-camadas de proteção contra stall (ver "Stall passivo — duas camadas (#2379 + #2688)" abaixo, que agora inclui uma terceira: fallback wake determinístico do coordenador, #2896).
2. **PRs abertos remanescentes**: listar PRs abertos. Auto-resolver **só os de autoria desta skill** (branch prefix `overnight/`): CI verde e não-draft → merge (fluxo da Fase 1, passo 3). Qualquer outro PR aberto (bot, WIP do editor, draft de noite anterior) → vira pergunta no briefing; **nunca** auto-mergear PR que a skill não criou.
3. **Varredura**: `gh issue list --state open --limit 200 --json number,title,labels,body,url`.
4. **Classificar cada issue** em:
   - `elegivel` — direção clara e completa na issue; dá pra resolver sem perguntar nada. Issue sem label de prioridade → tratar como `P2` e anotar no plano (não inventar prioridade alta nem descartar).
   - `precisa-resposta` — ambiguidade **trivial-mas-não-documentada** que cabe numa `AskUserQuestion` no briefing: escolha pequena, sem trade-off real de usuário final (ex: "formato A ou B de log", "opção técnica equivalente"). **Issue de trade-off-real de produto/editorial** (decisão genuína entre opções que afetam o usuário final — ex: design system vs documentar, CSS-only vs JS) → **não** vai ao briefing; marcar `pulada` motivo `ambígua/trade-off-real`, **comentar na issue** explicando que é trade-off-real e direcionando ao `/diaria-develop` (cat. C), e seguir para a próxima (com dedup — não comentar se já existe comentário overnight equivalente). Linha divisória: se a resposta depende de preferência sobre experiência do usuário final → trade-off-real → `/diaria-develop`; se é escolha técnica sem impacto diferencial em usuário → trivial → briefing.
   - `bloqueada-externa` — precisa de ação que só o editor pode fazer (conta de terceiro, allowlist, credencial). Comentar na issue o que falta e pular (com dedup: checar antes se já existe comentário overnight equivalente — não comentar de novo).
   - **`requer-sessao-local`** — issues com label **`local`** em sessão **cloud** (container efêmero, sem junction `data/`). Detectar o modo com `npx tsx scripts/lib/exec-mode.ts` (imprime `local` ou `cloud`; exit 0 sempre). Em modo cloud: marcar `pulada` motivo `requer-sessao-local`, comentar na issue "Requer sessão local — junction `data/`, ComfyUI ou credenciais locais ausentes em sessão cloud." (com dedup), e pular. Em modo local: issue `local` é elegível normalmente — a label é apenas informacional em sessão local.
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
   Motivos possíveis: `not-this-week`, `bloqueio-externo: {o que falta destravar}`, `requer-sessao-local: junction data/ ausente em cloud`, `dados imaturos até {data}`, `fora do escopo overnight`, `ambígua/trivial: {o que falta — próximo briefing}`, `ambígua/trade-off-real: → /diaria-develop (cat. C)`. Usar o motivo mais específico — nunca só "pulada". Após imprimir a tabela, fazer **uma** `AskUserQuestion` com: "Alguma issue excluída deve entrar na rodada? Responda com os números das issues (ex: #1234, #5678) ou 'ok' para prosseguir." — resposta recebida antes do briefing; issues citadas são promovidas para `precisa-resposta` (ou `elegivel` se não há dúvida). Esta pergunta e o briefing do passo 5 podem ser combinados numa única `AskUserQuestion` se houver perguntas de `precisa-resposta` simultaneamente.

5. **Briefing**: para as `precisa-resposta`, fazer **todas** as perguntas de uma vez via `AskUserQuestion`, agrupadas por issue (máximo 4 perguntas por chamada e 4 opções por pergunta; header = `#NNNN`). Cada pergunta oferece opções concretas + trade-off, **e sempre inclui a opção "decido depois (pular esta issue)"**. AskUserQuestion é bloqueante — não existe "detectar que o editor não respondeu"; o briefing pressupõe editor presente (limitação documentada: se ele sair no meio, a pergunta fica pendente até ele voltar). Issue respondida → promover a `elegivel` e **postar a resposta como comentário na issue** (`gh issue comment`) — é a fonte durável, visível de qualquer máquina/sessão; `plan.json` é cache. "Decido depois" → status `pulada` (sem comentário — a issue não foi prometida).

   **Plano de agrupamento no briefing (incluir na ÚNICA `AskUserQuestion`)**: formar o agrupamento do passo 6 **antes** de montar o `AskUserQuestion` (os passos 5 e 6 são logicamente concorrentes — o agrupamento precisa existir para ser apresentado no briefing). Exibir o plano de agrupamento — por unidade, incluindo:
   - issues que entram no lote (ou "solo")
   - subsistema/arquivos afetados (racional de coesão)
   - prioridade do lote (a mais alta entre suas issues)

   Exemplo de formato:
   ```
   Lote ds-email (#101, #103) — DS/email templates, sem conflito — P2
   Solo #105 — scripts/publish-facebook.ts, blast radius alto — P1
   Solo #108 — .claude/skills/diaria-overnight/SKILL.md, sem código executável — P3
   ```

   **Dobrar a aprovação do agrupamento na ÚNICA `AskUserQuestion` do briefing** (junto das `precisa-resposta` + loop-estendido), com as opções:
   - "a) aprovar agrupamento proposto"
   - "b) ajustar (diga quais issues juntar ou separar)"
   - "c) tudo solo (sem batching)"

   A aprovação acontece na janela de presença do editor — a pergunta já está no briefing, não requer interação extra. Resposta recebida → registrar `batch_approval: "editor_approved"` (opção a) ou `"editor_adjusted"` (opção b/c) em `plan.json`. **Fallback explícito → `batch_approval: "default_proposed"`** (proceder com o agrupamento proposto): aplica-se aos caminhos em que a pergunta de agrupamento **não chega a ser feita** ao editor — (a) modo `--dry-run`/auto sem gate humano; (b) Resume de um `plan.json` que não gravou o campo (rodada anterior a #2612 ou crash entre passos); (c) 0 issues `precisa-resposta` E o editor responde só ao loop-estendido sem o item de agrupamento. Nunca é um `AskUserQuestion` separado pós-briefing (Regra 1) — quando há briefing, o agrupamento entra na MESMA chamada das `precisa-resposta` + loop-estendido.

   **Pergunta padrão de loop estendido** (incluir ao final do briefing, ou como pergunta isolada quando não há `precisa-resposta`): "Incluir toda a fila desbloqueada nesta rodada? s/n". Se `s`: ativar modo loop estendido — após esgotar a fila do briefing, varrer TODA a fila open sem bloqueio (inclui analyses, scopings com direção clara, P3s, issues que entrariam como `mid-round`); **gravar `loop_estendido: true` em `plan.json` imediatamente** (antes de prosseguir). Se `n` (default): rodada limitada à fila do briefing + issues `mid-round` com direção clara que aparecerem naturalmente; gravar `loop_estendido: false` em `plan.json`. **Racional:** o loop estendido — não o depth-2 — é o principal fator de duração da rodada (rodada 260611: 47 issues / ~16h com loop estendido ativo). O briefing é o único momento de opt-in.
6. **Agrupamento em lotes (#2024, teto revisado em #2754)**: agrupar as `elegivel` em **lotes coesos** — mesmo subsistema/arquivos, mesma natureza (ex: "DS/email", "playbooks Stage 4", "validator"). Critérios: o lote inteiro cabe numa revisão de diff única; nenhuma issue do lote conflita com outra. **Teto = cabe sem forçar compaction de contexto do subagente implementador, não um número fixo de issues** (#2754 — overnight otimiza tokens, não tempo; um subagente maior amortiza custo fixo de bootstrap — ler CLAUDE.md, `npm ci`, explorar convenções — sobre mais itens, e sai mais barato por item do que N subagentes solo repetindo esse bootstrap. Medido na 260630: lote de 16 sub-itens em 3 issues saiu ~26k tokens/item vs. ~114k tokens/item numa issue solo comparável). Sinal prático de teto estourado: o subagente reportar compaction no meio da sessão, ou a lista de arquivos tocados ultrapassar ~15-20. Issues grandes/arriscadas (P1, blast radius alto, migrações) ficam **solo** — o batching é só pras pequenas/médias. Cada lote vira 1 PR (`Closes #A, closes #B, ...`); como o merge fecha todas as issues do lote, o review leve do coordenador confere que o diff cobre de fato **todas** elas.
7. **Plano da rodada**: gravar em `data/overnight/{AAMMDD}/plan.json`. **`{AAMMDD}` = data local de início da rodada, fixada AQUI e relida de `plan.json` em todas as fases seguintes — nunca recomputada de today()** (toda rodada cruza a meia-noite).
   ```json
   {
     "started_at": "ISO", "base_sha": "a67520a3f...", "review": null,
     "rescans_done": 0, "findings_depth": 0, "review_1_5b_has_p2": false, "loop_estendido": false,
     "batch_approval": "editor_approved | editor_adjusted | default_proposed",
     "stall_events": [],
     "resume_state": null,
     "preempted_by": null,
     "preempted_at": null,
     "preempted_pending": null,
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
   `base_sha` = o hash REAL capturado no passo 1 (nunca texto descritivo). `review` é atualizado pela Fase 1.5 (`null` → `"done (depth {N})"` / `"skipped: {motivo} (depth {N})"`); plan.json legado pode conter `"done"` (sem depth) — ver tabela do Resume. `review_1_5b_has_p2` é gravado pela Fase 1.5 ao finalizar o review 1.5b (`findings_depth == 1`): `true` se ≥1 finding de severidade P2 ou superior foi identificado; `false` caso contrário. É o guard da tabela do Resume para mini-rodada 2 — ver Regra 2. `batch_approval` (#2612) registra a fonte da decisão de agrupamento: `"editor_approved"` (editor aprovou na opção a do briefing), `"editor_adjusted"` (editor ajustou na opção b/c), `"default_proposed"` (fallback: editor não respondeu a essa parte do briefing). Análogo ao `source` do consent do Stage 5 — auditável, rastreável. `pr` recebe o número do PR no desfecho da issue (Fase 1 passo 5) — é a fonte pós-compaction do relatório. `rescans_done` conta quantos re-scans de issues novas já ocorreram após esgotar a fila principal (escopo: fila principal apenas — mini-rodadas da Fase 1.5 rodam com o guard K desligado e nunca incrementam este contador; capped em K=2). `findings_depth` registra o nível atual da cadeia de re-entrada de findings (0 = fila principal, 1 = mini-rodada 1 pós-1.5, 2 = mini-rodada 2 pós-1.5b; nunca excede o depth limit da tabela do passo 0). `source` indica a origem de cada issue no plano: `initial` (varredura Fase 0), `mid-round` (nova durante a Fase 1), `finding-depth-1` ou `finding-depth-2` (criada como `session-finding` e re-entrou). Status possíveis: `elegivel`, `pulada` (motivo: `sem-resposta` | `bloqueio-externo` | `requer-sessao-local` | `ambigua` | `not-this-week` | `fora-do-escopo` | `rescan-limit`), e os terminais da Fase 1: `mergeada`, `draft-ci-vermelho`. `timeline` registra os timestamps ISO por transição de cada unidade — os marcos omitidos ficam ausentes (não null); campo ausente = transição não ocorreu ou rodada anterior ao #2099. Lotes de N issues compartilham o mesmo `timeline` (o coordenador grava no objeto da issue representante — a que tem `dispatch`).

   **Campos de instrumentação adicionais do plan.json (#2379, #2380, #2382):**

   - **`stall_events`** (array, #2379): lista de eventos de stall passivo detectados durante a rodada. Cada entrada tem a forma `{ "at": "ISO", "reason": "rate_limit | context_exhaustion | standby | ci_timeout | unknown", "resumed_at": "ISO | null" }`. O coordenador acrescenta uma entrada sempre que detecta >60 min sem progresso em unidade em andamento, **antes** de emitir o halt banner. Começar a rodada com `stall_events: []`. Gravar `resumed_at` quando a rodada é retomada após o stall.

   - **`resume_state`** (objeto ou null, #2380): gravado toda vez que a rodada é interrompida (PC desligado, colisão editorial, deadline). Estrutura:
     ```json
     {
       "phase": "fila_principal | mini_rodada_N | review_1_5x | relatorio",
       "pending_issues": [123, 456],
       "next_action": "dispatch_mini_rodada_2 | iniciar_review_1_5b | ...",
       "interrupted_reason": "pc_desligado | colisao_editorial | deadline | unknown"
     }
     ```
     Valores de `phase`: `fila_principal` (Fase 1 em andamento), `mini_rodada_N` (mini-rodada N da Fase 1.5), `review_1_5x` (review consolidado da Fase 1.5), `relatorio` (Fase 2). `pending_issues` lista os números de issue sem status terminal ao momento da interrupção. Na retomada (passo 0 Resume), se `resume_state` não for null, usar seus campos para retomada determinística em vez de inferir do texto livre — confirmar ao editor `"Retomando: phase={phase}, pending={pending_issues}"` antes de prosseguir. Após concluir a rodada normalmente, gravar `resume_state: null`.

   - **`preempted_by`**, **`preempted_at`**, **`preempted_pending`** (#2382): gravados quando a rodada é encerrada por precedência editorial (guard de colisão com a manhã, Fase 1 passo 1). `preempted_by` recebe `"edicao_editorial"` (único valor atual); `preempted_at` recebe o timestamp ISO do encerramento; `preempted_pending` recebe a lista de números de issue sem status terminal. Rodadas encerradas normalmente têm esses campos como `null`. A política de precedência editorial é: a edição matinal (agendada pelo Task Scheduler — ver #2089) tem prioridade sobre a rodada overnight; o guard de colisão (detecção via `find-current-edition.ts`) aplica esta política automaticamente.
8. Confirmar o plano com o editor (a tabela completa já foi impressa no passo 4.5; os lotes e a aprovação do agrupamento já foram incluídos no briefing do passo 5; aqui confirmar o estado final antes de entrar na Fase 1). **Se 0 elegíveis, dizer isso agora e encerrar aqui** — é a última chance do editor destravar algo respondendo mais perguntas; não rodar uma noite vazia. Com `--dry-run`, parar aqui (sem comentários postados). A aprovação do agrupamento já foi resolvida no passo 5 (via AskUserQuestion do briefing, ou via fallback `default_proposed`) — **nunca** repetir a pergunta aqui (Regra 1); usar o que está registrado em `batch_approval` do plan.json.

## Fase 1 — Loop de resolução

Uma **unidade de trabalho** (issue solo ou lote, #2024) por vez, sempre a de maior prioridade (P0 > P1 > P2 > P3 — prioridade do lote = a mais alta entre suas issues; empate → número menor = mais antiga). **No início de cada iteração, reler `plan.json`** — após compaction de contexto, ele é a única fonte confiável do briefing e dos status. A cada iteração:

1. **Re-checar a fila**: `gh issue list --state open --limit 200 --json number,title,labels,state,createdAt` (sem `body` — corpo só de issues novas, via `gh issue view {N} --json body`; o coordenador precisa ficar enxuto). Issue fechada externamente → marcar `pulada` no plano e não trabalhar. **Issues novas criadas durante a rodada** (qualquer prioridade, qualquer autor — humano ou automação) com direção clara no corpo entram como `elegivel` com `source: "mid-round"`, com as seguintes exceções: (a) issue ambígua → **não** fazer pergunta ao editor; postar comentário explicando o que falta na direção + status `pulada` motivo `ambigua` (a questão vira pergunta do briefing da próxima rodada — Regra 1); (b) issue com label `bloqueio-externo` ou `not-this-week` → `pulada` com motivo correspondente; (c) issue com label `session-finding` **e `created_at >= started_at` do `plan.json`** (= gerada pela própria rodada) → **não entra agora** (fluxo da Fase 1.5 cuida da re-entrada controlada com depth limit); issue com label `session-finding` mas `created_at < started_at` (= finding de rodada anterior, pendente) → trata como `mid-round` normal. **Guard de convergência** (K=2 — escopo: fila principal apenas, mini-rodadas da Fase 1.5 não incrementam): cada vez que a fila elegível da fila principal é esgotada (sem itens pendentes), fazer um re-scan para capturar issues novas; **aceitar todas as novatas encontradas neste re-scan com direção clara antes de incrementar** `rescans_done`; só então incrementar `rescans_done` em `plan.json`. Quando `rescans_done >= 2` **antes de iniciar** um novo re-scan, não fazer o re-scan — encerrar a Fase 1 registrando motivo `rescan-limit` para novas issues e ir para Fase 1.5. **Só issues sem status terminal no `plan.json` são candidatas** — uma issue que já virou `draft-ci-vermelho` ou `pulada` nunca é re-escolhida na mesma rodada (anti-livelock). **Guard de colisão com a manhã**: se uma edição diária estiver em curso (`npx tsx scripts/lib/find-current-edition.ts` retorna candidato ou `data/editions/` de hoje/amanhã ganhou arquivos novos), encerrar a Fase 1 após a unidade corrente e ir pra 1.5/relatório — a pipeline editorial tem precedência. Quando este guard acionar, gravar `preempted_by: "edicao_editorial"`, `preempted_at: now()` e `preempted_pending: [lista de issues sem status terminal]` em `plan.json`, e emitir no run-log:
   ```bash
   npx tsx scripts/log-event.ts --edition {AAMMDD} --agent overnight --level info \
     --message "preempted" \
     --details '{"preempted_by":"edicao_editorial","preempted_pending":[123,456]}'
   ```
2. **Dispatchar um subagente implementador por unidade de trabalho** — issue solo ou lote inteiro (#2024) — (`Agent`, `subagent_type: "general-purpose"`, `isolation: "worktree"` — nunca um agente especializado do repo: eles têm toolset restrito e não conseguem commitar/pushar). O prompt do subagente inclui, obrigatoriamente:
   - corpo de TODAS as issues da unidade + respostas do briefing (lidas de `plan.json`);
   - regras do repo: #633 (bugfix exige teste de regressão), convenções de commit/PR do CLAUDE.md;
   - **guard de publicação**: editar código de publisher é ok; **EXECUTAR é proibido** — nunca rodar `scripts/publish-*`, `clarice-schedule-sends`, `clarice-import-*`, `close-poll` ou qualquer script que toque Beehiiv/LinkedIn/Facebook/Brevo ao vivo, nem em "teste";
   - bootstrap do worktree: **primeiro passo é `npm ci`** (worktree novo não tem `node_modules/` nem a junction `data/`); testes = **`npm test`** (inclui o pretest guard #1948);
   - **`npm test` e `npx tsc --noEmit` rodam SEMPRE em FOREGROUND, aguardando o resultado antes de retornar — NUNCA em background (#2896).** O incidente 260702-r2 (coordenador ~8h parado) teve como gatilho um subagente resumido que rodou `npm test` em background e "sumiu" (abriu o PR e nunca mais emitiu notificação); yield-on-background-test é exatamente o padrão a evitar — além de causar o stall, desperdiça 1 round-trip inteiro por unidade (o coordenador tem que reperguntar o resultado depois);
   - **self-review obrigatório antes de retornar (#2038) — tratado como ETAPA DE LISTAGEM**: após o `gh pr create`, o subagente faz UMA passada adversarial no próprio `git diff` contra a(s) issue(s) + briefing, checando: o diff cobre TODOS os pontos da issue (não só os fáceis)? Sobrou referência órfã de refactor (grep pelos símbolos renomeados)? O arquivo carrega (`npx tsc --noEmit` se coberto pelo tsconfig, senão import smoke via tsx)? O cenário REAL da issue tem teste (não só a aritmética adjacente)? **O output esperado do self-review são os findings listados — comentários inline no PR são o canal correto** (não fixes imediatos). Finding grande demais para o coordenador aplicar direto → comentário inline no PR detalhando a mudança necessária. Racional empírico (260610/260611): subagentes consistentemente postam findings como comentários em vez de corrigir — em vez de lutar contra o padrão, o fluxo de 2 agentes o codifica. **NUNCA fazer `AskUserQuestion` durante o self-review** — Regra 1.
   - **se um hook pós-`gh pr create` exigir code-review multi-agente, NÃO executar** — o self-review acima é a resposta; anotar no body do PR e retornar (subagente não pode dispatchar Agent, #207; o review pesado roda UMA vez, consolidado, na Fase 1.5).
   O subagente implementa, roda `npm test`, commita em branch **`overnight/fix-NNNN`** (solo) ou **`overnight/batch-{slug}`** (lote) com `(#NNNN)` / `(#A, #B, ...)` no título, push, abre PR com `Closes #NNNN` (um `closes` por issue do lote), faz o self-review listando findings como comentários inline no PR, e retorna: o número do PR **+ a linha "self-review: N findings"** — o coordenador usa isso para decidir se despacha o agente fixer (0 findings em diff não-trivial é sinal de passada rasa, não de perfeição).

   **Ainda dentro deste passo 2 — emissão de timestamp `dispatch`**: imediatamente após dispatchar o subagente (antes de aguardar a resposta), o coordenador registra `timeline.dispatch = now()` na issue (ou nas issues do lote, em todas) em `plan.json`, e emite no run-log:
   ```bash
   npx tsx scripts/log-event.ts --edition {AAMMDD} --agent overnight --level info \
     --message "dispatch" \
     --details '{"unidade": "#NNNN | lote {slug}", "issues": [123, 456], "pr": null}'
   ```
   **Fallback wake determinístico (#2896) — agendar imediatamente após o dispatch**: na mesma respiração, o coordenador chama `ScheduleWakeup` com delay ~1200s (20 min) para a unidade recém-dispatchada. Ver detalhe completo na seção "Stall passivo — duas camadas" abaixo (terceira sub-camada). O mesmo agendamento se repete sempre que o coordenador **resume** um subagente via `SendMessage` (mesmo passo 3, agente fixer, ou retomada pós-CI-vermelho) — todo dispatch ou resume reagenda o próprio wakeup.
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
   - Esperar CI com `gh pr checks {N} --watch` em background (`run_in_background: true`) — um acordar por PR, sem poll. Interpretar com cuidado: **exit 8 / checks pendentes / lista vazia = PENDENTE, nunca verde nem vermelho** (logo após o push os jobs podem nem estar registrados). Verde = os checks do CI **presentes E concluídos com sucesso**. **O gate é um passo SEPARADO do merge (#2031 — incidente 260610: merge encadeado com `&&` após o output dos buckets passou com check vermelho):** NUNCA encadear `gh pr merge` na mesma chamada Bash que imprime os checks.

   **Timeout de CI (ci_timeout, #2381):** se o CI não transita para verde/vermelho em **30 min** (a partir do `pr_opened`), emitir evento run-log **e imediatamente tratar como CI vermelho** (tentativa de fix ou draft) — 30 min é o único limite, conforme a regra hard da seção "Regras" ("Timeout por espera de CI = 30 min; estourou → tratar como CI vermelho"). O evento `ci_timeout` é a companhia de observabilidade desse limite: distingue "CI devagar" de "sessão dormiu" no run-log, registrando elapsed_min e last_status no momento do vencimento:
   ```bash
   npx tsx scripts/log-event.ts --edition {AAMMDD} --agent overnight --level warn \
     --message "ci_timeout" \
     --details '{"pr": {N}, "unidade": "#NNNN | lote {slug}", "elapsed_min": 30, "last_status": "pending"}'
   ```
   Emitir `ci_timeout` e aplicar a regra hard são a mesma ação — acontecem ao cruzar os 30 min. Registrar `ci_timeout` no relatório.

   **Retry de GitHub API (#2383):** qualquer chamada ao GitHub (graphql, REST, `gh pr merge`, `gh pr checks`) que retornar **401 ou 429** (erros transitórios de autenticação ou rate-limit) **não deve ser tratada imediatamente como falha**. O coordenador tenta ao menos 3 vezes com backoff exponencial (30 s, 60 s, 120 s) antes de tratar como falha permanente ou emitir halt banner. Em cada tentativa, emitir:
   ```bash
   npx tsx scripts/log-event.ts --edition {AAMMDD} --agent overnight --level warn \
     --message "github_api_error" \
     --details '{"status": 401, "endpoint": "graphql/pullRequest", "retry_attempt": 1}'
   ```
   Após 3 tentativas sem sucesso → tratar como falha permanente (CI vermelho / halt banner). Este retry generaliza o padrão introduzido em #2060 para `check-pr-bugfix` para todo o gate da Fase 1. **Caso distinto — FORBIDDEN:** `errors[].type == "FORBIDDEN"` em chamadas de resolução de thread é um erro **estrutural** (a thread foi criada por um revisor externo — o overnight não tem permissão para resolvê-la). FORBIDDEN **nunca é retentável** e **não conta no gate overnight** — é tratado separadamente pela lógica de carve-out FORBIDDEN na seção de resolução de threads abaixo (anotação no PR body para o editor). Não confundir com 401/429: são mecanismos distintos e mutuamente exclusivos.

   **Resolução das review threads** (passo obrigatório entre "fixer concluiu" e "gate determinístico"): após o fixer aplicar/decidir sobre os findings do self-review (#2038), o coordenador resolve as threads via GraphQL. **Guard de paginação (>100 threads — #2222)**: antes de iniciar o loop de resolução, a query já inclui `pageInfo { hasNextPage endCursor }`. Se `hasNextPage == true`, **abortar o gate automático imediatamente** (converter PR pra draft + comentar na issue explicando que >100 threads exigem resolução manual pelo editor) — não tentar paginar durante a resolução autônoma; o risco de false-green em páginas não percorridas supera qualquer conveniência. (a) Coletar resposta com guard de erro e de paginação, e extrair IDs não-resolvidas:
     ```bash
     QUERY='{ repository(owner:"vjpixel",name:"diaria-studio"){ pullRequest(number:{N}){ reviewThreads(first:100){ nodes{ id isResolved } pageInfo{ hasNextPage endCursor } } } } }'
     RESP=$(gh api graphql -f query="$QUERY")
     # Guard de erro: se a query falhou (rede/auth/campo ausente), abortar — nunca tratar erro como 0 threads
     if ! echo "$RESP" | jq -e '.data.repository.pullRequest.reviewThreads' > /dev/null 2>&1; then
       echo "ABORT: gh api graphql falhou ou retornou erro — tratar como CI vermelho/pendente, não como 0 threads."
       exit 1
     fi
     HAS_NEXT=$(echo "$RESP" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage')
     if [ "$HAS_NEXT" = "true" ]; then
       echo "ABORT: PR #{N} tem >100 review threads — gate automático desativado. Converter pra draft e comentar na issue."
       exit 1
     fi
     TIDS=$(echo "$RESP" | jq -r '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false) | .id] | @sh')
     ```
   (b) Resolver cada ID em loop, rastreando separadamente as threads que retornarem FORBIDDEN — o coordenador substitui o ID real, nunca envia a string literal `{threadId}`:
     ```bash
     FORBIDDEN_TIDS=""
     for tid in $TIDS; do
       tid=$(echo $tid | tr -d "'")
       RESULT=$(gh api graphql -f query="mutation { resolveReviewThread(input:{threadId:\"$tid\"}){ thread{ id isResolved } } }")
       # Detectar FORBIDDEN pelo campo estruturado .errors[].type — nunca por grep no body inteiro
       if echo "$RESULT" | jq -e '[.errors[]? | select(.type == "FORBIDDEN")] | length > 0' > /dev/null 2>&1; then
         FORBIDDEN_TIDS="$FORBIDDEN_TIDS $tid"
         echo "INFO: thread $tid FORBIDDEN (criada por terceiro) — anotada no PR body para o editor; não bloqueia o gate."
       fi
     done
     # Se houver threads FORBIDDEN, adicionar seção "Pendências para o editor" no PR body listando cada ID
     ```
   Resolver as threads cujos findings foram endereçados pelo fixer (aplicados no código) ou conscientemente aceitos (finding válido mas não-bloqueante — anotar no PR body antes de resolver). No caso mais comum (fixer tratou todos os findings e não há reviewer externo), resolver todas as threads de uma vez é correto. **Carve-out FORBIDDEN (#2222)**: threads que retornaram FORBIDDEN são de revisores humanos externos — o overnight não pode resolvê-las e **elas não contam na condição (2) do gate**; porém são anotadas no PR body para que o editor as resolva manualmente. Jamais tentar forçar a resolução de thread de terceiro.

   **Gate determinístico** — **2 condições independentes, ambas obrigatórias** (#2210, #2222): (1) `gh pr checks {N} --json bucket --jq '[.[] | select(.bucket != "pass")] | length'` deve retornar `0` (cobre fail/pending/skipping de uma vez); (2) número de review threads não-resolvidas **excluindo as FORBIDDEN** deve ser `0` — fazer uma **nova query GraphQL pós-loop** para capturar o estado real após a etapa de resolução (não reutilizar `$RESP` do pré-loop, que seria stale e contaria threads já resolvidas):
     ```bash
     # Query fresca após o loop de resolução — $RESP do pré-loop está stale
     RESP2=$(gh api graphql -f query="$QUERY")
     if ! echo "$RESP2" | jq -e '.data.repository.pullRequest.reviewThreads' > /dev/null 2>&1; then
       echo "ABORT: query pós-loop falhou — tratar como CI vermelho/pendente."
       exit 1
     fi
     # Guard de paginação em RESP2 (#2232): se uma thread foi adicionada DURANTE o loop de
     # resolução (total passa de 100), RESP2 retorna só 100 e hasNextPage==true — thread #101
     # não contada → false-green. Aplicar o mesmo abort da query pré-loop.
     HAS_NEXT2=$(echo "$RESP2" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage')
     # Guard triplo: "true" = há próxima página; "null" = pageInfo ausente (resposta malformada);
     # qualquer outro valor != "false" é conservador tratar como erro (#2232).
     if [ "$HAS_NEXT2" != "false" ]; then
       echo "ABORT: RESP2 hasNextPage=$HAS_NEXT2 — não é possível garantir gate seguro. Converter pra draft."
       exit 1
     fi
     UNRESOLVED_TOTAL=$(echo "$RESP2" | jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false)] | length')
     FORBIDDEN_COUNT=$(echo "$FORBIDDEN_TIDS" | wc -w)
     # max(0, ...) evita UNRESOLVED_BLOQUEANTES negativo quando uma FORBIDDEN é resolvida
     # externamente entre o loop e RESP2 (#2232): a thread some de UNRESOLVED_TOTAL mas
     # FORBIDDEN_COUNT ainda a conta → subtração negativa → false-RED.
     _DIFF=$(( UNRESOLVED_TOTAL - FORBIDDEN_COUNT ))
     UNRESOLVED_BLOQUEANTES=$(( _DIFF < 0 ? 0 : _DIFF ))
     # Gate da condição (2): passa se $UNRESOLVED_BLOQUEANTES == 0
     # Threads FORBIDDEN já anotadas no PR body — não bloqueiam o gate overnight,
     # mas o ruleset do GitHub (required_review_thread_resolution) pode ainda bloquear o merge:
     # se o merge falhar por thread FORBIDDEN pendente, converter pra draft e comentar na issue.
     ```
   O gate da condição (2) usa `$UNRESOLVED_BLOQUEANTES` (não `$UNRESOLVED_TOTAL`). Se `$UNRESOLVED_BLOQUEANTES > 0`, há threads não-FORBIDDEN não-resolvidas — tratar como CI vermelho (tentativa de fix ou draft). **Nota de ruleset**: o GitHub ruleset `required_review_thread_resolution: true` exige que TODAS as threads estejam resolvidas para merge, incluindo as FORBIDDEN; se o ruleset bloquear o merge mesmo com `$UNRESOLVED_BLOQUEANTES == 0`, registrar `timeline.draft = now()` em `plan.json`, emitir o log-event `draft` (mesmo bloco do caminho CI-vermelho abaixo), converter o PR pra draft (`gh pr ready --undo`) e comentar na issue com os IDs FORBIDDEN para resolução manual pelo editor. Só após ambas as condições satisfeitas, em chamada própria separada, o merge. Bônus do incidente #2031: subagente que tocar `.claude/agents/orchestrator-*.md` deve rodar `NODE_TEST_SNAPSHOTS=1 npx tsx --test test/orchestrator-prompt.test.ts` (snapshot + budget de linhas, #634) antes do push.
   - Verde (CI verde **e** threads_não_resolvidas == 0) → registrar `timeline.ci_green = now()` em `plan.json`, depois `gh pr merge {N} --squash --subject "{título} (#NNNN)" --body "...\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>"` — **sem `--delete-branch`** (a branch está checked out no worktree do subagente; a deleção local falharia e o exit non-zero seria lido como merge falho). **Confirmar o estado real via `gh pr view {N} --json state,mergedAt` SEMPRE — inclusive (principalmente) quando `gh pr merge` retornar erro** (#573): merge remoto pode ter sucedido com falha local. Após confirmar merge: registrar `timeline.merged = now()` em `plan.json` e emitir:
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
     Converter pra draft (`gh pr ready --undo`), comentar na(s) issue(s) com diagnóstico + link, marcar `draft-ci-vermelho` no plano, e seguir pra próxima. **Resolução de threads NÃO é pré-requisito do draft** — o draft não mergeia, então `required_review_thread_resolution` não se aplica; resolver threads só é obrigatório antes do merge (gate determinístico acima).
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

**Stall passivo — três camadas (#2379 + #2688 + #2896):** stall passivo (sessão parada sem sinal explícito) é a causa mais frequente de buracos no run-log (incidentes 260611, 260616b, 260702-r2). Há três camadas independentes de detecção:

- **(i) Detecção-no-wake (#2379 — coordenador):** o coordenador, quando acordado por um evento (CI, task-notification), verifica se houve >60 min sem progresso em unidade em andamento. Cobre o caso em que a sessão existe mas a issue está travada.

  **Guard mecânico obrigatório (#2768) — nunca "vibes-based":** o incidente 260630/260701 aconteceu porque o coordenador recebeu 5 notificações consecutivas de "ainda esperando" de um subagente preso (~4h30 sem progresso real) e nunca comparou o tempo decorrido contra o threshold — só continuou esperando. A partir de agora, **toda vez** que uma `task-notification` de subagente em andamento reportar "ainda aguardando" ou nenhum progresso concreto novo, o coordenador deve, **ANTES de continuar esperando**, executar estes 3 passos na ordem:
  1. Ler `timeline.dispatch` da unidade correspondente em `plan.json`.
  2. Calcular `elapsed = now() - dispatch_time` (comparação explícita de timestamps, não estimativa).
  3. Se `elapsed > 60 min`, aplicar o fluxo de stall abaixo **imediatamente** — nunca esperar mais uma notificação "pra ter certeza".

  **Contador de notificações repetidas (#2768):** independentemente do cálculo de tempo acima, se o coordenador receber **3 notificações consecutivas do mesmo subagente com essencialmente o mesmo conteúdo** (ex: "ainda rodando `npm test`", sem novo output/progresso entre elas), tratar como sinal de stall e aplicar o fluxo abaixo mesmo que o cálculo de `elapsed` ainda não tenha estourado 60 min — 3 notificações idênticas é, por si só, evidência de que a unidade não está avançando.

  Quando detectar (por qualquer um dos dois critérios acima): (1) gravar entrada em `stall_events` no `plan.json` com `at` e `reason` estimado; (2) emitir evento run-log:
  ```bash
  npx tsx scripts/log-event.ts --edition {AAMMDD} --agent overnight --level warn \
    --message "stall_detected" \
    --details '{"reason": "rate_limit | context_exhaustion | standby | ci_timeout | unknown", "unidade": "#NNNN"}'
  ```
  (3) **imediatamente** renderizar halt banner:
  ```bash
  npx tsx scripts/render-halt-banner.ts \
    --stage "overnight — Fase 1" \
    --reason "stall passivo detectado: >60 min sem progresso em {unidade}" \
    --action "reconecte e responda 'retry' para retomar, ou 'abort' para encerrar"
  ```
  Stall silencioso >60 s é inaceitável — regra derivada do CLAUDE.md (#738), aqui especializada para o loop overnight. Ao retomar após stall, gravar `resumed_at` na entrada correspondente de `stall_events`.

- **(ii) Detecção-por-tempo (#2688 — watchdog externo):** o coordenador é event-driven e não cobre o caso em que **nenhum evento chega** (todos os subagentes em silêncio total). O script `scripts/overnight-watchdog.ts` roda via Task Scheduler a cada 10 min, independente da sessão Claude Code, e detecta stall medindo `max(mtime plan.json, último evento run-log agent:overnight)`. Se inatividade > 60 min, também grava em `stall_events`, emite evento run-log e exibe halt banner. Setup local one-time: `scripts/overnight/setup-watchdog-schedule.ps1`. Ver `docs/overnight-watchdog-setup.md`. **Esta camada só protege se a task estiver de fato armada** — o incidente #2768 descobriu que ela nunca tinha sido registrada nesta máquina; por isso a Fase 0 passo 1 agora tenta arming automático (`scripts/lib/check-watchdog-armed.ts` + `scripts/overnight/setup-watchdog-schedule.ps1` como fallback assertivo, #2896 proposta 3) em vez de só avisar.

- **(iii) Fallback wake determinístico do coordenador (#2896):** cobre o buraco que restava mesmo com (i) e (ii): o incidente 260702-r2 (coordenador ~8h parado) aconteceu com o watchdog externo desarmado (causa raiz #1, endereçada pelo arming assertivo acima) **e** com zero eventos chegando ao coordenador — o gatilho foi um subagente resumido que rodou `npm test` em background, abriu o PR, e silenciou sem emitir notificação terminal, então (i) nunca teve um "wake" pra rodar o guard #2768 sobre. Fix: ao **dispatchar OU resumir** qualquer subagente (passo 2 e passo 3 da Fase 1), o coordenador agenda um `ScheduleWakeup` com delay ~1200s (20 min). Ao acordar — **mesmo sem ter recebido nenhum evento da unidade** — o coordenador lê `timeline.dispatch` de `plan.json` e computa `elapsed = now - timeline.dispatch` via `shouldWakeCheck(dispatchISO, nowISO, 60)` (helper puro em `scripts/lib/overnight-fallback-wake.ts`, coberto por `test/overnight-fallback-wake.test.ts`). Se `shouldWakeCheck` retornar `true`, aplicar o fluxo de stall do #2768 (gravar `stall_events`, emitir `stall_detected`, renderizar halt banner) **exatamente como em (i)** — a única diferença é que este wake não depende de receber notificação alguma, fechando o caso "silêncio total do lado do coordenador" que (i) inerentemente não cobre (é event-driven por definição) e que (ii) só cobre se a task estiver de fato armada.

  **Sinal de resume vivo-mas-sem-garantia (`classifyResumeSignal`):** quando o coordenador resume um subagente via `SendMessage`, o retorno textual da chamada é classificado com `classifyResumeSignal(sendMessageResult)` (mesmo módulo): um retorno contendo "queued" (ex: "queued for delivery at its next tool round") vira `'queued'` — o agent está vivo, mas **sem garantia de notificação terminal** quando terminar (era exatamente o padrão do incidente) — então o `ScheduleWakeup` desta unidade é reagendado normalmente e o re-check ativo é o único jeito de saber se ela avançou. Um retorno contendo "resumed"/"stopped" vira `'resumed'` — o agent foi de fato retomado e uma notificação é esperada pelo caminho event-driven normal (o fallback wake ainda roda como rede extra, mas o caminho (i) tem mais chance de disparar primeiro). Qualquer outro texto vira `'unknown'` — tratado com a mesma cautela de `'queued'` (nunca assumir que o coordenador vai ser notificado).

  **Interação entre as três camadas:** todas gravam em `stall_events` e emitem `stall_detected` no run-log. A dedup interna do watchdog (janela de 30 min) evita spam se o coordenador ainda estiver rodando e já tiver registrado. Ao retomar, o coordenador grava `resumed_at` na entrada correspondente de `stall_events` normalmente — vale para as três camadas.

## Fase 1.5 — Code-review consolidado pós-rodada (#2039)

A Fase 1.5 segue a cadeia de re-entrada cuja terminação é garantida pelo depth limit definido na **tabela de estados do passo 0** (Resume). `findings_depth` em `plan.json` rastreia em qual nível estamos (0 = review inicial, 1 = review pós-mini-rodada 1, 2 = review pós-mini-rodada 2); o que fazer em cada nível está nos bullets de "Re-entrada de findings" abaixo, e quando parar está na tabela.

**Passo 1.5 — Review consolidado** (roda sempre que `findings_depth` avança para este nível):

Com a fila esgotada (sem PR **não-draft** aberto — drafts de CI-vermelho não bloqueiam esta fase e ficam FORA do diff consolidado, pois não mergearam), rodar **UM** code-review pesado sobre o **diff acumulado**. No `findings_depth == 0` (review inicial): diff = `{base_sha}..HEAD`. Nos níveis subsequentes (1.5b, 1.5c): diff = do SHA imediatamente antes do início da mini-rodada anterior até HEAD. **Como calcular o SHA base das mini-rodadas:** ao iniciar cada mini-rodada, gravar `minirodada_base_sha_{N}: git rev-parse HEAD` no `plan.json` ANTES de qualquer merge; no review subsequente (1.5b/1.5c), usar esse campo como base. **Fallback quando a mini-rodada não produziu nenhum merge** (todas as issues viraram `draft-ci-vermelho`): diff ficaria vazio ou idêntico ao do review anterior — **pular** com `review: "skipped: diff vazio (mini-rodada {N} sem merges) (depth {N+1})"` no plan.json e nota no relatório (mesmo comportamento do "diff < 50 linhas"). Forma executável: invocar a skill built-in via Skill tool com `args: "max {sha_range}"` (**sem `--comment`** — não há PR aberto pra ancorar threads; os findings retornam à conversa e a triagem abaixo é o destino deles). Se a skill não aceitar o range como target, fallback: `git diff {sha_range} > data/overnight/{AAMMDD}/night-diff-d{N}.patch` e passar o path. O `base_sha` vem de `plan.json`. É a rede pós-merge — 1 review consolidado custa uma fração de N por PR e enxerga interações ENTRE os PRs da mesma janela (nota: o diff inclui também merges alheios — findings sobre código alheio viram issue, nunca hotfix). Esta fase é **read-only + filing**: nenhum PR novo de feature.

Saídas explícitas: diff vazio ou < ~50 linhas (e não foi mini-rodada sem merges — coberto acima) → **pular** com `review: "skipped: diff trivial (depth {N})"` no plan.json + nota no relatório (o review leve por PR já cobriu). Zero findings → registrar `review: "done (depth {N})"` com nota "0 findings" (silêncio é indistinguível de não-rodou). Review falhou (Agent indisponível, timeout) → NÃO stall (#738): logar warn, `review: "skipped: {erro} (depth {N})"`, seguir pra Fase 2.

Triagem dos findings:
- **Crítico em produção** (corrupção de dado, publicação quebrada, master vermelho — confirmado deterministicamente, ex: `gh run list --branch master --limit 1`, nunca só pelo texto do finding, #573) → **hotfix imediato** seguindo o fluxo COMPLETO da Fase 1 passos 2–3 (subagente em worktree, `npm test`, regressão #633 quando bugfix, branch `overnight/hotfix-*`, CI + gate determinístico #2031, verify #573). A exceção é só ao "nenhum PR novo" — **nunca ao processo**.
- Demais findings, **filtrados por barra de filing (#2754)**: só vira issue se for **P2+** (mesma heurística do passo abaixo: corrupção de dado, funcionalidade quebrada, bug de segurança, ou bug que deveria ter sido capturado por #633 mas passou) **ou** tiver **cenário de falha concreto** (inputs/estado que reproduzem o problema, não só "poderia ser melhor"). Findings P3 genéricos/nice-to-have/estilo (a maioria de um review `max`) **não viram issue** — ficam listados no relatório da noite (Fase 2) como "findings do review, não filados", pro editor decidir se algum merece virar issue manualmente. Racional: cada issue filada aqui é dívida que uma rodada futura vai queimar tokens resolvendo, que por sua vez gera novo self-review, que fila mais issues — o ciclo estava compoundando token spend entre rodadas sem produzir valor proporcional (observado na 260630: issues #2684/#2691/#2693, todas follow-up de follow-up de self-review anterior, custaram ~413k tokens numa única rodada). Findings que passam na barra → **issues filadas** seguindo o protocolo do auto-reporter (`.claude/agents/auto-reporter.md` + `scripts/lib/auto-reporter-dedup.ts`: dedup via `gh search issues` com fallback gracioso, labels tipo + prioridade), com label extra **`session-finding`** e corpo citando o PR de origem do diff.
- **Re-entrada de findings** (ver tabela do passo 0 para o depth limit e condição de parada): após filar as issues, verificar `findings_depth` em `plan.json`:
  - Se `findings_depth == 0` (review inicial, 1.5): issues `session-finding` com direção clara → registrar com `source: "finding-depth-1"`, gravar `minirodada_base_sha_1: git rev-parse HEAD` no plan.json, incrementar `findings_depth` para 1, e **rodar mini-rodada 1** (fluxo da Fase 1 **fechado sobre essas issues** — `rescans_done` NÃO é incrementado dentro de mini-rodadas; o guard K=2 é exclusivo da fila principal; **timestamps `timeline.*` emitidos normalmente** — os passos 2/3/5 da Fase 1 se aplicam sem modificação dentro das mini-rodadas); depois voltar a este passo — será o review 1.5b.
  - Se `findings_depth == 1` (review pós-mini-rodada 1, 1.5b): classificar os findings por severidade. **Heurística de classificação P2+** (o output do `/code-review` não tem campo de prioridade — o coordenador infere da descrição): finding é P2+ se descreve **corrupção de dado, funcionalidade quebrada, bug de segurança, ou bug que deveria ter sido capturado por #633 mas passou** — style/cleanup/simplificação são P3 por padrão. Em caso de dúvida, o finding é P3 (não ativa mini-rodada extra). **Ordem de escrita obrigatória**: primeiro gravar `review_1_5b_has_p2: true/false` no `plan.json`, **só depois** gravar `review: "done (depth 1)"` — assim uma falha entre os dois writes deixa `review_1_5b_has_p2` escrito mas `review` como null, e o Resume re-executa 1.5b de forma segura (em vez de pular findings com dados perdidos). Se `review_1_5b_has_p2 == true`: issues `session-finding` P2+ com direção clara → registrar com `source: "finding-depth-2"`, gravar `minirodada_base_sha_2: git rev-parse HEAD` no plan.json, incrementar `findings_depth` para 2, e **rodar mini-rodada 2** (mesmas restrições: fluxo Fase 1 fechado, sem incremento de `rescans_done`; **timestamps `timeline.*` emitidos normalmente**); depois voltar — será o review 1.5c. Se `review_1_5b_has_p2 == false`: **não rodar mini-rodada 2** — aplicar a **barra de filing (#2754)** aos findings P3 do 1.5b, igual à Fase 1.5 nível 0: só vira issue o que tiver cenário de falha concreto; o resto fica listado no relatório, sem issue. O que passar na barra → **filado via o protocolo do auto-reporter** (label `session-finding`) antes de ir para Fase 2; em seguida registrar `review: "done (depth 1)"` e ir para Fase 2 (o 1.5b é o review final desta noite). Registrar no relatório "cadeia encerrada no depth 1 (nenhum finding P2+ no 1.5b)".
  - Se `findings_depth == 2` (review pós-mini-rodada 2, 1.5c): issues `session-finding` com direção clara **não re-entram** — ficam para a próxima rodada (ver tabela do passo 0 — depth limit atingido). Registrar no relatório "findings da 1.5c ficam para próxima rodada".
  - Issues `session-finding` ambíguas (qualquer nível): **não fazer pergunta ao editor** — postar comentário explicando o que falta + `pulada` motivo `ambigua` (Regra 1).
- Ao final de cada nível: gravar `review: "done (depth {N})"` (+ contagem de findings/issues) no `plan.json` — é o que torna a fase idempotente no resume. Tudo listado nas seções de findings do relatório (Fase 2).

## Fase 2 — Relatório

1. Compilar o digest da noite a partir de `plan.json` + run-log (filtrado por `agent: "overnight"` + AAMMDD da rodada), **agrupado por PR** (lotes listam suas issues juntas):
   - resolvidas (com links de PR e commits de merge — estados confirmados via `gh pr view`, nunca de memória),
   - puladas e por quê (sem briefing, bloqueio externo, CI vermelho persistente — com link do draft),
   - **entraram mid-round**: issues com `source: "mid-round"` incorporadas durante a Fase 1 (número, título, PR de resolução ou motivo de exclusão),
   - **review noturno + mini-rodada(s) de findings**: hotfixes críticos aplicados (se houver) + cadeia completa com PRs — para cada nível ativo (1.5 → mini-1 → 1.5b → mini-2 → 1.5c): findings identificados, issues filadas, issues resolvidas na mini-rodada, issues que não re-entraram (depth-limit, sem P2+, ou ambíguas); se a cadeia terminou antes do depth limit (1.5b sem P2+, ou depth-2 sem findings), indicar em qual nível parou e o motivo. **Findings do review que NÃO passaram na barra de filing (#2754)** — P3 sem cenário de falha concreto — entram numa lista à parte "findings do review, não filados" (descrição breve + arquivo:linha), pro editor decidir manualmente se algum merece virar issue,
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
- **Fallback wake é INVARIANTE MECÂNICO, não um "should" (#2945 — HARD RULE).** Todo `Agent` dispatch OU `SendMessage` resume de subagente é IMEDIATAMENTE seguido — na MESMA leva de tool-calls, junto do `timeline.dispatch` + log-event — de um `ScheduleWakeup` (~1200s) pra aquela unidade. Não é opcional, não é lembrável, não depende de "achar que vai ser notificado": é passo mecânico como o registro de timestamp. Um retorno de resume que contenha `"queued"` / `"waiting for background"` / `"monitor"` (classificar com `needsActiveRecheck`/`classifyYieldText` de `scripts/lib/overnight-fallback-wake.ts`) **EXIGE re-check ativo** — nunca confiar em notificação terminal após um resume `queued`. Esquecer esse agendamento foi a causa do stall de ~10h em 260703 (o #2896 introduziu o mecanismo mas como recomendação esquecível; aqui vira regra dura). O watchdog externo (#2688) é a 2ª camada, mas só protege se `check-watchdog-armed.ts` reportar `armed` **de verdade** (não `armed_but_disabled`/`armed_but_stale`/`armed_but_never_run`, #2944).
- Toda issue **trabalhada ou bloqueada** recebe comentário com o que foi feito ou o que falta (com dedup — nunca repetir comentário equivalente). Issues resolvidas dispensam comentário extra: o merge com `Closes #NNNN` já conta a história na timeline.
- `data/overnight/` segue o blanket gitignore de `data/` — relatórios não vão pro repo.
- Stall passivo é inaceitável: toda espera usa `gh pr checks --watch` em background ou poll com intervalo explícito. Timeout por espera de CI = **30 min**; estourou → tratar como CI vermelho (tentativa de fix/draft), nunca esperar indefinidamente.
