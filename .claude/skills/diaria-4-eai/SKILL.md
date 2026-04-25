---
name: diaria-4-eai
description: Roda apenas o Stage 4 — busca a Foto do Dia da Wikimedia (POTD), gera versão IA via Gemini e escreve `01-eai.md` + `01-eai-real.jpg` + `01-eai-ia.jpg`. Uso — `/diaria-4-eai AAMMDD`.
---

# /diaria-4-eai

Dispara o Stage 4 da edição Diar.ia: busca a Foto do Dia da Wikimedia (POTD), gera uma versão similar por IA via Gemini, e produz os dois arquivos de imagem para o bloco "É IA?" (leitor tenta adivinhar qual foi feita por IA).

## Argumentos

- `$1` = data da edição (`AAMMDD`, ex: `260423`). Se não passar, usa a data de hoje.

## Pré-requisitos

- `data/editions/{AAMMDD}/02-reviewed.md` deve existir.
- `GEMINI_API_KEY` configurada como variável de ambiente.

## O que faz

1. Detecta a edição em `data/editions/{AAMMDD}/`.
2. Dispara o subagente `eai-composer` com `edition_date`, `newsletter_path`, `out_dir`.
3. O composer:
   - Busca a POTD da Wikimedia (com fallback de até 7 dias por elegibilidade: horizontal, não repetida)
   - Baixa a foto real → `01-eai-real.jpg`
   - Registra uso em `data/eai-used.json`
   - Gera versão IA fotorrealista via `scripts/gemini-image.js` → `01-eai-ia.jpg`
   - Escreve `01-eai.md` com linha de crédito (links Wikipedia + Wikimedia Commons)
4. **Gate humano**: mostrar texto de `01-eai.md` + paths das duas imagens. Aprovar ou pedir para tentar o dia anterior.

## Output

- `data/editions/{AAMMDD}/01-eai.md` — linha de crédito com links
- `data/editions/{AAMMDD}/01-eai-real.jpg` — foto real da Wikimedia (imagem A)
- `data/editions/{AAMMDD}/01-eai-ia.jpg` — versão gerada por Gemini (imagem B)
- `data/editions/{AAMMDD}/01-eai-sd-prompt.json` — prompt usado na geração

## Notas

- Requer conexão com internet (Wikimedia API pública, sem auth).
- Se `01-eai-real.jpg` já existir, perguntar se quer regenerar antes de prosseguir.
- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
