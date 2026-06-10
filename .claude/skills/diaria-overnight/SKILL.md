---
name: diaria-overnight
description: Assume o turno no fim do dia (#2021) — varre as issues abertas, faz briefing interativo com o editor antes dele sair, e resolve a fila autonomamente durante a noite (PR → CI → auto-merge). Ao final, deixa rascunho de relatório no Gmail + resumo no terminal. Uso — `/diaria-overnight [--limite HH:MM] [--dry-run]`.
disable-model-invocation: true
---

# /diaria-overnight

O editor invoca esta skill ao encerrar o expediente. Você assume o turno: varre a fila de issues do GitHub, tira todas as dúvidas com o editor **antes** dele sair (briefing único), e depois trabalha a fila de forma 100% autônoma até esgotá-la ou até o horário-limite. Ao final, compila o relatório da noite (rascunho no Gmail + resumo no terminal).

Escopo = **resolver issues de código/config/docs do repo**. Fora de escopo: executar a pipeline editorial (pesquisa, escrita, publicação de edição) — mudanças em código de publishers/Workers SÃO elegíveis, mas *disparar* publicação não.

Esta skill só roda por invocação explícita do editor (`disable-model-invocation: true`) — o blast radius (merges autônomos em master) exige que a invocação seja o consentimento, mesmo padrão de `/diaria-remover-votos-pixel`.

## Argumentos

- `--limite HH:MM` (opcional, default `07:00`, sempre America/Sao_Paulo) — horário-limite de segurança. Resolução: na Fase 0, converter para **deadline absoluto ISO** = primeira ocorrência de HH:MM em America/Sao_Paulo **após** `started_at`, e gravar em `plan.json` (`deadline`). A checagem "passou?" é sempre comparação determinística de timestamps completos via node (ex: `node -e "process.exit(new Date() >= new Date('{deadline}') ? 1 : 0)"`) — nunca comparação mental de HH:MM (#573). Ao atingir o deadline: **não iniciar issue nova**; PR já em CI é levado até merge/draft; depois, Fase 2.
- `--dry-run` (opcional) — executa só a Fase 0 **sem nenhum side-effect externo** (não comenta em issues, não mexe em PRs) e imprime o plano. Serve de ensaio seguro.

## Fase 0 — Varredura + briefing interativo (editor ainda presente)

O objetivo é converter o máximo da fila em trabalho autônomo enquanto o editor ainda está aí pra responder. **Depois desta fase, zero interação.**

0. **Resume**: se `data/overnight/{AAMMDD}/plan.json` de hoje já existe, **pular o briefing** — retomar a Fase 1 a partir dos status do próprio `plan.json` (issues sem status terminal voltam pra fila). Nunca re-perguntar o que já foi respondido.
1. **Sync**: `git checkout master && git pull` (o coordenador pode estar em outra branch — pull na branch errada faria os worktrees forkarem de HEAD não-master e os PRs da noite carregarem diff alheio). Verificar `gh auth status`.
2. **PRs abertos remanescentes**: listar PRs abertos. Auto-resolver **só os de autoria desta skill** (branch prefix `overnight/`): CI verde e não-draft → merge (fluxo da Fase 1, passo 4). Qualquer outro PR aberto (bot, WIP do editor, draft de noite anterior) → vira pergunta no briefing; **nunca** auto-mergear PR que a skill não criou.
3. **Varredura**: `gh issue list --state open --limit 200 --json number,title,labels,body,url`.
4. **Classificar cada issue** em:
   - `elegivel` — direção clara e completa na issue; dá pra resolver sem perguntar nada. Issue sem label de prioridade → tratar como `P2` e anotar no plano (não inventar prioridade alta nem descartar).
   - `precisa-resposta` — ambiguidade que bloquearia autonomia: decisão editorial/produto, trade-off real entre opções equivalentes, direção não documentada, escolha de abordagem com impacto em usuário final.
   - `bloqueada-externa` — precisa de ação que só o editor pode fazer (conta de terceiro, allowlist, credencial). Comentar na issue o que falta e pular (com dedup: checar antes se já existe comentário overnight equivalente — não comentar de novo).
5. **Briefing**: para as `precisa-resposta`, fazer **todas** as perguntas de uma vez via `AskUserQuestion`, agrupadas por issue (máximo 4 perguntas por chamada e 4 opções por pergunta; header = `#NNNN`). Cada pergunta oferece opções concretas + trade-off, **e sempre inclui a opção "decido depois (pular esta issue)"**. AskUserQuestion é bloqueante — não existe "detectar que o editor não respondeu"; o briefing pressupõe editor presente (limitação documentada: se ele sair no meio, a pergunta fica pendente até ele voltar). Issue respondida → promover a `elegivel` e **postar a resposta como comentário na issue** (`gh issue comment`) — é a fonte durável, visível de qualquer máquina/sessão; `plan.json` é cache. "Decido depois" → status `pulada` (sem comentário — a issue não foi prometida).
6. **Plano da rodada**: gravar em `data/overnight/{AAMMDD}/plan.json`. **`{AAMMDD}` = data local de início da rodada, fixada AQUI e relida de `plan.json` em todas as fases seguintes — nunca recomputada de today()** (toda rodada cruza a meia-noite).
   ```json
   {
     "started_at": "ISO", "deadline": "ISO (resolvido do --limite)",
     "issues": [{ "number": 123, "priority": "P1", "status": "elegivel", "briefing": "resposta do editor, se houve" }]
   }
   ```
   Status possíveis: `elegivel`, `pulada` (motivo: `sem-resposta` | `bloqueio-externo`), e os terminais da Fase 1: `mergeada`, `draft-ci-vermelho`.
7. Apresentar o plano resumido ao editor (N elegíveis em ordem P0 > P1 > P2 > P3, M puladas, K bloqueadas). **Se 0 elegíveis, dizer isso agora e encerrar aqui** — é a última chance do editor destravar algo respondendo mais perguntas; não rodar uma noite vazia. Com `--dry-run`, parar aqui (sem comentários postados).

## Fase 1 — Loop de resolução

Uma issue por vez, sempre a de maior prioridade (P0 > P1 > P2 > P3; empate → número menor = mais antiga). **No início de cada iteração, reler `plan.json`** — após compaction de contexto, ele é a única fonte confiável do briefing e dos status. A cada iteração:

1. **Checar o deadline** (comparação determinística contra `plan.json.deadline`, ver Argumentos). Passou → ir pra Fase 2.
2. **Re-checar a fila**: `gh issue list --state open --limit 200 --json number,title,labels,state` (sem `body` — corpo só de issues novas, via `gh issue view {N} --json body`; o coordenador precisa ficar enxuto). Issue fechada externamente → marcar `pulada` no plano e não trabalhar. Issue nova com direção clara → entra como `elegivel`; issue nova ambígua → `pulada` **sem comentário** (o briefing já passou; ela espera a próxima rodada). **Só issues sem status terminal no `plan.json` são candidatas** — uma issue que já virou `draft-ci-vermelho` ou `pulada` nunca é re-escolhida na mesma rodada (anti-livelock).
3. **Dispatchar um subagente por issue** (`Agent`, `subagent_type: "general-purpose"`, `isolation: "worktree"` — nunca um agente especializado do repo: eles têm toolset restrito e não conseguem commitar/pushar). O prompt do subagente inclui, obrigatoriamente:
   - corpo da issue + resposta do briefing (lida de `plan.json`);
   - regras do repo: #633 (bugfix exige teste de regressão), convenções de commit/PR do CLAUDE.md;
   - **guard de publicação**: editar código de publisher é ok; **EXECUTAR é proibido** — nunca rodar `scripts/publish-*`, `clarice-schedule-sends`, `clarice-import-*`, `close-poll`, `inject-poll-sig` ou qualquer script que toque Beehiiv/LinkedIn/Facebook/Brevo ao vivo, nem em "teste";
   - bootstrap do worktree: **primeiro passo é `npm ci`** (worktree novo não tem `node_modules/` nem a junction `data/`); testes = **`npm test`** (inclui o pretest guard #1948);
   - **se um hook pós-`gh pr create` exigir code-review, NÃO executar** — anotar no body do PR que o review noturno fica a cargo do coordenador, e retornar (subagente não pode dispatchar Agent, #207; e N reviews de esforço máximo por noite não cabem no orçamento).
   O subagente implementa, roda `npm test`, commita em branch **`overnight/fix-NNNN`** com `(#NNNN)` no título, push, abre PR com `Closes #NNNN`, e retorna o número do PR.
4. **Revisar, esperar CI e mergear** (coordenador, nunca o subagente):
   - **Review leve antes do merge**: ler o diff do PR (`gh pr diff {N}`) e sanity-checkar contra a issue + briefing — substitui o review pesado pulado pelo subagente; se o diff parecer errado, tratar como CI vermelho (tentativa de fix).
   - Esperar CI com `gh pr checks {N} --watch` em background (`run_in_background: true`) — um acordar por PR, sem poll. Interpretar com cuidado: **exit 8 / checks pendentes / lista vazia = PENDENTE, nunca verde nem vermelho** (logo após o push os jobs podem nem estar registrados). Verde = os checks do CI **presentes E concluídos com sucesso** (`gh pr checks {N} --json bucket` pra confirmar). master não tem branch protection — o único guard é esta disciplina.
   - Verde → `gh pr merge {N} --squash --subject "{título} (#NNNN)" --body "...\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>"` — **sem `--delete-branch`** (a branch está checked out no worktree do subagente; a deleção local falharia e o exit non-zero seria lido como merge falho). **Confirmar o estado real via `gh pr view {N} --json state,mergedAt` SEMPRE — inclusive (principalmente) quando `gh pr merge` retornar erro** (#573): merge remoto pode ter sucedido com falha local. Depois: limpar o worktree do subagente (`git worktree prune` + remover diretório) e deletar a branch remota (`git push origin --delete overnight/fix-NNNN`).
   - Vermelho (de verdade) → até **2 tentativas de fix**: continuar o mesmo subagente via `SendMessage` com o **tail do log de falha** (`gh run view --log-failed`, últimas ~100 linhas por step — nunca o log inteiro); se o subagente não estiver mais disponível, dispatchar um novo **fazendo checkout da branch `overnight/fix-NNNN` existente** (nunca refazer de master). Persistiu vermelho → converter pra draft (`gh pr ready --undo`), comentar na issue com diagnóstico + link, marcar `draft-ci-vermelho` no plano, e seguir pra próxima.
5. **Manter #636**: nunca 2 PRs não-draft abertos simultaneamente; o próximo só começa depois do desfecho do anterior. Drafts de CI-vermelho ficam abertos para triage do editor — são exceção consciente, sinalizados no relatório.
6. **Atualizar `plan.json`** com o status terminal da issue e **logar a iteração** via `npx tsx scripts/log-event.ts` (run-log canônico, `agent: "overnight"`, edition = AAMMDD da rodada) — assim `/diaria-log` enxerga a noite.
7. `git pull` em master após cada merge, antes da próxima issue.

**Condições de parada:** fila elegível esgotada · deadline atingido · erro irrecuperável (auth do gh expirada, rede fora por > 30 min) → renderizar halt banner (`npx tsx scripts/render-halt-banner.ts --stage "overnight" --reason "..." --action "..."`) + relatório antecipado com o motivo.

## Fase 2 — Relatório

1. Compilar o digest da noite a partir de `plan.json` + run-log (filtrado por `agent: "overnight"` + AAMMDD da rodada):
   - resolvidas (com links de PR e commits de merge — estados confirmados via `gh pr view`, nunca de memória),
   - puladas e por quê (sem briefing, bloqueio externo, CI vermelho persistente — com link do draft),
   - estado final da fila (`gh issue list` fresco).
2. Salvar em `data/overnight/{AAMMDD}/report.md` (AAMMDD do `plan.json`, não recomputado).
3. Criar **rascunho** no Gmail via MCP `create_draft` para `vjpixel@gmail.com`, subject `Diar.ia overnight {AAMMDD} — {X} resolvidas, {Y} puladas`. **Atenção à semântica: `create_draft` NÃO envia** — o rascunho fica em Drafts, sem notificação. O canal primário do relatório é o **resumo no terminal** (passo 5); o draft é cópia formatada pra arquivo/encaminhamento.
4. **Fail-soft**: Gmail MCP indisponível → NÃO travar. Esta é uma exceção consciente e local ao #738 (que protege stages de edição em andamento): aqui não há pipeline pra corromper e ninguém presente pra responder ao halt — avisar no terminal que o relatório ficou só local e encerrar normalmente. Não citar esta exceção como precedente fora do relatório overnight.
5. Imprimir o resumo no terminal — é a primeira coisa que o editor vê ao voltar.

## Regras

- **Nunca** disparar publicação (Beehiiv/LinkedIn/Facebook/Brevo) ou rodar stages da pipeline editorial durante a rodada — e o guard vai **dentro do prompt de cada subagente**, não só aqui.
- #636 (1 PR por vez), #633 (teste de regressão em bugfix) e validação determinística de estado externo (#573) valem a noite inteira, sem exceção.
- Toda issue **trabalhada ou bloqueada** recebe comentário com o que foi feito ou o que falta (com dedup — nunca repetir comentário equivalente). Issues resolvidas dispensam comentário extra: o merge com `Closes #NNNN` já conta a história na timeline.
- `data/overnight/` segue o blanket gitignore de `data/` — relatórios não vão pro repo.
- Stall passivo é inaceitável: toda espera usa `gh pr checks --watch` em background ou poll com intervalo explícito, e tem timeout.
