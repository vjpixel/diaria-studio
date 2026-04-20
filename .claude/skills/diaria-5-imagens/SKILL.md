---
name: diaria-5-imagens
description: Roda apenas o Stage 5 — gera as 3 imagens de destaque via ComfyUI (Van Gogh impasto, 2000×1000px). Uso: `/diaria-5-imagens [d1|d2|d3]`.
---

# /diaria-5-imagens

Dispara o Stage 5 da edição Diar.ia: gera as 3 imagens de destaque via ComfyUI local com LoRA impasto Van Gogh (2000×1000px, proporção 2:1).

## Argumentos

- `/diaria-5-imagens` — gera as 3 imagens (d1, d2, d3)
- `/diaria-5-imagens d1` — regenera só a imagem do destaque 1
- `/diaria-5-imagens d2` — regenera só a imagem do destaque 2
- `/diaria-5-imagens d3` — regenera só a imagem do destaque 3

## Pré-requisitos

- ComfyUI rodando em `http://127.0.0.1:8188` (ver `docs/comfyui-setup.md`)
- LoRA e checkpoint configurados em `platform.config.json` → bloco `comfyui`
- Arquivos `02-d1-prompt.md`, `02-d2-prompt.md`, `02-d3-prompt.md` existindo na edição

## O que faz

1. Verifica que ComfyUI está acessível.
2. Para cada destaque (ou só o indicado):
   - Lê `02-d{N}-prompt.md`.
   - Refina para prompt SD estilo impasto Van Gogh + grava `05-d{N}-sd-prompt.json`.
   - Submete workflow ao ComfyUI via API REST (POST /prompt).
   - Aguarda conclusão (poll GET /history/{id}).
   - Baixa resultado → `05-d{N}.jpg`.
3. **Gate humano**: mostrar paths dos JPGs. Aprovar ou pedir `/diaria-5-imagens d{N}` para regenerar individual.

## Output

- `data/editions/{YYMMDD}/05-d1.jpg`, `05-d2.jpg`, `05-d3.jpg` (2000×1000)
- `data/editions/{YYMMDD}/05-d{N}-sd-prompt.json` — prompt SD usado

## Notas

- Tempo estimado: 1–3 min por imagem com GPU local.
- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
