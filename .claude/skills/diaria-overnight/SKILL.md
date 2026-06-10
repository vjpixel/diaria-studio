---
name: diaria-overnight
description: Assume o turno no fim do dia (#2021) — varre as issues abertas, faz briefing interativo com o editor antes dele sair, e resolve a fila autonomamente durante a noite (PR → CI → auto-merge), com relatório por email ao final. Uso — `/diaria-overnight [--limite HH:MM] [--dry-run]`.
---

# /diaria-overnight

O editor invoca esta skill ao encerrar o expediente. Você assume o turno: varre a fila de issues do GitHub, tira todas as dúvidas com o editor **antes** dele sair (briefing único), e depois trabalha a fila de forma 100% autônoma até esgotá-la ou até o horário-limite. Ao final, envia um relatório da noite por email.

Escopo = **resolver issues de código/config/docs do repo**. Fora de escopo: executar a pipeline editorial (pesquisa, escrita, publicação de edição) — mudanças em código de publishers/Workers SÃO elegíveis, mas *disparar* publicação não.

## Argumentos

- `--limite HH:MM` (opcional, default `07:00` BRT) — horário-limite de segurança. Ao atingir, encerra a iteração corrente (espera CI do PR aberto resolver, se houver) e pula pro relatório.
- `--dry-run` (opcional) — executa só a Fase 0 (varredura + briefing + plano) e imprime o plano sem trabalhar nenhuma issue.

## Fase 0 — Varredura + briefing interativo (editor ainda presente)

O objetivo é converter o máximo da fila em trabalho autônomo enquanto o editor ainda está aí pra responder. **Depois desta fase, zero interação.**

1. **Sync**: `git fetch origin` + confirmar que `master` local está atualizado (`git pull` se fast-forward limpo). Verificar `gh auth status`. Se houver PR aberto de sessão anterior, resolver primeiro (#636): CI verde → merge; senão → perguntar ao editor no briefing o que fazer com ele.
2. **Varredura**: `gh issue list --state open --limit 200 --json number,title,labels,body,url`.
3. **Classificar cada issue** em:
   - `elegivel` — direção clara e completa na issue; dá pra resolver sem perguntar nada.
   - `precisa-resposta` — ambiguidade que bloquearia autonomia: decisão editorial/produto, trade-off real entre opções equivalentes, direção não documentada, escolha de abordagem com impacto em usuário final.
   - `bloqueada-externa` — precisa de ação que só o editor pode fazer (conta de terceiro, allowlist, credencial). Comentar na issue o que falta e pular (regra já existente do CLAUDE.md).
4. **Briefing**: para as `precisa-resposta`, fazer **todas** as perguntas de uma vez via `AskUserQuestion`, agrupadas por issue (batches de até 4 perguntas por chamada, header = `#NNNN`). Cada pergunta deve oferecer opções concretas + descrição do trade-off. Issue cuja resposta foi dada → promover a `elegivel`. Sem resposta ou "decido depois" → rebaixar a `pulada` (comentar na issue que ficou aguardando input do editor).
5. **Plano da rodada**: gravar em `data/overnight/{AAMMDD}/plan.json` (AAMMDD = data de hoje, início da rodada):
   ```json
   {
     "started_at": "...", "limite": "07:00",
     "issues": [{ "number": 123, "priority": "P1", "status": "elegivel", "briefing": "resposta do editor, se houve" }]
   }
   ```
6. Apresentar o plano resumido ao editor (N elegíveis em ordem P0 > P1 > P2 > P3, M puladas, K bloqueadas) e começar. Com `--dry-run`, parar aqui.

## Fase 1 — Loop de resolução

Uma issue por vez, sempre a de maior prioridade (P0 > P1 > P2 > P3; empate → número menor = mais antiga). A cada iteração:

1. **Checar horário-limite.** Passou → ir pra Fase 2.
2. **Re-checar a fila** (`gh issue list` de novo) — issues podem ter sido abertas/fechadas durante a noite. Issue nova `elegivel` entra no plano; issue nova `precisa-resposta` → pulada com comentário (o briefing já passou).
3. **Dispatchar um subagente por issue** (`Agent`, `isolation: "worktree"`) com contexto isolado — a fila pode ser longa e o coordenador precisa ficar enxuto. O prompt do subagente inclui: corpo da issue, resposta do briefing (se houve), regras do repo (#633 — bugfix exige teste de regressão; convenções de commit/PR do CLAUDE.md). O subagente implementa, roda os testes localmente, commita em branch `fix/...` ou `feat/...` com `(#NNNN)` no título, push, abre PR com `Closes #NNNN` no body, e retorna o número do PR.
4. **Esperar CI e mergear** (coordenador, nunca o subagente):
   - Poll determinístico: `gh pr checks {N}` a cada ~4 min (`ScheduleWakeup` com ~240s entre checagens; nunca stall passivo).
   - CI verde → `gh pr merge {N} --squash --delete-branch`. **Verificar o merge de fato** via `gh pr view {N} --json state,mergedAt` antes de registrar como resolvida (#573 — nunca confiar só no gloss; estado externo se valida com comando determinístico).
   - CI vermelho → até **2 tentativas de fix** (continuar o mesmo subagente via SendMessage com o log do CI). Persistiu vermelho → converter o PR pra draft (`gh pr ready --undo`), comentar na issue com diagnóstico + link, e seguir pra próxima.
5. **Manter #636 à risca**: nunca 2 PRs abertos simultaneamente. O próximo só começa depois do merge (ou draft) do anterior.
6. **Logar a iteração** em `data/overnight/{AAMMDD}/log.jsonl` — `{timestamp, issue, action, pr, outcome, details}` (append-only, mesmo espírito do `run-log.jsonl`).
7. `git pull` no master local após cada merge, antes da próxima issue.

**Condições de parada:** fila elegível esgotada · horário-limite atingido · erro irrecuperável (auth do gh expirada, rede fora por > 30 min) → relatório antecipado com o motivo.

## Fase 2 — Relatório

1. Compilar o digest da noite a partir de `plan.json` + `log.jsonl`:
   - resolvidas (com links de PR e commits de merge),
   - puladas e por quê (sem briefing, bloqueio externo, CI vermelho persistente — com link do draft),
   - estado final da fila (`gh issue list` fresco).
2. Salvar em `data/overnight/{AAMMDD}/report.md`.
3. Enviar por email via Gmail MCP `create_draft` para `vjpixel@gmail.com`, subject `Diar.ia overnight {AAMMDD} — {X} resolvidas, {Y} puladas` (mesmo mecanismo do `send-edition-report.ts`, #1483).
4. **Fail-soft**: Gmail MCP indisponível → NÃO travar (o halt do #738 é pra stages de edição). Avisar no terminal que o relatório ficou só local e encerrar normalmente.
5. Imprimir o resumo no terminal — é a primeira coisa que o editor vê ao voltar.

## Regras

- **Nunca** disparar publicação (Beehiiv/LinkedIn/Facebook/Brevo) ou rodar stages da pipeline editorial durante a rodada.
- #636 (1 PR por vez), #633 (teste de regressão em bugfix) e validação determinística de estado externo (#573) valem a noite inteira, sem exceção.
- Toda issue tocada recebe comentário com o que foi feito ou por que foi pulada — nada sai da fila silenciosamente.
- `data/overnight/` segue o blanket gitignore de `data/` — relatórios não vão pro repo.
- Stall passivo é inaceitável: toda espera (CI, rede) usa `ScheduleWakeup`/poll com intervalo explícito e tem timeout.
