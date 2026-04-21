---
name: diaria-4-eai
description: Roda apenas o Stage 4 — busca a Foto do Dia da Wikimedia (POTD), gera versão IA via Gemini e escreve `04-eai.md` + `04-eai-real.jpg` + `04-eai-ia.jpg`. Uso: `/diaria-4-eai YYYY-MM-DD`.
---

# /diaria-4-eai

Dispara o Stage 4 da edição Diar.ia: busca a Foto do Dia da Wikimedia (POTD), gera uma versão similar por IA via Gemini, e produz os dois arquivos de imagem para o bloco "É AI?" (leitor tenta adivinhar qual foi feita por IA).

## Argumentos

- `$1` = data da edição (`YYYY-MM-DD`). Se não passar, usa a data de hoje.

## Pré-requisitos

- `data/editions/{YYMMDD}/02-reviewed.md` deve existir.
- `GEMINI_API_KEY` configurada como variável de ambiente.

## O que faz

1. Detecta a edição em `data/editions/{YYMMDD}/`.
2. Dispara o subagente `eai-composer` com `edition_date`, `newsletter_path`, `out_dir`.
3. O composer:
   - Busca a POTD da Wikimedia (com fallback de até 7 dias por elegibilidade: horizontal, não repetida)
   - Baixa a foto real → `04-eai-real.jpg`
   - Registra uso em `data/eai-used.json`
   - Gera versão IA fotorrealista via `scripts/gemini-image.js` → `04-eai-ia.jpg`
   - Escreve `04-eai.md` com linha de crédito (links Wikipedia + Wikimedia Commons)
4. **Gate humano**: mostrar texto de `04-eai.md` + paths das duas imagens. Aprovar ou pedir para tentar o dia anterior.

## Output

- `data/editions/{YYMMDD}/04-eai.md` — linha de crédito com links
- `data/editions/{YYMMDD}/04-eai-real.jpg` — foto real da Wikimedia (imagem A)
- `data/editions/{YYMMDD}/04-eai-ia.jpg` — versão gerada por Gemini (imagem B)
- `data/editions/{YYMMDD}/04-eai-sd-prompt.json` — prompt usado na geração

## Notas

- Requer conexão com internet (Wikimedia API pública, sem auth).
- Se `04-eai-real.jpg` já existir, perguntar se quer regenerar antes de prosseguir.
- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
