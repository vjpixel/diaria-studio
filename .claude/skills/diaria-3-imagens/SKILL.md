---
name: diaria-3-imagens
description: Roda a Etapa 3 (É IA? + imagens de destaque). Uso — `/diaria-3-imagens AAMMDD [eai|d1|d2|d3]`.
---

# /diaria-3-imagens

Dispara a Etapa 3 da edição Diar.ia: coleta o resultado do `eai-composer` (disparado em background na Etapa 1) e gera as 3 imagens de destaque em estilo impasto Van Gogh via Gemini API.

## Argumentos

- `$1` = data da edição (`AAMMDD`, ex: `260423`). **Se não passar, perguntar explicitamente** ao usuário antes de prosseguir — nunca inferir a partir de `today()`. Sugerir hoje/ontem como atalhos mas exigir confirmação:
  > "Você não passou a data da edição. Qual edição você quer processar? hoje ({AAMMDD_hoje}) / ontem ({AAMMDD_ontem}) / outra (informe AAMMDD)"
- `$2` (opcional) = sub-comando:
  - Sem argumento → roda É IA? + todas as imagens de destaque (d1, d2, d3)
  - `eai` → roda só o É IA? (útil para regenerar sem refazer imagens)
  - `d1` / `d2` / `d3` → regenera só aquela imagem de destaque

## Pré-requisitos

- `data/editions/$1/_internal/01-approved.json` deve existir (para É IA? buscar contexto da edição)
- `GEMINI_API_KEY` configurada como variável de ambiente (para geração das imagens e É IA?)
- Para as imagens de destaque: `data/editions/$1/02-d1-prompt.md`, `02-d2-prompt.md`, `02-d3-prompt.md` devem existir (gerados pela Etapa 2 — writer)
- (Opcional) `BEEHIIV_API_KEY` + `BEEHIIV_PUBLICATION_ID` para auto-fill de resultado do poll anterior no É IA?

## Parte 1 — É IA? (pular se `$2 = d1|d2|d3`)

### 1a. Coletar resultado do background dispatch

O `eai-composer` foi disparado em background durante a Etapa 1. Verificar se já completou:

- Se `data/editions/$1/01-eai.md` já existe → pular dispatch, ir direto ao gate do É IA?.
- Se `01-eai.md` **não** existe:
  - Se há Agent em background ainda rodando → aguardar.
  - Caso contrário → disparar agora:

    ```
    Agent({
      subagent_type: "eai-composer",
      description: "É IA? composer",
      prompt: "Gera o bloco É IA? para a edição $1. edition_date=$1, out_dir=data/editions/$1/. Seguir as instruções completas do agente eai-composer."
    })
    ```

    Aguardar o Agent retornar antes de continuar.

### 1b. Gate do É IA?

Apresentar ao usuário:

```
Etapa 3 — É IA? pronto.

📁 data/editions/$1/01-eai.md  (frontmatter revela o mapping real/IA pro editor)
📁 data/editions/$1/01-eai-A.jpg
📁 data/editions/$1/01-eai-B.jpg

Aprovar (sim) / tentar dia anterior / pedir retry?
```

Aguardar resposta. Se "sim", continuar. Se "dia anterior", re-rodar eai-composer com data D-1.

## Parte 2 — Imagens de destaque (pular se `$2 = eai`)

### 2a. Drive sync pull

Puxar prompts do Drive (caso o editor tenha editado):

```bash
npx tsx scripts/drive-sync.ts --mode pull --edition-dir data/editions/$1/ --stage 3 --files 02-d1-prompt.md,02-d2-prompt.md,02-d3-prompt.md
```

Falha = warning, **nunca bloqueia**.

### 2b. Gerar imagens

Para cada destaque indicado (ou todos se sem argumento):

1. Ler `data/editions/$1/02-d{N}-prompt.md`.
2. Montar prompt estilo impasto Van Gogh + gravar `data/editions/$1/04-d{N}-sd-prompt.json`.
3. Chamar:
   ```bash
   npx tsx scripts/image-generate.ts \
     --prompt-file data/editions/$1/02-d{N}-prompt.md \
     --out data/editions/$1/04-d{N}.jpg \
     --sd-prompt-out data/editions/$1/04-d{N}-sd-prompt.json
   ```

Backend padrão: Gemini (`gemini-3.1-flash-image-preview`, ~15s por imagem). Para ComfyUI, setar `image_generator: "comfyui"` em `platform.config.json`.

Para d1, gerar também versão 2×1:
```bash
npx tsx scripts/image-generate.ts \
  --prompt-file data/editions/$1/02-d1-prompt.md \
  --out data/editions/$1/04-d1-2x1.jpg \
  --aspect 2x1 \
  --sd-prompt-out data/editions/$1/04-d1-sd-prompt.json
```

### 2c. Drive sync push

```bash
npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/$1/ --stage 3 --files 01-eai.md,01-eai-A.jpg,01-eai-B.jpg,04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-1x1.jpg,04-d3-1x1.jpg
```

Anotar warnings pra mencionar no gate. Falha não bloqueia.

### 2d. Gate unificado de imagens

**Se `--no-gate`:** pular. Emitir `[AUTO] Etapa 3 auto-aprovada` e finalizar.

**Caso contrário:**

```
Etapa 3 — Imagens prontas.

É IA?:
  📁 data/editions/$1/01-eai-A.jpg
  📁 data/editions/$1/01-eai-B.jpg

Imagens de destaque:
  📁 data/editions/$1/04-d1-2x1.jpg  (+ 04-d1-1x1.jpg)
  📁 data/editions/$1/04-d2-1x1.jpg
  📁 data/editions/$1/04-d3-1x1.jpg

[⚠️ Drive sync: N warning(s)] (se houve)

Aprovar (sim) / regenerar imagem individual (ex: "d2") / pedir retry completo?
```

Aguardar resposta. "sim" → finalizar. "d1"/"d2"/"d3" → re-rodar Parte 2 para aquela imagem. "retry" → re-rodar Parte 2 completa.

## Outputs

- `data/editions/$1/01-eai.md` — frontmatter `eai_answer` + linha de crédito
- `data/editions/$1/01-eai-A.jpg` — slot A (real ou IA, depende do sorteio)
- `data/editions/$1/01-eai-B.jpg` — slot B (oposto de A)
- `data/editions/$1/_internal/01-eai-meta.json` — metadata com `ai_side`
- `data/editions/$1/04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg`, `04-d3-1x1.jpg`
- `data/editions/$1/04-d{N}-sd-prompt.json` — prompts usados na geração

## Notas

- Requer conexão com internet (Wikimedia API pública para É IA?, Gemini API para geração).
- Se `01-eai-A.jpg`/`01-eai-B.jpg` já existirem, perguntar se quer regenerar.
- Edições antigas (pré-#192) têm `01-eai-real.jpg`/`01-eai-ia.jpg` no lugar.
- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
