---
name: diaria-3-imagens
description: Roda a Etapa 3 (É IA? + imagens de destaque). Uso — `/diaria-3-imagens AAMMDD [eia|d1|d2|d3]`.
---

# /diaria-3-imagens

Dispara a Etapa 3 da edição Diar.ia: coleta o resultado do `eia-composer` (disparado em background na Etapa 1) e gera as 3 imagens de destaque em estilo impasto Van Gogh via Gemini API.

## Argumentos

- `$1` = data da edição (`AAMMDD`, ex: `260423`). Se não passar, rodar `npx tsx scripts/lib/find-current-edition.ts --stage 3` e parsear `candidates[]` do JSON de saída (#583):
  - **Se `candidates.length === 1`**: assumir essa edição. Logar info: `Assumindo edição em curso: {AAMMDD}`. Editor pode interromper se errado.
  - **Se `candidates.length === 0`**: erro. `Nenhuma edição com Stage 2 aprovado e Stage 3 incompleto. Rode /diaria-2-escrita primeiro ou passe AAMMDD explicitamente.`
  - **Se `candidates.length >= 2`**: perguntar ao editor qual: `Múltiplas edições em curso: {lista}. Qual processar?`
- `$2` (opcional) = sub-comando:
  - Sem argumento → roda É IA? + todas as imagens de destaque (d1, d2, d3)
  - `eia` → roda só o É IA? (útil para regenerar sem refazer imagens)
  - `d1` / `d2` / `d3` → regenera só aquela imagem de destaque

## Pré-requisitos

- `data/editions/$1/_internal/01-approved.json` deve existir (para É IA? buscar contexto da edição)
- `GEMINI_API_KEY` configurada como variável de ambiente (para geração das imagens e É IA?)
- Para as imagens de destaque: `data/editions/$1/_internal/02-d1-prompt.md`, `_internal/02-d2-prompt.md`, `_internal/02-d3-prompt.md` devem existir (gerados pela Etapa 2 — writer; #607)
- (Opcional) `BEEHIIV_API_KEY` + `BEEHIIV_PUBLICATION_ID` para auto-fill de resultado do poll anterior no É IA?

## Parte 1 — É IA? (pular se `$2 = d1|d2|d3`)

> **Nota (#371):** a aprovação do É IA? acontece no gate integrado da Etapa 1, onde o bloco É IA? é embutido em `01-categorized.md` entre as seções Pesquisas e Notícias. Este skill usa o sub-comando `eai` principalmente para **regeneração** — quando o editor quer refazer o É IA? sem reprocessar as imagens de destaque.

### 1a. Coletar resultado do background dispatch

O `eia-composer` foi disparado em background durante a Etapa 1. Verificar se já completou:

- Se `data/editions/$1/01-eia.md` já existe → pular dispatch, ir direto ao gate do É IA? abaixo.
- Se `01-eia.md` **não** existe:
  - Se há Agent em background ainda rodando → aguardar.
  - Caso contrário → disparar agora:

    ```
    Agent({
      subagent_type: "eia-composer",
      description: "É IA? composer",
      prompt: "Gera o bloco É IA? para a edição $1. edition_date=$1, out_dir=data/editions/$1/. Seguir as instruções completas do agente eia-composer."
    })
    ```

    Aguardar o Agent retornar antes de continuar.

### 1b. Gate do É IA? (relevante principalmente para sub-comando `eai`)

Apresentar ao usuário para confirmação/retry:

```
É IA? pronto.

📁 data/editions/$1/01-eia.md  (frontmatter revela o mapping real/IA pro editor)
📁 data/editions/$1/01-eia-A.jpg
📁 data/editions/$1/01-eia-B.jpg

ℹ️  A aprovação editorial já aconteceu (ou acontecerá) no gate integrado da Etapa 1,
    onde o É IA? aparece embutido em 01-categorized.md (#371).

Aprovar aqui (sim) / tentar dia anterior / pedir retry?
```

Aguardar resposta. Se "sim", continuar. Se "dia anterior", re-rodar eia-composer com data D-1.

## Parte 2 — Imagens de destaque (pular se `$2 = eia`)

### 2a. Drive sync pull

Puxar prompts do Drive (caso o editor tenha editado):

```bash
npx tsx scripts/drive-sync.ts --mode pull --edition-dir data/editions/$1/ --stage 3 --files _internal/02-d1-prompt.md,_internal/02-d2-prompt.md,_internal/02-d3-prompt.md
```

Falha = warning, **nunca bloqueia**.

### 2a-bis. Match prompts → destaques atuais (#606)

Editor pode ter reordenado destaques no gate da Etapa 2 (D1↔D3, etc.).
Antes de gerar imagens, alinhar prompts à ordem atual do `02-reviewed.md`:

```bash
npx tsx scripts/match-prompts-to-destaques.ts --edition-dir data/editions/$1/
```

Se prompts já alinhados (ordem original respeitada) → no-op silencioso.
Se reordenados → renomeia `_internal/02-d1-prompt.md` ↔ `_internal/02-d3-prompt.md` (ou rotação 3-cycle) pra match com `02-reviewed.md`.

Output JSON: `{ ok, swaps[], reason }`. Logar como info no run-log.

Pré-requisito: writer agent emitiu `destaque_url:` em frontmatter de cada prompt (writer.md step 6).

### 2b. Gerar imagens

Para cada destaque indicado (ou todos se sem argumento), chamar **uma vez** por destaque:

```bash
npx tsx scripts/image-generate.ts \
  --editorial data/editions/$1/_internal/02-d{N}-prompt.md \
  --out-dir data/editions/$1/ \
  --destaque d{N}
```

Substituir `d{N}` por `d1`, `d2`, `d3`. **D1 gera automaticamente 2 arquivos** (`04-d1-2x1.jpg` 1600×800 + `04-d1-1x1.jpg` 800×800 via center-crop) numa única chamada — sem segunda chamada separada. D2/D3 geram `04-d2-1x1.jpg` e `04-d3-1x1.jpg` (1024×1024).

O script também grava `04-d{N}-sd-prompt.json` com o prompt exato usado na geração.

Se a imagem já existir e não quiser regenerar, script sai com exit 0. Para forçar regeneração usar `--force`.

Backend padrão: Gemini (`gemini-3.1-flash-image-preview`, ~15s por imagem). Para ComfyUI, setar `image_generator: "comfyui"` em `platform.config.json`.

### 2c. Drive sync push

```bash
npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/$1/ --stage 3 --files 01-eia-A.jpg,01-eia-B.jpg,04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-1x1.jpg,04-d3-1x1.jpg,04-d1-sd-prompt.json,04-d2-sd-prompt.json,04-d3-sd-prompt.json,_internal/01-eia-meta.json,_internal/02-d1-prompt.md,_internal/02-d2-prompt.md,_internal/02-d3-prompt.md
```

> **Nota (#582):** `01-eia.md` **não vai pro Drive** — conteúdo (linha de crédito + gabarito A/B) já está embutido em `01-categorized.md` via `render-categorized-md.ts` (#371) e `eia_answer` é propagado pra `02-reviewed.md` frontmatter via `normalize-newsletter.ts` (#744). Arquivo permanece local pra scripts consumirem.

Anotar warnings pra mencionar no gate. Falha não bloqueia.

### 2d. Gate unificado de imagens

**Se `--no-gate`:** pular. Emitir `[AUTO] Etapa 3 auto-aprovada` e finalizar.

**Caso contrário:**

```
Etapa 3 — Imagens prontas.

É IA?:
  📁 data/editions/$1/01-eia-A.jpg
  📁 data/editions/$1/01-eia-B.jpg

Imagens de destaque:
  📁 data/editions/$1/04-d1-2x1.jpg  (+ 04-d1-1x1.jpg)
  📁 data/editions/$1/04-d2-1x1.jpg
  📁 data/editions/$1/04-d3-1x1.jpg

[⚠️ Drive sync: N warning(s)] (se houve)

Aprovar (sim) / regenerar imagem individual (ex: "d2") / pedir retry completo?
```

Aguardar resposta. "sim" → finalizar. "d1"/"d2"/"d3" → re-rodar Parte 2 para aquela imagem. "retry" → re-rodar Parte 2 completa.

## Outputs

- `data/editions/$1/01-eia.md` — frontmatter `eia_answer` + linha de crédito
- `data/editions/$1/01-eia-A.jpg` — slot A (real ou IA, depende do sorteio)
- `data/editions/$1/01-eia-B.jpg` — slot B (oposto de A)
- `data/editions/$1/_internal/01-eia-meta.json` — metadata com `ai_side`
- `data/editions/$1/04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg`, `04-d3-1x1.jpg`
- `data/editions/$1/04-d{N}-sd-prompt.json` — prompts usados na geração

## Notas

- Requer conexão com internet (Wikimedia API pública para É IA?, Gemini API para geração).
- Se `01-eia-A.jpg`/`01-eia-B.jpg` já existirem, perguntar se quer regenerar.
- Edições antigas (pré-#192) têm `01-eia-real.jpg`/`01-eia-ia.jpg` no lugar.
- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
