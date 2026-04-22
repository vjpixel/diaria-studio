---
name: diaria-log
description: Lê `data/run-log.jsonl` e mostra eventos recentes (info/warn/error) com filtros opcionais por edição ou nível. Use quando algo deu errado na pipeline e você quer que eu investigue.
---

# /diaria-log [edition] [level]

Inspeciona o log estruturado da pipeline. Permite ao usuário pedir "lê o log e resolve" — você lê os últimos eventos, identifica padrões de erro, e propõe fix.

## Argumentos

- `edition` (opcional): `AAMMDD`. Filtra eventos daquela edição. Se omitido, mostra os últimos 50 eventos globais.
- `level` (opcional): `error`, `warn`, `info`, ou `all`. Default: mostra `error` + `warn` se nada for dito; `all` se o usuário pedir visão completa.

## Execução

1. **Ler `data/run-log.jsonl`**. Cada linha é um JSON: `{timestamp, edition, stage, agent, level, message, details}`.
2. **Filtrar** por `edition` (se dado; já em formato `AAMMDD`) e `level`.
3. **Ordenar** por `timestamp` descendente. Pegar os últimos 50 (ou menos se tiver menos).
4. **Agrupar por agente + stage** e apresentar em uma tabela/lista legível:

```
📋 Log — edição 260418 (12 eventos, 2 errors, 3 warns)

[ERROR] 14:22:03 · stage 1 · source-researcher
  fonte "MIT Technology Review" retornou 403
  details: {"url":"...","status":403}

[WARN ] 14:22:15 · stage 1 · link-verifier
  artigo marcado como paywall: https://...

...
```

5. Se houver `error` ou múltiplos `warn` relacionados, **oferecer investigar**:
   > Quer que eu leia o código do agente `{agent}` e proponha um fix para "{message}"?

   Se o usuário aceitar, leia o agente, o script relevante, e o output da stage (`data/editions/{edition}/...`) para entender contexto e propor correção.

## Se o log estiver vazio

Reporte: "Log vazio — nada foi registrado ainda. Se a pipeline rodou sem logar, os agentes ainda não estão chamando `scripts/log-event.ts` naquele ponto. Posso instrumentá-los?"

## Regras

- Não modifique `data/run-log.jsonl` — é append-only.
- Se o usuário pedir para **limpar** o log, mova para `data/run-log-archive-{timestamp}.jsonl` e crie um novo vazio. Nunca `rm`.
- Se um evento tiver `details.stack` ou outro campo volumoso, mostre só as primeiras linhas; ofereça expandir se necessário.
