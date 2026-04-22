---
name: diaria-5-imagens
description: Roda apenas o Stage 5 — gera as 3 imagens de destaque via Gemini API (Van Gogh impasto, 800×450px). Uso: `/diaria-5-imagens [d1|d2|d3]`.
---

# /diaria-5-imagens

Dispara o Stage 5 da edição Diar.ia: gera as 3 imagens de destaque em estilo impasto Van Gogh via Gemini API (ou ComfyUI, se configurado em `platform.config.json > image_generator`).

## Argumentos

- `/diaria-5-imagens` — gera as 3 imagens (d1, d2, d3)
- `/diaria-5-imagens d1` — regenera só a imagem do destaque 1
- `/diaria-5-imagens d2` — regenera só a imagem do destaque 2
- `/diaria-5-imagens d3` — regenera só a imagem do destaque 3

Se não passar data, detecta a edição mais recente em `data/editions/`.

## Pré-requisitos

- `GEMINI_API_KEY` configurada como variável de ambiente (ou ComfyUI rodando, se `image_generator: "comfyui"` no config)
- Arquivos `02-d1-prompt.md`, `02-d2-prompt.md`, `02-d3-prompt.md` existindo na edição

## O que faz

1. Para cada destaque (ou só o indicado):
   - Lê `02-d{N}-prompt.md`.
   - Monta prompt estilo impasto Van Gogh + grava `05-d{N}-sd-prompt.json`.
   - Chama `scripts/image-generate.ts` → `scripts/gemini-image.js` → `05-d{N}.jpg`.
2. **Gate humano**: mostrar paths dos JPGs. Aprovar ou pedir regeneração individual.

## Output

- `data/editions/{YYMMDD}/05-d1-2x1.jpg`, `05-d1-1x1.jpg`, `05-d2.jpg`, `05-d3.jpg`
- `data/editions/{YYMMDD}/05-d{N}-sd-prompt.json` — prompt usado na geração

## Notas

- Backend padrão: Gemini (`gemini-3.1-flash-image-preview`). Para usar ComfyUI, setar `image_generator: "comfyui"` em `platform.config.json`.
- Tempo estimado: ~15s por imagem via Gemini API.
- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
