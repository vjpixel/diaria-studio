---
name: diaria-4-eai
description: Roda apenas o Stage 4 — busca a Foto do Dia da Wikimedia e gera `04-eai.md` + `04-eai.jpg`. Uso: `/diaria-4-eai YYYY-MM-DD`.
---

# /diaria-4-eai

Dispara o Stage 4 da edição Diar.ia: busca a Foto do Dia da Wikimedia (POTD), relaciona com os destaques do dia e gera `04-eai.md` + `04-eai.jpg`.

## Argumentos

- `$1` = data da edição (`YYYY-MM-DD`). Se não passar, usa a data de hoje.

## Pré-requisitos

- `data/editions/{YYMMDD}/02-reviewed.md` deve existir.

## O que faz

1. Detecta a edição em `data/editions/{YYMMDD}/`.
2. Dispara o subagente `eai-composer` com `edition_date`, `newsletter_path`, `out_dir`.
3. Apresenta o texto gerado e o path da imagem.
4. **Gate humano**: aprovar ou pedir para tentar o dia anterior (o `eai-composer` decrementa a data).

## Output

- `data/editions/{YYMMDD}/04-eai.md` — texto "É AI?"
- `data/editions/{YYMMDD}/04-eai.jpg` — imagem baixada da Wikimedia

## Notas

- Requer conexão com internet (Wikimedia API pública, sem auth).
- Se `04-eai.md` já existir, perguntar se quer regenerar antes de prosseguir.
- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
