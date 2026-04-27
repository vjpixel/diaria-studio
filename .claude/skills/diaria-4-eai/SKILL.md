---
name: diaria-4-eai
description: Roda apenas o Stage 4 — busca a Foto do Dia da Wikimedia (POTD), gera versão IA via Gemini, sorteia A/B (#192) e escreve `01-eai.md` (com frontmatter `eai_answer`) + `01-eai-A.jpg` + `01-eai-B.jpg`. Uso — `/diaria-4-eai AAMMDD`.
---

# /diaria-4-eai

Dispara o Stage 4 da edição Diar.ia: busca a Foto do Dia da Wikimedia (POTD), gera uma versão similar por IA via Gemini, e produz os dois arquivos de imagem para o bloco "É IA?" (leitor tenta adivinhar qual foi feita por IA).

## Argumentos

- `$1` = data da edição (`AAMMDD`, ex: `260423`). **Se não passar, perguntar explicitamente** ao usuário antes de prosseguir — nunca inferir a partir de `today()`. Sugerir hoje/ontem como atalhos mas exigir confirmação:
  > "Você não passou a data da edição. Qual edição você quer processar? hoje ({AAMMDD_hoje}) / ontem ({AAMMDD_ontem}) / outra (informe AAMMDD)"

## Pré-requisitos

- `data/editions/{AAMMDD}/02-reviewed.md` deve existir.
- `GEMINI_API_KEY` configurada como variável de ambiente.

## O que faz

1. Detecta a edição em `data/editions/{AAMMDD}/`.
2. Dispara o subagente `eai-composer` com `edition_date`, `newsletter_path`, `out_dir`.
3. O composer (script `scripts/eai-compose.ts`):
   - Busca a POTD da Wikimedia (com fallback de até 7 dias por elegibilidade: horizontal, não repetida)
   - **Sorteio A/B (#192)**: coin flip decide qual slot recebe a foto real e qual recebe a IA — exercício fica cego (nem o nome do arquivo revela a resposta).
   - Baixa a foto real → `01-eai-{A|B}.jpg`
   - Registra uso em `data/eai-used.json`
   - Gera versão IA fotorrealista via `scripts/gemini-image.js` → `01-eai-{B|A}.jpg` (slot oposto)
   - Escreve `01-eai.md` com frontmatter YAML `eai_answer` (mapping A/B → real/ia, leitura humana no gate) + linha de crédito
   - Escreve `_internal/01-eai-meta.json` com `ai_side: "A" | "B"` (slot da imagem IA = resposta correta no poll)
4. **Gate humano**: mostrar texto de `01-eai.md` (frontmatter revela o mapping pro editor) + paths das duas imagens. Aprovar ou pedir para tentar o dia anterior.

## Output

- `data/editions/{AAMMDD}/01-eai.md` — frontmatter `eai_answer` + linha de crédito com links
- `data/editions/{AAMMDD}/01-eai-A.jpg` — slot A (real ou IA, depende do sorteio)
- `data/editions/{AAMMDD}/01-eai-B.jpg` — slot B (oposto de A)
- `data/editions/{AAMMDD}/_internal/01-eai-meta.json` — metadata estruturada com `ai_side`
- `data/editions/{AAMMDD}/_internal/01-eai-sd-prompt.json` — prompt usado na geração

## Notas

- Requer conexão com internet (Wikimedia API pública, sem auth).
- Se `01-eai-A.jpg`/`01-eai-B.jpg` já existirem, perguntar se quer regenerar antes de prosseguir.
- Edições antigas (pré-#192) têm `01-eai-real.jpg`/`01-eai-ia.jpg` no lugar — readers (`render-newsletter-html.ts`, `upload-images-public.ts`) detectam automaticamente.
- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
