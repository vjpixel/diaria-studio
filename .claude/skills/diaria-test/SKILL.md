# /diaria-test

Roda a pipeline completa da Diar.ia **sem gates humanos** para benchmark de performance.
Todo conteúdo social é agendado 10 dias à frente para que o editor possa deletar antes da publicação real.

## Argumentos

- `<date>` (opcional) = data da edição no formato `AAMMDD` (ex: `260423`). Default: hoje.

## O que muda em relação a `/diaria-edicao`

| Aspecto | `/diaria-edicao` | `/diaria-test` |
|---------|------------------|----------------|
| Gates humanos | Pausa em cada stage | **Auto-approve** — não para nunca |
| Social schedule | `day_offset` do config (0) | **`day_offset = 10`** — agenda 10 dias à frente |
| Newsletter | Rascunho + email de teste | Rascunho + email de teste (igual) |
| Drive sync | Push + pull normal | **Desabilitado** (sem poluir Drive com teste) |
| Janela de publicação | Pergunta ao usuário | **Default automático** (seg/ter=4, qua-sex=3) |
| Timing | Inferido de file mtimes | **`stage-timing.ts` roda no final** |

## Processo

### 1. Setup

1. Se `<date>` não foi passado, usar hoje (como AAMMDD):
   ```bash
   node -e "process.stdout.write(new Date().toISOString().slice(2,10).replace(/-/g,''))"
   ```
2. Converter `<date>` (AAMMDD) para ISO e calcular `window_days` default (sem perguntar ao usuário):
   ```bash
   node -e "const s='<date>';const d=new Date('20'+s.slice(0,2)+'-'+s.slice(2,4)+'-'+s.slice(4,6));const day=d.getUTCDay();process.stdout.write(String(day===1||day===2?4:3))"
   ```
3. Verificar pré-requisitos silenciosamente:
   - `context/sources.md` existe e >200 bytes
   - `context/editorial-rules.md` existe e >200 bytes
   - Se algum faltar, abortar com erro (não perguntar — é um teste).

### 2. Disparar orchestrator

Disparar o subagente `orchestrator` via `Agent` passando no prompt:
- `edition_date = <date>` (AAMMDD)
- `window_days = {valor calculado}`
- `test_mode = true`
- `schedule_day_offset = 10`

**Não relayar gates ao usuário.** O orchestrator auto-aprova tudo em `test_mode`.

### 3. Ao completar

1. Rodar `stage-timing.ts` no diretório da edição:
   ```bash
   npx tsx scripts/stage-timing.ts --edition {AAMMDD}
   ```
2. Mostrar ao usuário:
   - Tabela de timing por stage
   - Total wall clock
   - Lembrete: "Social posts agendados para {date+10}. Delete do Facebook/LinkedIn antes dessa data."
   - Link para o rascunho no Beehiiv (de `05-published.json`)

## Output

Mesmo de `/diaria-edicao`: todos os arquivos em `data/editions/{AAMMDD}/`.
