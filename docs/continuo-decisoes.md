# Decisões e histórico de `/diaria-continuo`

Rationale e histórico de implementação da skill `/diaria-continuo`
(`.claude/skills/diaria-continuo/SKILL.md`) — extraído de lá em #5344 Parte
B4 (mesma disciplina do #5307 pro `CLAUDE.md`: o `SKILL.md` é relido a cada
wake do coordenador, então conteúdo não-operacional (rationale, histórico de
implementação) paga esse custo repetidamente sem precisar. Nada foi
perdido, só realocado — este arquivo preserva o texto original na íntegra.

Se uma seção abaixo citar "esta unidade"/"nesta unidade", o antecedente é a
unidade de trabalho que implementou aquele item na época (não a unidade do
#5344 que moveu o texto pra cá).

---

## Decisões já tomadas (briefing com o editor, 14/08/2026)

| Eixo | Decisão | Nota |
|---|---|---|
| **Canal das perguntas** | `AskUserQuestion` **bloqueante**, no terminal | Sem fila assíncrona paralela. Ver "Risco aceito" abaixo. |
| **Forma** | **Skill nova** (`/diaria-continuo`), não flag `--forever` do overnight | Mantém a Regra 1 do overnight literal e sem exceção condicional. |
| **Ocioso** | **Só re-varre issues e dorme** | Não vira geradora de trabalho — ver "Loop invariável" no `SKILL.md`. |
| **Blast radius** | **Tudo que a resposta destravar**, inclusive cat. D | A resposta do editor é o consentimento — sem gate adicional pós-resposta. |
| **Kind no `session-registry.ts`** | **`"continuo"`, dedicado** (#5293 item 2) | Não reusa `"overnight"` — preserva o guard `block-askuserquestion-overnight-autonomous.mjs`, que depende de "overnight nunca pergunta". |
| **Guard de colisão editorial** | **PAUSA, nunca encerra** (#5293 item 4) | Diferente do overnight (preempta a rodada inteira) — heartbeat `--phase pausado-edicao`, dorme, retoma quando a edição termina. |
| **Rotação de `plan.json`** | **Diária, por dia civil BRT** (#5293 item 5) | `continued_from` encadeia os dias; config de sessão (`bugs_only`/`priority_filter`) carrega adiante, dados do dia não. |

## Risco aceito: `AskUserQuestion` bloqueante numa sessão que roda o tempo todo

Registrado explicitamente porque contraria a regra mais dura do overnight
(Regra 1, "zero perguntas pós-briefing"), e o editor decidiu assim mesmo com
o trade-off na mesa:

- **Incidente de referência 260706/07 (#3037/#3038):** um `AskUserQuestion`
  sobre uma decisão trivial travou uma rodada overnight por ~8h porque o
  editor estava dormindo. Foi esse incidente que produziu a Regra 1 do
  overnight.
- **Por que é tolerável aqui, e não lá:** no overnight, travar significa
  perder a janela de trabalho autônomo da noite inteira. Aqui, travar
  acontece **só depois que a fila desbloqueada já esgotou** — não há
  trabalho autônomo sendo desperdiçado, por definição (passo 3 do loop só
  roda quando o passo 1 não tem mais nada pra fazer). A skill parada
  esperando resposta e a skill dormindo (passo 6) são estados equivalentes
  em produtividade.
- **Mitigação — status investigado numa unidade anterior, FECHADO nesta;
  canal definido como e-mail em #5341.** A issue original citava o client de
  notificação push genérico da época (substituído em #5341 por
  `scripts/lib/push-notify.ts`) e o `gate-chat-bridge.js` do Studio
  (#3557/#3617/#3804) como já existentes e suficientes. Achado da unidade
  anterior (leitura direta do código):
  - **`scripts/studio-ui/studio-push-notify.ts`** só dispara pra
    `AskUserQuestion` pendente em `chatPermissionsPending`
    (`studio-chat.ts`) — populado só por sessões abertas **através do
    drawer do Studio**, não por uma sessão de terminal comum.
  - **`scripts/studio-ui/public/gate-chat-bridge.js`** cobre gates
    **editoriais** (`gatesPending`, Stage 4/6 de uma edição), não
    `AskUserQuestion` genérico de uma sessão de backlog de issues.
  - **Nenhum dos dois cobre o caminho que esta skill de fato usa** (decisão
    do briefing: "no terminal", tabela acima) — ficou registrado como
    pendência explícita, não resolvida naquela unidade.
  - **Fechado nesta unidade (#5293 item 3, achado adjacente); canal
    definido como e-mail em #5341 (decisão do editor: padronizar em e-mail
    em vez de exigir um app de mensagens novo):**
    `.claude/hooks/notify-continuo-askuserquestion.mjs`, um
    `PreToolUse` hook novo registrado no MESMO matcher `AskUserQuestion` que
    `block-askuserquestion-overnight-autonomous.mjs` já usa
    (`.claude/settings.json`). Lê `session_id` do payload do hook, varre
    `data/sessions/` por um registro `continuo-*-{session_id}.json` ativo
    (`session-registry.ts`) e, se encontrar, envia um e-mail direto via
    Gmail API (refresh OAuth + `users.messages.send` — reimplementado
    inline, não importado de `scripts/lib/gmail-send.ts`/`google-auth.ts`,
    por ser um hook self-contained, mesma convenção do hook irmão; mesma
    credencial `data/.credentials.json` que os 17 alarmes agendados já
    usam). **NUNCA bloqueia** — é observação pura, roda em paralelo ao hook
    que decide bloquear/permitir. Testado em
    `test/notify-continuo-askuserquestion.test.ts`. **Limitação residual
    honesta:** funciona só se `data/.credentials.json` (OAuth Google) estiver
    configurado na máquina (`npx tsx scripts/oauth-setup.ts`) — sem ele, o
    hook é um no-op silencioso e o risco aceito original (travar sem aviso)
    volta a valer integralmente. **Credenciais presentes mas rejeitadas**
    (refresh token expirado/revogado, resposta HTTP não-2xx do envio) —
    diferente de credenciais AUSENTES — loga em stderr (`resp.status`+corpo,
    ou a exceção de rede) em vez de descartar silenciosamente (#5293 fleet
    review, achado 4); ainda assim nunca bloqueia o `AskUserQuestion`. stderr
    de hook não tem superfície de alerta própria neste repo — só aparece se
    alguém estiver olhando o terminal/journalctl no momento, o que é
    exatamente a situação que este hook existe pra não depender. Fechar essa
    lacuna (ex: um segundo canal de alerta pra falha do PRÓPRIO alerta) é
    follow-up, não bloqueio desta unidade. **Ressalva de responsividade
    (#5341):** e-mail não interrompe como um push de celular — depende do
    editor ter notificação de e-mail ativa no telefone; degradação aceita
    conscientemente em troca de não exigir um app de mensagens novo.

## Itens 3-6 — estado (#5293)

A 1ª unidade implementou só os itens 1-2 (o `SKILL.md` + o kind
`"continuo"` em `scripts/lib/session-registry.ts`). Esta unidade fechou os
quatro restantes — cada um com código + testes, não só prosa:

1. **Watchdog — RESOLVIDO.** `scripts/overnight-watchdog.ts` agora vigia
   `data/continuo/` além de `data/overnight/` na mesma invocação
   (`WATCHED_KINDS`), e `findActiveRun(rootDir, "continuo")` trata "ativa"
   como "`plan.json` existe no `{AAMMDD}` mais recente" — nunca depende de
   `report.md` (que `continuo` nunca escreve, ao contrário do overnight).
   Antes de declarar stall, `hasHealthyIdleSession` consulta
   `session-registry.ts` por uma sessão `continuo` ativa com `phase` em
   `HEALTHY_IDLE_PHASES` (`"aguardando-resposta"` | `"pausado-edicao"`) — se
   encontrar, o diagnóstico vira `healthy_idle` (não `stall`), sem
   halt banner nem alerta push. **Depende do heartbeat de fase estar
   sendo gravado pelo coordenador** (ver bullet "Heartbeat de phase é
   OBRIGATÓRIO" em "Reuso da maquinaria" no `SKILL.md`) — o mecanismo é
   fail-safe no sentido de nunca mascarar um stall genuíno, mas não é
   mágico: sem heartbeat, o watchdog não tem como saber que a parada é
   saudável. Testado em `test/overnight-watchdog.test.ts` (`findActiveRun
   com kind=continuo`, `hasHealthyIdleSession`, `diagnoseWatchdogActivity`
   com `isHealthyIdle`). **Isolamento por kind (corrigido no fleet
   review):** o loop de `main()` agora envolve cada kind (`overnight`,
   `continuo`) no próprio try/catch — uma exceção ao processar um kind não
   aborta mais o loop antes de checar o outro; o processo ainda sai com
   código != 0 se algum kind falhou.
2. **Interação com `Diaria-Edicao-Diaria` — RESOLVIDO (decisão: PAUSA, não
   fim).** Diferente do overnight (que preempta a rodada inteira e grava
   `preempted_by: "edicao_editorial"`), o passo 1 do "Loop invariável" (no
   `SKILL.md`) especifica: guard de colisão detectado → heartbeat `--phase
   pausado-edicao` → pular pro passo 6 (dormir) sem consumir a fila →
   re-checar o guard a cada acordar → heartbeat de volta pra phase de
   trabalho quando a edição terminar. O merge lock existente
   (`acquireMergeLock`/`releaseMergeLock`) continua como a última linha de
   defesa contra colisão de `gh pr merge` — este guard evita gastar
   CI/worktrees durante a janela da edição, não é redundante com o lock.
3. **Rotação de `plan.json` — RESOLVIDO.**
   `scripts/lib/continuo-plan-rotation.ts` — rotação por dia CIVIL BRT
   (`todayAammdd`/`shouldRotatePlan`). `rotateContinuoPlanIfNeeded` cria
   `data/continuo/{novoAAMMDD}/plan.json` com `continued_from: {AAMMDD
   anterior}` quando o dia muda, carrega adiante `bugs_only`/
   `priority_filter` (config de sessão, não de dia), apenda uma linha em
   `data/continuo/history.jsonl`, e NUNCA toca o `plan.json` do dia anterior
   (só adiciona, nunca edita/apaga). Chamado pelo coordenador no início de
   cada re-varredura (passo 2 do loop) — idempotente, no-op na maioria das
   chamadas. Testado em `test/continuo-plan-rotation.test.ts` (17 casos,
   incluindo bootstrap, idempotência, virada de dia/mês, e falha de I/O no
   `history.jsonl` não impedindo a rotação do `plan.json` em si).
   **Leitura do `plan.json` anterior (corrigida no fleet review):** usa
   `readPlanFromDir` (mesma função com retry-em-JSON-truncado do #3353 que
   `overnight-watchdog.ts` já reusava) em vez de um `JSON.parse(readFileSync
   (...))` cru — a 1ª versão desta unidade tinha reintroduzido exatamente o
   bug que #3353 corrigiu, só que num 3º leitor do mesmo `plan.json`. Falha
   de leitura/parse (depois do retry) é logada em stderr, não silenciosa —
   `listContinuoDays` já confirmou que o arquivo existe, então um `null`
   aqui é sempre falha genuína, nunca "ausente".
4. **Instrumentação de custo acumulado — RESOLVIDO (3 partes: agregação,
   emissão, e a correção de escopo do #5344 Parte B0).**
   `scripts/continuo-cost-summary.ts` soma **duas** categorias através de
   TODOS os dias rotacionados de `data/continuo/` (não só o dia corrente —
   usa `listContinuoDays` de `continuo-plan-rotation.ts`): `details.tokens`
   dos eventos `coordinator_tokens_estimate` (categoria "Coordenador") E
   `details.subagent_tokens` dos eventos `subagent_metrics` (categoria
   "Implementação", herdada da Fase 1 do overnight reusada verbatim) —
   `totalTokens` é a soma das duas. Suporta `--since {AAMMDD}` pra bounds, e
   `--json` pra saída estruturada. Eventos sem valor (`tokens`/
   `subagent_tokens: null`, harness não expôs `usage`) são contados à parte
   (`unavailableCount`/`implementationUnavailableCount`), nunca somados como
   0. Testado em `test/continuo-cost-summary.test.ts`. **Achados corrigidos
   em ordem:** (a) a 1ª versão desta unidade entregou só a AGREGAÇÃO — a
   EMISSÃO de `coordinator_tokens_estimate` nunca foi instruída em lugar
   nenhum do `SKILL.md`, o que faria o script sempre reportar zero em
   silêncio (achado do comment-analyzer no fleet review original); corrigido
   com o bullet "Emissão de `coordinator_tokens_estimate` é OBRIGATÓRIA" em
   "Reuso da maquinaria". (b) `#5344 Parte B0` achou que a soma ignorava
   `subagent_tokens` — o grosso do gasto real de qualquer unidade de
   implementação — mesmo esse dado já existindo em teoria via a reutilização
   "verbatim" da Fase 1 do overnight; corrigido tornando a emissão de
   `subagent_metrics` explícita também (bullet dedicado, mesmo lugar) e
   somando as duas categorias no script. **Checker mecânico equivalente a
   `check-overnight-token-instrumentation.ts` agora existe**:
   `scripts/check-continuo-token-instrumentation.ts` (#5344 Parte B0) —
   mesma lógica de contagem-de-presença, adaptada pra escopo "dia
   rotacionado" em vez de "rodada" (o `continuo` não tem fim de rodada);
   checa `coordinator_tokens_estimate` + `subagent_metrics`, devolve
   `ok`/`warning` nomeando o(s) tipo(s) ausente(s). Testado em
   `test/check-continuo-token-instrumentation.test.ts`. Instruído no passo 6
   do "Loop invariável" (rodar junto de `continuo-cost-summary.ts` ao
   acordar de sono longo/rotação de dia).

**Achado adjacente, fechado nesta mesma unidade (não fazia parte dos 6 itens
originais, mas do "Risco aceito" registrado acima):**
`.claude/hooks/notify-continuo-askuserquestion.mjs` — hook `PreToolUse` que
envia um e-mail (canal definido em #5341) quando um
`AskUserQuestion` pendente pertence a uma sessão `continuo` ativa, cobrindo
especificamente o caminho "sessão de terminal comum" que
`studio-push-notify.ts`/`gate-chat-bridge.js` não cobrem. Ver detalhe
completo na seção "Risco aceito" acima.

**Residual, honestamente não resolvido:** nenhuma invocação real desta
skill aconteceu ainda em produção — todo o mecanismo acima foi validado por
teste unitário/isolado (tmpdir, sem tocar `data/` real), não por uma rodada
de ponta a ponta. A 1ª invocação em produção deve ser tratada como o
primeiro teste de integração real do conjunto — acompanhar de perto
(heartbeats sendo gravados, watchdog não alarmando falso-positivo, rotação
acontecendo na virada do dia) antes de considerar o mecanismo
operacionalmente maduro.
