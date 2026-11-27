# Task diária: evaluate do canal `brevo_diaria`

Issue: [#4534](https://github.com/vjpixel/diaria-studio/issues/4534) (fecha o checkbox aberto na [#4476](https://github.com/vjpixel/diaria-studio/issues/4476), seção "Cadência de execução").

## Problema que isso resolve

O envio diário do canal `brevo_diaria` (`scripts/publish-daily-brevo.ts`) mira a **lista inteira** na Brevo — não consulta o store por contato. Isso significa que, sem uma ação separada, alguém só para de receber a diária pela Brevo se for **desvinculado da lista** manualmente.

`scripts/evaluate-brevo-diaria.ts` já faz esse trabalho corretamente (descadastro nativo, auto-confirmação, promoção/supressão por score — todos terminando em `unlinkFromBrevoList`), mas até esta issue só rodava por invocação manual. Consequência prática: quem se cadastra na Beehiiv vindo da diária Brevo (link de reativação, formulário do site, qualquer link da edição) continua recebendo a diária **duas vezes** (Beehiiv + Brevo) por tempo indeterminado, e o cap diário de envio (`checkDailySendCap`) conta a lista inteira em vez da população `in_brevo` real.

## O que a task faz

**Desde o #13981 (27/11/2026)** a task roda `scripts/brevo-diaria-daily-apply.ts`, que chama o `brevo-diaria-run.ts --apply` inteiro: começa pelo mesmo `evaluate-brevo-diaria.ts --push` descrito abaixo e segue com o refresh do pool Pending, MV, sync Brevo, pool Kit inactive, `sync-kit-frio --push` e órfãos da `envio-brevo`. Motivo: o dispatch da Etapa 5 sai `skipped` fora da segunda (regime semanal #11226) sem rodar o `--apply`, e sem esta task ele rodaria uma vez por semana. O dispatch, nas edições com campanha, roda sempre o `--apply` antes do publish e grava o marcador do dia (`data/brevo-diaria/.daily-apply.json`, `scripts/lib/brevo-diaria-daily-apply.ts`); a task pula se o marcador já é do dia BRT e veio sem aviso. Custo aceito: em dia com campanha o `--apply` roda 2 vezes (no regime semanal, só no dia do dispatch da edição de segunda; no regime diário ou de transição, todo dia). Lock local da máquina (`os.tmpdir()`), nunca em `data/`, que sincroniza pelo Drive. Exit da task: 0 (ok, ou pulou), 3 (o `--apply` terminou com aviso fail-soft, inclusive o exit 3 do evaluate), 105 (falha só de rede, a unit tenta de novo em 15 min, `retryOnTransientNetwork: "step-declares"`), 1 (config inválida, lock, erro duro do `--apply`). Kill switch (`brevo_diaria` ausente ou `stage5_target_total: null`): roda só o `evaluate --push`, como antes do #13981, e propaga o exit dele (3 incluso); valor presente e inválido sai 1.

Antes do #13981, a task `Diaria-Brevo-Diaria-Evaluate` (`scripts/lib/scheduled-tasks.ts`) rodava só `npx tsx scripts/evaluate-brevo-diaria.ts --push` — o fluxo **completo** já aprovado no desenho da #4476 (não reaberto aqui):

1. **Descadastro nativo** (Passo 0) — contato que clicou no opt-out do bloco de intro (`emailBlacklisted: true` na Brevo) é reconhecido como saída terminal e a Beehiiv é atualizada em paralelo (`unsubscribe: true`, #4538).
2. **Auto-confirmação** (Passo 1) — contato que confirmou o double opt-in da Beehiiv por conta própria nesse meio-tempo é promovido, independente da taxa de abertura.
3. **Promoção/supressão por score** (Passo 2) — mesmo piso de amostra dos dois lados (`sends_count>=3`) e `openRate>51%` ESTRITO promove pra Beehiiv (revisado de `>=50%`, decisão do editor #4637 260805b); `sends_count>=3` (só envios com ≥48h de maturação) e `openRate<=20%` suprime (`emailBlacklisted: true`, nunca deleta). Piso exato vive em `scripts/lib/shared/brevo-diaria-score.ts` — não duplicado aqui, pra não desatualizar de novo se ele mudar.

Toda ação que remove alguém da avaliação futura (promoção, supressão, descadastro nativo) termina com `unlinkFromBrevoList` — é esse passo final que fecha o gap do #4534: sem ele, a pessoa continua na lista mesmo depois de resolvida.

Ver o cabeçalho de `scripts/evaluate-brevo-diaria.ts` para o histórico completo do desenho (issues #4266/#4476/#4488/#4538) — não duplicado aqui.

## Horário: 05:30 BRT

O valor do cron diário é **higiene contínua da lista** — descadastro nativo,
auto-confirmação e promoção/supressão por engajamento rodando todo dia,
independente de haver campanha nova nesse dia. Isso reduz o número de
contatos desatualizados que a skill `/diaria-brevo-diaria` (Passo 1) precisa
resolver na hora, mas **não substitui** aquele passo: a Brevo congela os
destinatários no **agendamento da campanha**, não no envio (ver memória de
sessão "Brevo: snapshot de destinatários"), e `publish-daily-brevo.ts` nunca
agenda a campanha via API — quem agenda é sempre um clique manual do editor
no painel da Brevo, em horário arbitrário, que pode acontecer horas antes das
05:30. Um cron de horário fixo não tem como garantir que roda antes de um
clique sem horário fixo — por isso o Passo 1 da skill roda a mesma
reavaliação de novo, na mesma sessão em que a campanha é criada/agendada
(ver `.claude/skills/diaria-brevo-diaria/SKILL.md` Passo 1).

**Em aberto:** não está decidido se vale a pena manter o cron especificamente
às 05:30 (relação com o envio canônico das 06:00) ou se qualquer horário
diário serviria igualmente bem para o propósito de higiene contínua — ver
#4937 para o contexto completo.

## Fuso horário

`scheduleToOnCalendar` (`scripts/lib/systemd-units.ts`) já embute `America/Sao_Paulo` (BRT) explicitamente no `OnCalendar=` gerado — não depende do fuso do sistema. Isso é ainda mais crítico aqui do que em `docs/scheduled-edicao-setup.md` — o evaluate precisa disparar estritamente ANTES das 06:00 BRT do envio canônico (ver seção anterior).

## Setup (ação local one-time do editor — NÃO feito nesta sessão)

Requer Linux/systemd + o link `data/` para o Google Drive da diaria.editor (#12359; era o OneDrive até 11/11/2026) + `BREVO_DIARIA_API_KEY` + `BEEHIIV_API_KEY` (+ opcional `BEEHIIV_PUBLICATION_ID`, fallback `platform.config.json`). Desde o #13981 a task roda o `--apply` inteiro, então precisa também de `MILLION_VERIFIER_API_KEY` (verificação MV do pool Pending e do pool Kit inactive) e `KIT_API_KEY` (pool Kit inactive, `sync-kit-frio`, órfãos da `envio-brevo`). O antigo `.ps1` do Windows foi removido no #5115 (cutover final).

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Brevo-Diaria-Evaluate
systemctl --user daemon-reload
systemctl --user enable --now diaria-brevo-diaria-evaluate.timer
```

Isso registra a task `Diaria-Brevo-Diaria-Evaluate` (diária, 05:30). Idempotente — re-executar regenera os units. Remover: `systemctl --user disable --now diaria-brevo-diaria-evaluate.timer`.

### Verificar a task registrada

```bash
systemctl --user list-timers diaria-brevo-diaria-evaluate.timer
```

### Antes de confiar na task em produção

**Desde o #13981**, a validação manual do passo da task é em duas etapas, no checkout que roda a task (`300`):

```bash
# 1. dry-run da sequência inteira (Passos 1-3 + pools), sem mutar nada
npx tsx scripts/brevo-diaria-run.ts --preflight
# 2. o passo da task de verdade (--apply, grava o marcador do dia)
npx tsx scripts/brevo-diaria-daily-apply.ts; echo "exit=$?"
```

`exit=0` limpo, `3` com aviso fail-soft (ler as linhas `AVISO:`), `105` falha só de rede (a unit tentaria de novo em 15 min), `1` config inválida, lock ou erro duro do `--apply`. Rodar o passo 2 de novo no mesmo dia, sem aviso, sai 0 sem fazer nada (marcador do dia).

Antes do #13981 (e ainda no kill switch, `stage5_target_total: null`), o que a task roda é só o evaluate. Rodar o `--push` uma vez manualmente e conferir o resumo antes de deixar a task rodar sozinha:

```powershell
npx tsx scripts/evaluate-brevo-diaria.ts --push
```

A saída (stderr) resume quantos contatos foram descadastrados nativamente, auto-confirmados, promovidos, suprimidos, mantidos e quantos falharam — nenhuma dessas categorias deveria crescer descontroladamente numa única run (os 98 contatos atuais em `data/brevo-diaria/contacts.json`, todos ainda `in_brevo`/`last_evaluated_at: null`, são o baseline esperado da primeira execução).

Pra só inspecionar sem gravar nada (dry-run, sem `--push`):

```powershell
npx tsx scripts/evaluate-brevo-diaria.ts
```

### Log

`data/brevo-diaria/.evaluate.log` (append-only, uma seção por execução, mesmo padrão resiliente de log dos demais alarmes/tasks do projeto — arquivo temporário fora de `data/` primeiro, anexado ao log final com retry curto).

## Follow-up explícito deste PR

Nem o registro da task no systemd nem a 1ª execução `--push` ao vivo foram feitos nesta sessão — o dispatch rodou num worktree isolado, sem acesso ao agendador real da máquina do editor nem a credenciais `BREVO_DIARIA_API_KEY`/`BEEHIIV_API_KEY` ao vivo (mesma disciplina de #4320/#4382/#4490). **Ação pendente do editor pós-merge:** rodar os comandos `setup-systemd-timers.ts`/`systemctl` acima e, antes de confiar na task, o `--push` manual descrito nesta seção.

## Arquivos

| Arquivo | Função |
|---|---|
| `scripts/brevo-diaria-daily-apply.ts` | Passo da task desde o #13981: `brevo-diaria-run.ts --apply` diário, kill switch, exits 0/3/105/1 |
| `scripts/lib/brevo-diaria-daily-apply.ts` | Marcador `data/brevo-diaria/.daily-apply.json` (dia BRT, `by`, `warnings`) e lock local (`os.tmpdir()`) |
| `scripts/brevo-diaria-run.ts` | Sequência do `--apply` (evaluate, pool Pending, MV, sync Brevo, pools Kit, `sync-kit-frio`, órfãos) |
| `scripts/brevo-diaria-stage5-dispatch.ts` | Dispatch da Etapa 5: skip rápido fora da segunda; com campanha roda o `--apply` e grava o marcador |
| `scripts/evaluate-brevo-diaria.ts` | Lógica de avaliação (descadastro nativo + auto-confirmação + score) |
| `scripts/lib/task-runner.ts` | Executor da task agendada (log resiliente + exit code honesto) |
| `scripts/lib/scheduled-tasks.ts` | Registro declarativo (schedule, steps) da task `Diaria-Brevo-Diaria-Evaluate` |
| `docs/evaluate-brevo-diaria-setup.md` | Esta documentação |
| `test/evaluate-brevo-diaria-4266.test.ts` | Testes de regressão da lógica de avaliação (#633) |
| `test/brevo-diaria-stage5-skip-rapido-13981.test.ts` | Regressão do #13981: skip rápido, task diária, marcador, lock, kill switch |
| `test/task-runner.test.ts` | Testes de regressão do executor (log resiliente + exit code honesto) |
