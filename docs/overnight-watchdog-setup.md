# Watchdog de Stall Overnight

Issue: [#2688](https://github.com/vjpixel/diaria-studio/issues/2688)

O watchdog detecta stall em rodadas overnight de forma independente do coordenador. O coordenador é event-driven — não roda entre eventos, então se todos os subagentes ficarem em silêncio (sem task-notification, sem transição de CI), o coordenador não acorda e a detecção existente (#2379) nunca dispara. O watchdog externo cobre esse gap.

---

## Como funciona

1. Roda a cada 10 min via Task Scheduler (entre 18:00 e 09:00 do dia seguinte).
2. Procura rodada overnight ativa: `data/overnight/{AAMMDD}/plan.json` existe mas `report.md` está ausente.
3. Mede **última atividade** = `max(mtime(plan.json), último evento run-log com agent:"overnight")`.
4. Se inatividade > 60 min (limiar configurável):
   - Registra entrada em `stall_events` no `plan.json` (com dedup: não repete na mesma janela de 30 min).
   - Emite evento `stall_detected` no `data/run-log.jsonl`.
   - Exibe halt banner no terminal/log da task.
   - (Opcional) Envia alerta Telegram se `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WATCHDOG_CHAT_ID` estiverem no `.env`.

---

## Duas camadas de detecção de stall (#2379 + #2688)

| Camada | Mecanismo | Cobre |
|---|---|---|
| **i) Detecção-no-wake** (#2379) | O coordenador, quando acordado por um evento (CI, task-notification), verifica se há >60 min sem progresso — e emite halt banner. | Coordenador acorda mas a issue está travada. |
| **ii) Detecção-por-tempo** (#2688 — este watchdog) | Script externo que roda independente do coordenador, via Task Scheduler, e detecta silêncio total. | Coordenador parado — sem nenhum evento chegando. |

As duas camadas são complementares. O #2379 (existente na SKILL.md) permanece como está.

---

## Setup (ação local one-time do editor)

**Requisito:** executar no clone permanente do repo, não em worktrees temporários.

**Prefira `pwsh` (PowerShell 7) quando disponível** — o script usa UTF-8 com
BOM desde o #2814, então roda em PowerShell 5.1 também, mas `pwsh` (UTF-8
nativo, sem o gotcha de encoding localizado que causou o incidente #2768)
é mais robusto se você tocar o arquivo depois com um editor sem BOM-awareness:

```powershell
# No diretório raiz do repo (pwsh, preferido):
pwsh -NoProfile -ExecutionPolicy Bypass `
    -File scripts\overnight\setup-watchdog-schedule.ps1

# Alternativa se pwsh 7 não estiver instalado (Windows PowerShell 5.1 default):
powershell -NoProfile -ExecutionPolicy Bypass `
    -File scripts\overnight\setup-watchdog-schedule.ps1
```

Isso cria a task `Diaria-Overnight-Watchdog` no Task Scheduler local. Idempotente — re-executar atualiza a task.

### Verificar a task registrada

```powershell
Get-ScheduledTask -TaskName "Diaria-Overnight-Watchdog" | Get-ScheduledTaskInfo
```

### Remover a task

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
    -File scripts\overnight\setup-watchdog-schedule.ps1 -Unregister
```

---

## Setup no Linux (systemd) — #4857

Par Linux do fluxo Windows acima. Diferente das outras 14 tasks agendadas do
repo (registro declarativo em `scripts/lib/scheduled-tasks.ts` + geração via
`scripts/setup-systemd-timers.ts`, épica #4798), o watchdog fica **fora** do
registry — decisão documentada em `scripts/lib/watchdog-systemd-units.ts`: a
janela 18:00→09:00 (cadência que cruza a meia-noite) e a invocação direta de
`overnight-watchdog.ts` (sem passar por `run-task.ts`) não cabem no schema
`ScheduledTaskSchedule` hoje (`daily`/`weekly`/`interval` simples).

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
(`predator`, arme original 260810 ~06:52 UTC) — **idêntico**, quando gerado
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

Saída com rodada ativa e sem stall (ex: 5 min de inatividade com limiar 60 min):
```
[watchdog] DRY-RUN — rodada ativa: 260701
[watchdog] Última atividade: 2026-07-01T23:55:00.000Z (fonte: run-log)
[watchdog] Inatividade: 5 min (limiar: 60 min)
[watchdog] → sem stall (dry-run, sem writes/alertas)
```

### Forçar detecção com limiar baixo (teste real)

```bash
# Se houver rodada ativa com > 2 min de inatividade, detecta e alerta:
npx tsx scripts/overnight-watchdog.ts --threshold 2 --dry-run
```

---

## Configuração de alerta Telegram (opcional)

O watchdog envia alerta direto pelo Bot API do Telegram se as variáveis abaixo estiverem no `.env`:

```env
# Token do bot criado via @BotFather (mesmo do docs/telegram-setup.md)
TELEGRAM_BOT_TOKEN=123456789:AAH...

# Chat ID para onde enviar o alerta (DM com o bot)
# Obter via: https://api.telegram.org/bot{TOKEN}/getUpdates  após mandar /start pro bot
TELEGRAM_WATCHDOG_CHAT_ID=987654321
```

Sem essas variáveis, o watchdog funciona normalmente mas não envia Telegram — só exibe o halt banner no log da task.

**Nota:** o `TELEGRAM_BOT_TOKEN` é o mesmo do plugin `telegram@claude-plugins-official` (docs/telegram-setup.md). O `TELEGRAM_WATCHDOG_CHAT_ID` é específico do watchdog — é o `chat_id` do seu DM com o bot, obtido consultando `getUpdates` após mandar qualquer mensagem para o bot.

---

## Configuração de threshold

Limiar padrão: 60 min. Para alterar:

```env
# Em .env:
OVERNIGHT_WATCHDOG_STALL_MIN=45
```

Ou via flag CLI (override pontual):

```powershell
npx tsx scripts\overnight-watchdog.ts --threshold 45
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
| `scripts/overnight/setup-watchdog-schedule.ps1` | Setup da task no Task Scheduler (Windows) |
| `scripts/lib/watchdog-systemd-units.ts` | Gera o conteúdo dos units systemd (Linux, #4857) |
| `scripts/overnight/setup-watchdog-schedule-systemd.ts` | CLI que escreve os units systemd em disco (Linux, #4857) |
| `scripts/lib/check-watchdog-armed.ts` | Checagem cross-platform (schtasks/systemd) usada pela Fase 0 do overnight/develop |
| `docs/overnight-watchdog-setup.md` | Esta documentação |
| `test/overnight-watchdog.test.ts` | Testes de regressão da lógica de detecção (#633) |
| `test/watchdog-systemd-units.test.ts` | Testes dos units systemd + CLI de geração (#4857) |
| `test/check-watchdog-armed.test.ts` | Testes da checagem cross-platform, inclusive o branch systemd (#4857) |
