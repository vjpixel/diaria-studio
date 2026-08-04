# Task diária: evaluate do canal `brevo_diaria`

Issue: [#4534](https://github.com/vjpixel/diaria-studio/issues/4534) (fecha o checkbox aberto na [#4476](https://github.com/vjpixel/diaria-studio/issues/4476), seção "Cadência de execução").

## Problema que isso resolve

O envio diário do canal `brevo_diaria` (`scripts/publish-daily-brevo.ts`) mira a **lista inteira** na Brevo — não consulta o store por contato. Isso significa que, sem uma ação separada, alguém só para de receber a diária pela Brevo se for **desvinculado da lista** manualmente.

`scripts/evaluate-brevo-diaria.ts` já faz esse trabalho corretamente (descadastro nativo, auto-confirmação, promoção/supressão por score — todos terminando em `unlinkFromBrevoList`), mas até esta issue só rodava por invocação manual. Consequência prática: quem se cadastra na Beehiiv vindo da diária Brevo (link de reativação, formulário do site, qualquer link da edição) continua recebendo a diária **duas vezes** (Beehiiv + Brevo) por tempo indeterminado, e o cap diário de envio (`checkDailySendCap`) conta a lista inteira em vez da população `in_brevo` real.

## O que a task faz

`scripts/run-evaluate-brevo-diaria.ps1` roda `npx tsx scripts/evaluate-brevo-diaria.ts --push` — o fluxo **completo** já aprovado no desenho da #4476 (não reaberto aqui):

1. **Descadastro nativo** (Passo 0) — contato que clicou no opt-out do bloco de intro (`emailBlacklisted: true` na Brevo) é reconhecido como saída terminal e a Beehiiv é atualizada em paralelo (`unsubscribe: true`, #4538).
2. **Auto-confirmação** (Passo 1) — contato que confirmou o double opt-in da Beehiiv por conta própria nesse meio-tempo é promovido, independente da taxa de abertura.
3. **Promoção/supressão por score** (Passo 2) — `sends_count>=2` e `openRate>=50%` promove pra Beehiiv; `sends_count>=3` (só envios com ≥48h de maturação) e `openRate<=20%` suprime (`emailBlacklisted: true`, nunca deleta).

Toda ação que remove alguém da avaliação futura (promoção, supressão, descadastro nativo) termina com `unlinkFromBrevoList` — é esse passo final que fecha o gap do #4534: sem ele, a pessoa continua na lista mesmo depois de resolvida.

Ver o cabeçalho de `scripts/evaluate-brevo-diaria.ts` para o histórico completo do desenho (issues #4266/#4476/#4488/#4538) — não duplicado aqui.

## Horário: 05:30 BRT, antes do envio das 06:00

Não é preferência — é restrição real. A Brevo **congela os destinatários no agendamento da campanha**, não no envio (ver memória de sessão "Brevo: snapshot de destinatários"). Se o evaluate rodar depois da campanha do dia já ter sido criada/agendada, o unlink de quem foi promovido/suprimido não tem efeito nesse envio específico — a pessoa recebe mesmo assim, só sai a partir do dia seguinte.

## Fuso horário

A task usa o fuso local da máquina. Confirmar `Get-TimeZone` = America/Sao_Paulo (BRT) antes de confiar no agendamento; se a máquina não estiver em BRT, ajustar o horário em `setup-evaluate-brevo-diaria-schedule.ps1`. Isso é ainda mais crítico aqui do que em `docs/scheduled-edicao-setup.md`/`docs/dashboard-schedule.md` — o evaluate precisa disparar estritamente ANTES das 06:00 BRT do envio canônico (ver seção anterior).

## Setup (ação local one-time do editor — NÃO feito nesta sessão)

Requer Windows + Task Scheduler + o junction `data/` (OneDrive) + `BREVO_DIARIA_API_KEY` + `BEEHIIV_API_KEY` (+ opcional `BEEHIIV_PUBLICATION_ID`, fallback `platform.config.json`).

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-evaluate-brevo-diaria-schedule.ps1
```

Isso registra a task `Diaria-Brevo-Diaria-Evaluate` (diária, 05:30). Idempotente — re-executar atualiza a task. Remover: mesmo comando com `-Unregister`.

### Verificar a task registrada

```powershell
Get-ScheduledTask -TaskName "Diaria-Brevo-Diaria-Evaluate" | Get-ScheduledTaskInfo
```

### Antes de confiar na task em produção

Rodar o `--push` uma vez manualmente e conferir o resumo antes de deixar a task rodar sozinha:

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

Nem o registro da task no Task Scheduler nem a 1ª execução `--push` ao vivo foram feitos nesta sessão — o dispatch rodou num worktree isolado, sem acesso ao Task Scheduler real da máquina do editor nem a credenciais `BREVO_DIARIA_API_KEY`/`BEEHIIV_API_KEY` ao vivo (mesma disciplina de #4320/#4382/#4490). **Ação pendente do editor pós-merge:** rodar o `setup-evaluate-brevo-diaria-schedule.ps1` acima e, antes de confiar na task, o `--push` manual descrito nesta seção.

## Arquivos

| Arquivo | Função |
|---|---|
| `scripts/evaluate-brevo-diaria.ts` | Lógica de avaliação (descadastro nativo + auto-confirmação + score) |
| `scripts/run-evaluate-brevo-diaria.ps1` | Wrapper de log resiliente pro Task Scheduler |
| `scripts/setup-evaluate-brevo-diaria-schedule.ps1` | Setup/remoção da task no Task Scheduler |
| `docs/evaluate-brevo-diaria-setup.md` | Esta documentação |
| `test/evaluate-brevo-diaria-4266.test.ts` | Testes de regressão da lógica de avaliação (#633) |
| `test/run-evaluate-brevo-diaria-ps1.test.ts` | Testes de regressão do wrapper `.ps1` (log resiliente + exit code honesto) |
