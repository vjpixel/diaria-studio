# Watchdog de Stall Overnight

Issue: [#2688](https://github.com/vjpixel/diaria-studio/issues/2688)

O watchdog detecta stall em rodadas overnight de forma independente do coordenador. O coordenador é event-driven — não roda entre eventos, então se todos os subagentes ficarem em silêncio (sem task-notification, sem transição de CI), o coordenador não acorda e a detecção existente (#2379) nunca dispara. O watchdog externo cobre esse gap.

---

## Como funciona

1. Roda a cada 10 min via systemd timer (entre 18:00 e 09:00 do dia seguinte).
2. Procura rodada overnight ativa: `data/overnight/{AAMMDD}/plan.json` existe mas `report.md` está ausente.
3. Mede **última atividade** = `max(mtime(plan.json), último evento run-log com agent:"overnight")`.
4. Se inatividade > 45 min (limiar configurável — `OVERNIGHT_STALL_THRESHOLD_MIN`):
   - Registra entrada em `stall_events` no `plan.json` (com dedup: não repete na mesma janela de 30 min).
   - Emite evento `stall_detected` no `data/run-log.jsonl`.
   - Exibe halt banner no terminal/log da task.
   - Envia alerta push por e-mail via Gmail (#5341 — mesma credencial OAuth do Drive/inbox-drain, sem env var própria; ver `scripts/lib/push-notify.ts`).

---

## Duas camadas de detecção de stall (#2379 + #2688)

| Camada | Mecanismo | Cobre |
|---|---|---|
| **i) Detecção-no-wake** (#2379) | O coordenador, quando acordado por um evento (CI, task-notification), verifica se há >45 min sem progresso — e emite halt banner. | Coordenador acorda mas a issue está travada. |
| **ii) Detecção-por-tempo** (#2688 — este watchdog) | Script externo que roda independente do coordenador, via systemd timer (o par Windows/Task Scheduler foi removido no #5115), e detecta silêncio total. | Coordenador parado — sem nenhum evento chegando. |

As duas camadas são complementares. O #2379 (existente na SKILL.md) permanece como está.

---

## Setup (ação local one-time do editor)

**Requisito:** executar no clone permanente do repo, não em worktrees temporários.

**O `.ps1` de arme Windows foi removido no #5115** (cutover final, 260812) —
nenhuma tarefa `Diaria-*` roda mais no Windows (política de 260811, #5074).
Via de arme é só systemd, abaixo.

## Setup no Linux (systemd) — #4857

Diferente das outras 14 tasks agendadas do repo (registro declarativo em
`scripts/lib/scheduled-tasks.ts` + geração via `scripts/setup-systemd-timers.ts`,
épica #4798), o watchdog fica **fora** do registry — decisão documentada em
`scripts/lib/watchdog-systemd-units.ts`: a janela 18:00→09:00 (cadência que
cruza a meia-noite) e a invocação direta de `overnight-watchdog.ts` (sem
passar por `run-task.ts`) não cabem no schema `ScheduledTaskSchedule` hoje
(`daily`/`weekly`/`interval` simples).

**As outras 14 tasks (registry) têm o passo de armar automatizado desde o
#4828** — `npx tsx scripts/arm-systemd-timers.ts [--task <Nome>]
[--rearm-stopped]` copia os units gerados por `setup-systemd-timers.ts` pra
`~/.config/systemd/user/`, roda `daemon-reload` e `enable --now`, com um
guard: um `.timer` que já existe e está `ActiveState=inactive` (parado
deliberadamente via `systemctl --user stop`) é **preservado por padrão** —
o script avisa e pula, só religando com `--rearm-stopped` explícito. O
watchdog em si continua fora desse script (fora do registry, ver acima) —
o arme dele segue manual, passo 2 abaixo.

**1. Gerar os units** (só escreve arquivos, nunca chama `systemctl`):

```bash
npx tsx scripts/overnight/setup-watchdog-schedule-systemd.ts
# escreve .systemd-units/diaria-overnight-watchdog.{service,timer}
```

**2. Armar** (ação manual na máquina real):

```bash
mkdir -p ~/.config/systemd/user
cp .systemd-units/diaria-overnight-watchdog.service .systemd-units/diaria-overnight-watchdog.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now diaria-overnight-watchdog.timer
```

**3. Verificar:**

```bash
systemctl --user list-timers diaria-overnight-watchdog.timer
npx tsx scripts/lib/check-watchdog-armed.ts
```

`check-watchdog-armed.ts` (usado pela Fase 0 de `/diaria-overnight`/`/diaria-develop`)
detecta o agendador desta máquina automaticamente (`schtasks` no Windows,
`systemctl` no Linux, via `detectTaskScheduler()`) e reporta `armed` /
`armed_but_disabled` / `not_armed` / `cannot_verify` — o último caso (consulta
ao `systemctl` falhou, ex: sem sessão `--user`/bus de sessão) é distinto de
"não armado" e nunca sugere um comando de arme específico de plataforma.

**Reativar** (unit presente mas desabilitado):

```bash
systemctl --user enable --now diaria-overnight-watchdog.timer
```

**Remover:**

```bash
systemctl --user disable --now diaria-overnight-watchdog.timer
rm ~/.config/systemd/user/diaria-overnight-watchdog.{service,timer}
systemctl --user daemon-reload
```

**Nota de validação (#4857, reconciliação 260810):** o par gerado por
`setup-watchdog-schedule-systemd.ts` foi comparado byte-a-byte com o que
estava armado manualmente em `~/.config/systemd/user/` nesta máquina
(`helios`, arme original 260810 ~06:52 UTC) — **idêntico**, quando gerado
com o mesmo Node do `.nvmrc` (v24) que o arme manual usou. A expressão
`OnCalendar=` gerada (`00..08,18..23:00/10:00 America/Sao_Paulo`) foi validada
tanto pelo parser real (`systemd-analyze calendar`, sem lançar, próxima
ocorrência dentro da janela esperada) quanto por um disparo real do serviço
(`systemctl --user start diaria-overnight-watchdog.service`): `Result=success`,
`ExecMainStatus=0`, log real em `journalctl --user -u
diaria-overnight-watchdog.service` (detectou e alertou uma rodada overnight
genuinamente parada, confirmando o caminho de alerta ponta-a-ponta).

**Achado ao vivo durante a reconciliação:** `ExecStart=` embute
`process.execPath` — o Node que rodou o *gerador*, não um valor descoberto ou
pinado. Um shell sem `~/.local/node/bin` no PATH (comum em sessão de agente)
gera com o Node 20.20.2 do sistema — mesmo binário do incidente #4823 — em vez
do Node 24 do projeto. Isso não quebra `overnight-watchdog.ts` em si (não usa
`node:sqlite`), mas diverge da política do projeto. `setup-watchdog-schedule-systemd.ts`
agora avisa (`console.warn`, fail-soft, nunca bloqueia) quando o Node que gerou
os units está abaixo do mínimo do projeto — rode sempre com `nvm use`/`fnm use`
ativado no `.nvmrc` antes de gerar, e preste atenção no aviso se ele aparecer.

### Testar manualmente (dry-run)

Comando cross-platform (Windows/Linux) — `overnight-watchdog.ts` não depende de qual agendador armou a task:

```bash
npx tsx scripts/overnight-watchdog.ts --dry-run
```

Saída esperada quando não há rodada ativa:
```
[watchdog] Nenhuma rodada overnight ativa detectada.
```

Saída com rodada ativa e sem stall (ex: 5 min de inatividade com limiar 45 min):
```
[watchdog] DRY-RUN — rodada ativa: 260701
[watchdog] Última atividade: 2026-07-01T23:55:00.000Z (fonte: run-log)
[watchdog] Inatividade: 5 min (limiar: 45 min)
[watchdog] → sem stall (dry-run, sem writes/alertas)
```

### Forçar detecção com limiar baixo (teste real)

```bash
# Se houver rodada ativa com > 2 min de inatividade, detecta e alerta:
npx tsx scripts/overnight-watchdog.ts --threshold 2 --dry-run
```

---

## Configuração de alerta push (#5341 — canal e-mail)

O watchdog envia o alerta de stall por e-mail via Gmail (`scripts/lib/push-notify.ts`), reusando a MESMA credencial OAuth já usada por Drive sync/inbox-drain/imagens sociais (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, setup: `npx tsx scripts/oauth-setup.ts`) — sem env var própria. O destinatário é `platform.config.json` → `inbox.editor_personal_email` (default `vjpixel@gmail.com`).

Sem credenciais OAuth configuradas, o watchdog funciona normalmente mas não envia o e-mail — só exibe o halt banner no log da task (fail-soft TOTAL).

---

## Configuração de threshold

Limiar padrão: **45 min** (`OVERNIGHT_STALL_THRESHOLD_MIN` em
`scripts/lib/overnight-stall-threshold.ts` — era 60 até 17/08/2026, #5568).
O piso é o timeout de espera de CI da SKILL do overnight (30 min): abaixo
disso, toda espera de CI saudável viraria alarme. Pra baixar mais, o timeout
de CI tem que cair junto.

Para alterar sem mexer no código:

```env
# Em .env:
OVERNIGHT_WATCHDOG_STALL_MIN=35
```

Ou via flag CLI (override pontual):

```bash
npx tsx scripts/overnight-watchdog.ts --threshold 35
```

---

## Logs gerados pelo watchdog

### `data/run-log.jsonl` (evento de stall)

```json
{
  "timestamp": "2026-07-01T04:30:00.000Z",
  "edition": "260701",
  "stage": null,
  "agent": "overnight",
  "level": "warn",
  "message": "stall_detected",
  "details": {
    "reason": "unknown",
    "source": "overnight-watchdog",
    "elapsed_min": 72,
    "last_activity_source": "run-log"
  }
}
```

### `data/overnight/{AAMMDD}/plan.json` (campo `stall_events`)

```json
{
  "stall_events": [
    {
      "at": "2026-07-01T04:30:00.000Z",
      "reason": "unknown",
      "resumed_at": null
    }
  ]
}
```

`resumed_at` é preenchido pelo coordenador quando a rodada é retomada (campo existente no schema do plan.json — SKILL.md). O watchdog só cria a entrada.

---

## Troubleshooting

### `npx` não encontrado no PATH da task

O Task Scheduler pode usar um PATH diferente do terminal interativo. Soluções:

1. Encontrar o path completo: `(Get-Command npx).Source` no terminal onde `npx` funciona.
2. Editar a action da task pelo Task Scheduler GUI para usar o path absoluto.
3. Ou adicionar o diretório do Node/npm ao PATH do sistema.

### Watchdog dispara em loop

Verificar se `data/overnight/{AAMMDD}/report.md` existe (rodada concluída). Se sim, o plan.json está incorreto ou o report.md foi deletado. O watchdog deteta rodada ativa apenas quando plan.json existe E report.md está ausente.

### Falso positivo — overnight concluiu mas report.md não foi gerado

Se a Fase 2 (Relatório) falhou sem gravar `report.md`, o watchdog continuará a reportar stall mesmo após a rodada terminar. Nesse caso, gravar manualmente um `report.md` vazio encerra o ciclo:

```powershell
echo "# relatório gerado manualmente (fase 2 falhou)" > data\overnight\{AAMMDD}\report.md
```

---

## Arquivos

| Arquivo | Função |
|---|---|
| `scripts/overnight-watchdog.ts` | Script principal do watchdog |
| `scripts/lib/watchdog-systemd-units.ts` | Gera o conteúdo dos units systemd (Linux, #4857) |
| `scripts/overnight/setup-watchdog-schedule-systemd.ts` | CLI que escreve os units systemd em disco (Linux, #4857) |
| `scripts/lib/check-watchdog-armed.ts` | Checagem cross-platform (schtasks/systemd) usada pela Fase 0 do overnight/develop |
| `docs/overnight-watchdog-setup.md` | Esta documentação |
| `test/overnight-watchdog.test.ts` | Testes de regressão da lógica de detecção (#633) |
| `test/watchdog-systemd-units.test.ts` | Testes dos units systemd + CLI de geração (#4857) |
| `test/check-watchdog-armed.test.ts` | Testes da checagem cross-platform, inclusive o branch systemd (#4857) |
