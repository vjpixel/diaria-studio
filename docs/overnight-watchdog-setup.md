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
   - (Opcional) Envia alerta Telegram se `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WATCHDOG_CHAT_ID` estiverem no `.env.local`.

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

```powershell
# No diretório raiz do repo:
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

### Testar manualmente (dry-run)

```powershell
npx tsx scripts\overnight-watchdog.ts --dry-run
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

```powershell
# Se houver rodada ativa com > 2 min de inatividade, detecta e alerta:
npx tsx scripts\overnight-watchdog.ts --threshold 2 --dry-run
```

---

## Configuração de alerta Telegram (opcional)

O watchdog envia alerta direto pelo Bot API do Telegram se as variáveis abaixo estiverem no `.env.local`:

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
# Em .env.local:
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
| `scripts/overnight/setup-watchdog-schedule.ps1` | Setup da task no Task Scheduler |
| `docs/overnight-watchdog-setup.md` | Esta documentação |
| `test/overnight-watchdog.test.ts` | Testes de regressão da lógica de detecção (#633) |
