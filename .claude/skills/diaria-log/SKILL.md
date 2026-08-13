---
name: diaria-log
description: Lê `data/run-log.jsonl` e mostra eventos recentes (info/warn/error) com filtros opcionais por edição ou nível. Use quando algo deu errado na pipeline e você quer que eu investigue.
---

# /diaria-log [edition] [level]

## Argumentos

- `edition` (opcional): `AAMMDD`. Filtra eventos daquela edição. Se omitido,
  mostra os últimos 50 eventos globais.
- `level` (opcional): `error`, `warn`, `info`, ou `all`. Default (omitido):
  `error` + `warn`. `all` mostra os 3 níveis.

Desde #5191, o filtro/sort/formatação é `scripts/read-run-log.ts` — testado,
não mais interpretação de prosa a cada invocação (mesmo molde do precedente
`/diaria-clarice-novos` → `scripts/clarice-novos-run.ts`, #4941). Esta skill
apenas invoca:

```bash
npx tsx scripts/read-run-log.ts                         # últimos 50 eventos, error+warn (default)
npx tsx scripts/read-run-log.ts --level all               # últimos 50, todos os níveis
npx tsx scripts/read-run-log.ts --level error              # só error
npx tsx scripts/read-run-log.ts --edition AAMMDD            # filtra por edição
npx tsx scripts/read-run-log.ts --edition AAMMDD --level error
npx tsx scripts/read-run-log.ts --json                     # output estruturado
```

`details.stack`, quando presente, sai truncado (5 linhas / 500 chars) —
poluição zero no terminal, sem perder o essencial pra propor um fix.

## Depois de rodar

Se houver `error` ou múltiplos `warn` relacionados, **oferecer investigar**:
> Quer que eu leia o código do agente `{agent}` e proponha um fix para
> "{message}"?

Se o usuário aceitar, leia o agente, o script relevante, e o output da stage
(`data/editions/{edition}/...`) pra entender contexto e propor correção. Esse
julgamento fica na conversa — o script só extrai os fatos.

## Se o log estiver vazio

O script já reporta isso (`"Log vazio — nada foi registrado ainda..."`). Se a
pipeline rodou sem logar, os agentes ainda não estão chamando
`scripts/log-event.ts` naquele ponto — ofereça instrumentá-los.

## Regras

- **Somente leitura.** `data/run-log.jsonl` é append-only, nunca modificado
  pelo script.
- Se o usuário pedir para **limpar** o log, mova para
  `data/run-log-archive-{timestamp}.jsonl` e crie um novo vazio. Nunca `rm` —
  fora do escopo do script (ação destrutiva rara, não vale automatizar).
