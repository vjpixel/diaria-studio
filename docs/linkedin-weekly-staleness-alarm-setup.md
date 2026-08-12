# Alarme de staleness da newsletter semanal do LinkedIn

Issue: [#5111](https://github.com/vjpixel/diaria-studio/issues/5111).

`scripts/linkedin-weekly-staleness-alarm.ts` + `scripts/lib/linkedin-weekly-staleness-alarm.ts` fecham o buraco de observabilidade encontrado ao vivo em 260812: o ciclo `26w32` da `/diaria-linkedin-semanal` (conteúdo 03-07/08, publicação prevista segunda 10/08) simplesmente não rodou, e nada avisou — o editor só percebeu 2 dias depois, por memória própria.

## O que ele checa

Dado o momento em que a task roda, calcula a última semana de CONTEÚDO (segunda a sexta) que já terminou e deriva o ciclo dela (`{YY}w{WW}`, mesma convenção de `weekly-linkedin-cycle.ts`). Checa se `data/weekly/{cycle}/ln-{cycle}.json` existe — o artefato final escrito por `render-linkedin-weekly.ts` (Passo 5/7 da skill). Existir é prova de que a produção chegou até o fim, não só que a seleção (Passo 2) rodou.

- Artefato existe → **OK, sem alarme.**
- Artefato ausente → **ALARME.**

O cálculo do ciclo é robusto a quando exatamente a task roda: mesmo atrasada (máquina fora por dias), sempre aponta pra ÚLTIMA semana completa — nunca pra uma semana ainda em curso.

## Escopo reduzido (#5111 — itens 2 e 3 ficam de fora)

Esta task só faz a checagem de staleness. Dois itens da issue original ficaram fora, registrados como follow-up:

1. **Agendar a produção automaticamente** — a skill tem gate humano com 3 textos autorais do editor (abertura, fecho, comentário do Use Melhor); uma task que só chegasse até o gate e parasse é meio-termo plausível, mas não decidido nesta unidade.
2. **Tratamento especial de "semana perdida"** — a skill não sabe hoje o que é "atrasada" (`--publish-monday` de uma segunda já passada roda normalmente, sem aviso). Decidir se avisa, recusa, ou segue em silêncio fica pra depois.

## Por que checar o artefato local em vez de outra coisa

`ln-{cycle}.json` é o output final e determinístico do Passo 5/7 da skill — checar sua existência não depende de nenhuma API externa (Beehiiv, LinkedIn não tem endpoint de verificação, ver `SKILL.md` §"Reuso do agendamento"). Mesmo padrão dos outros `*-Alarm` do repo (ex: `clarice-envio-alarm.ts` lê o relatório local em vez de reconsultar a Brevo).

## Horário: domingo 22:00 BRT

Produção normal da skill é domingo (durante o dia, sem horário fixo — depende do editor rodar o gate humano). 22:00 dá folga ampla pro dia inteiro já ter passado, e ainda sobra a noite + a manhã de segunda (deadline de publicação ~09:30 BRT) pro editor reagir ao alarme antes do prazo. Evita de propósito os outros 2 timers de domingo já registrados (`Diaria-Geo-Citation-Monitor` 07:00, `Diaria-Geo-Citation-Staleness-Alarm` 10:30).

## Idempotência

`data/weekly/linkedin-staleness-alarm-state.json` guarda só `lastAlarmedCycle` — 1 alarme por ciclo, mesmo que esta task rode mais de 1x na mesma semana (retry manual de debug). Um ciclo novo com falha nova sempre alarma de novo, independente do ciclo anterior.

## Como o editor confere o alarme

- **Passivo**: chega por e-mail (Gmail, conta de `platform.config.json` → `inbox.editor_personal_email`) só quando o artefato está ausente.
- **Ativo** (debug/auditoria), sem enviar e-mail nem avançar o estado:
  ```bash
  npx tsx scripts/linkedin-weekly-staleness-alarm.ts --dry-run
  ```
  `--to email@x` sobrepõe o destinatário do alarme (debug).
- **Log da task agendada**: `data/weekly/.linkedin-staleness-alarm.log`.

## O que fazer quando o alarme dispara

Rode manualmente `/diaria-linkedin-semanal --publish-monday {AAMMDD da próxima segunda útil}` — o alarme não recupera nada sozinho, só avisa.

## Setup (ação local one-time do editor — NÃO feito nesta unidade)

Requer `data/.credentials.json` com o scope `gmail.send` (mesmo requisito dos outros alarmes locais deste repo) — só necessário pra **enviar** o alarme; a checagem de existência do artefato em si não precisa de credencial nenhuma.

**Sem `.ps1`/Task Scheduler de propósito** — nenhuma tarefa `Diaria-*` roda no Windows (decisão do editor 260811, #5074). Linux/systemd:

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-LinkedIn-Weekly-Staleness-Alarm
systemctl --user daemon-reload
systemctl --user enable --now diaria-linkedin-weekly-staleness-alarm.timer
```
