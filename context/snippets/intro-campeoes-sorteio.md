<!--
Template de REFERÊNCIA do box de início de mês (campeões do É IA? + sorteio
do erro intencional), criado manualmente na 1ª vez na edição 260701 e agora
auto-gerado (#2725) por `scripts/lib/build-champions-callout.ts`, disparado no
mesmo gate "1ª edição do mês" do leaderboard (`scripts/fetch-leaderboard-top1.ts`,
#1753) via `scripts/inject-champions-callout.ts` no Stage 3.

Este arquivo NÃO é lido em runtime pelo pipeline — é documentação do formato
esperado (placeholders) para quem for ajustar o texto manualmente ou revisar o
gerador. A fonte de verdade executável é `build-champions-callout.ts`.

Placeholders:
  {mes}          — mês CELEBRADO pelo pódio (mês anterior ao da edição, já
                   fechado). Ex: edição 260701 celebra junho → "junho".
  {1o} {2o} {3o} — nicknames do pódio (ranks 1-3), de
                   `_internal/04-leaderboard-top1.json > podium`.
  {data}         — dia do sorteio ao vivo, no mês da EDIÇÃO corrente (não o
                   mês celebrado). Ex: edição 260701 → "2 de julho".
  {hora_inicio}  — início da janela do sorteio, formato "HHhMM" (minutos
                   omitidos quando :00 — ex: "13h30", "14h").
  {hora_fim}     — fim da janela do sorteio, mesmo formato.
  {meet_url}     — link fixo da sala do Google Meet.

`{data}`/`{hora_inicio}`/`{hora_fim}`/`{meet_url}` vêm do bloco `raffle` de
`platform.config.json` (dia do mês + janela de horário fixos; ano/mês
derivados da edição).

Marcador 🎉 = editorial (não patrocinado) → renderIntroCallout usa
titleStyle="body" (título 16px, não o 26px serif default). O parágrafo
inteiramente em negrito ("**Sorteio**") vira sub-cabeçalho com o mesmo
estilo do título (#2727).
-->

**🎉 Os campeões do É IA? em {mes}:

🥇 {1o}

🥈 {2o}

🥉 {3o}

**Sorteio**

O sorteio entre quem achou o erro intencional será ao vivo no dia {data}, das {hora_inicio} às {hora_fim}, no [Google Meet]({meet_url}). Apareça para acompanhar o resultado e bater um papo sobre IA.**
