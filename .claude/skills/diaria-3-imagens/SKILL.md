---
name: diaria-3-imagens
description: Roda a Etapa 3 (É IA? + imagens de destaque). Uso — `/diaria-3-imagens AAMMDD [eia|d1|d2|d3]`.
---

# /diaria-3-imagens

Dispara a Etapa 3 da edição diar.ia.br: coleta o resultado do `eia-composer` (disparado em background na Etapa 1) e gera as 3 imagens de destaque em estilo impasto Van Gogh via Gemini API.

## Argumentos

- `$1` = data da edição (`AAMMDD`, ex: `260423`). Se não passar, rodar `npx tsx scripts/lib/find-current-edition.ts --stage 3` e parsear `candidates[]` do JSON de saída (#583):
  - **Se `candidates.length === 1`**: assumir essa edição. Logar info: `Assumindo edição em curso: {AAMMDD}`. Editor pode interromper se errado.
  - **Se `candidates.length === 0`**: erro. `Nenhuma edição com Stage 2 aprovado e Stage 3 incompleto. Rode /diaria-2-escrita primeiro ou passe AAMMDD explicitamente.`
  - **Se `candidates.length >= 2`**: default (#5321) — assumir a mais recente (`candidates[candidates.length - 1]`, lista vem ordenada ascendente) e imprimir banner: `Múltiplas edições em curso: {lista}. Assumindo a mais recente: {AAMMDD}. Passe AAMMDD explicitamente para outra.` Editor pode interromper se errado.
- `$2` (opcional) = sub-comando:
  - Sem argumento → roda É IA? + todas as imagens de destaque (d1, d2, d3)
  - `eia` → roda só o É IA? (útil para regenerar sem refazer imagens)
  - `d1` / `d2` / `d3` → regenera só aquela imagem de destaque
- `--no-gates` (opcional, #5738) = auto-aprova o gate deste stage. Existe para o runner AGENDADO (`scripts/overnight/run-scheduled-edicao.ts`), que desde o #5738 invoca uma skill `/diaria-N-*` por sessão em modo `--print`: sem esta flag o gate seria apresentado e ninguém responderia, queimando os turnos da sessão sem escrever sentinela. Equivale ao `auto_approve = true` que `/diaria-edicao` já setava internamente para os Stages 1-3 (pre-gate mode, #1523). **Nunca alcança publicação** — Stages 5/6 não estão em `STAGE_PLAN` e o runner nunca os invoca.

## Placeholders

- `$1` → AAMMDD recebido como argumento.
- `{EDIR}` → diretório REAL da edição no disco (#2463/#3024). **Nunca** montar como `data/editions/$1` — a edição pode estar no layout flat legado OU no nested novo, dependendo de quando foi criada. Resolver **uma vez**, antes de qualquer leitura/escrita:
  ```bash
  EDIR=$(npx tsx scripts/lib/find-current-edition.ts --resolve $1)
  ```

## Pré-requisitos

- `{EDIR}/_internal/01-approved.json` deve existir (para É IA? buscar contexto da edição)

## Passo 0 — Task tracking setup (#904)

**Defensive cleanup**: varrer `TaskList()` e marcar como `completed` qualquer task `in_progress` de Stages anteriores (`Stage 0*`, `Stage 1*`, `Stage 2*`). Em seguida, criar tasks pra esta etapa: `Stage 3a — É IA? collect/regenerate`, `Stage 3b — image generate (d1/d2/d3)`, `Stage 3c — gate humano`. Marcar `completed` quando cada passo retornar; `Stage 3c` fecha imediatamente após aprovação do gate. Detalhe completo em `.claude/agents/orchestrator.md` § "Task tracking — UI hygiene". **No-op se TaskCreate/TaskUpdate não estiver disponível**.
- `GEMINI_API_KEY` configurada como variável de ambiente (para geração das imagens e É IA?)
- Para as imagens de destaque: `{EDIR}/_internal/02-d1-prompt.md`, `_internal/02-d2-prompt.md`, `_internal/02-d3-prompt.md` devem existir (gerados pela Etapa 2 — writer; #607)
- (Opcional) `BEEHIIV_API_KEY` + `BEEHIIV_PUBLICATION_ID` para auto-fill de resultado do poll anterior no É IA?

## Parte 1 — É IA? (rodar APENAS se `$2 = eia`; #371, #748)

A aprovação do É IA? acontece no **gate integrado da Etapa 1**, onde o bloco É IA? é embutido em `01-categorized.md` entre as seções Pesquisas e Notícias. Este skill só processa a Parte 1 quando o editor invoca explicitamente com `$2 = eia` para **regeneração** — quando quer refazer o É IA? após Etapa 1 já aprovada (ex: imagem A/B insatisfatória, POTD ruim).

**Em invocação default (sem `$2`) ou com `$2 = d1|d2|d3`: pular toda a Parte 1.** Não re-apresenta gate nem re-dispara `eia-composer` — o resultado já foi aprovado na Etapa 1.

### 1a. Coletar resultado do background dispatch (#1111)

O `scripts/eia-compose.ts` foi disparado em background durante a Etapa 1 via `Bash(run_in_background=true)` (era Agent dispatch antes de #1111).

- Se `{EDIR}/01-eia.md` já existe → pular dispatch, ir direto ao gate do É IA? abaixo.
- Se `01-eia.md` **não** existe:
  - Se há background bash ainda rodando (via `eia_bash_id`) → aguardar via file-presence check (pollar `existsSync('{EDIR}/01-eia.md')` a cada 10s).
  - Caso contrário → disparar agora:

    ```bash
    npx tsx scripts/eia-compose.ts --edition $1 --out-dir {EDIR}/
    ```

    Aguardar o script terminar (Bash síncrono, sem `run_in_background`) antes de continuar.

### 1b. Gate do É IA? (relevante principalmente para sub-comando `eai`)

Apresentar ao usuário para confirmação/retry:

```
É IA? pronto.

📁 {EDIR}/01-eia.md  (frontmatter revela o mapping real/IA pro editor)
📁 {EDIR}/01-eia-A.jpg
📁 {EDIR}/01-eia-B.jpg

ℹ️  A aprovação editorial já aconteceu (ou acontecerá) no gate integrado da Etapa 1,
    onde o É IA? aparece embutido em 01-categorized.md (#371).

Aprovar aqui (sim) / tentar dia anterior / pedir retry?
```

**Se `--no-gates` (#5738):** pular este gate — assumir "sim" e continuar.

Caso contrário, aguardar resposta. Se "sim", continuar. Se "dia anterior", re-rodar eia-composer com data D-1.

## Parte 2 — Imagens de destaque (pular se `$2 = eia`)

### 2a-bis. Match prompts → destaques atuais (#606)

Editor pode ter reordenado destaques no gate da Etapa 2 (D1↔D3, etc.).
Antes de gerar imagens, alinhar prompts à ordem atual do `02-reviewed.md`:

```bash
npx tsx scripts/match-prompts-to-destaques.ts --edition-dir {EDIR}/
```

Se prompts já alinhados (ordem original respeitada) → no-op silencioso.
Se reordenados → renomeia `_internal/02-d1-prompt.md` ↔ `_internal/02-d3-prompt.md` (ou rotação 3-cycle) pra match com `02-reviewed.md`.

Output JSON: `{ ok, swaps[], reason }`. Logar como info no run-log.

Pré-requisito: writer agent emitiu `destaque_url:` em frontmatter de cada prompt (writer.md step 6).

### 2b. Runner determinístico (`scripts/stage-3-run.ts`, #5415) — CAMINHO ÚNICO de 2b/2c (#5822, #6740)

**Não reimplementar os comandos individuais de geração de imagem aqui.** Até o #6740 este passo listava `image-generate.ts`/`gen-social-card-4x5.ts` em prosa própria (a mesma prosa que o #5822 tinha corrigido pra incluir o card 4:5), separada de `.claude/agents/orchestrator-stage-3.md` — e quando o #6005 Parte B acrescentou `gen-carousel-cards.ts` (carrossel obrigatório de 5 slides do Instagram) só àquele outro arquivo, esta skill ficou defasada em silêncio: uma edição rodada via `/diaria-3-imagens --no-gates` (o caminho headless de `run-edition-stages.ts`) reportava `OK` sem gerar nenhum dos 12 slides de carrossel, porque este texto nunca mandava rodar aquele script (achado ao vivo #6740, edição 260830). Delegar ao mesmo runner que `orchestrator-stage-3.md` usa elimina a classe inteira — os dois caminhos (`/diaria-edicao` e `/diaria-3-imagens` standalone) passam a executar o MESMO código, não duas prosas que podem divergir de novo na próxima feature.

Chamar, para os destaques indicados (todos se `$2` estiver vazio, ou o único de `$2 = d1|d2|d3`):

```bash
npx tsx scripts/stage-3-run.ts --edition $1 [--only d{N}] [--force]
```

Cobre lint pre-flight → `image-generate.ts` (2x1/1x1 + 4x5 nativo) por destaque → `gen-social-card-4x5.ts` (card 4:5 com título) → `gen-carousel-cards.ts` (#6005 Parte B — 3 slides de parágrafo + CTA do carrossel do Instagram) → leaderboard top1 (fail-soft) → box de campeões → pre-gate invariants (`check-invariants.ts --stage 3`) → descoberta dos pares do crop-reviewer.

Interpretar o JSON de saída:
- `code: 0` → miolo concluído. Usar `destaques[]` (por destaque: `lintOk`/`imageGenerated`/`nativeArt4x5Generated`), `cardsGenerated`, `carouselCardsGenerated`, `championsInjected`, `invariantsPassed`/`invariantsViolations` e `cropReviewPairs` no resumo do gate abaixo.
- `code: 1` → erro duro/BLOQUEANTE (imagem, card 4:5 ou carrossel com exit ≠ 0 — #4090/#6005) — **PARAR**, mostrar `notes[]` completo ao editor (causa mais comum: `assertBrandSerifAvailable`, fonte Georgia ausente — instalar ou setar `DIARIA_ALLOW_FONT_FALLBACK=1`). Não seguir para o gate 2d.
- `code: 2` → HALT obrigatório (`haltRequired`, banner já renderizado pelo script — ComfyUI indisponível, ou #4583 raffle stale) — parar mesmo com `--no-gates`.
- Destaque com `lintOk: false` → geração pausada só naquele destaque (`lintViolations` no resultado) — mostrar ao editor.
- `cropReviewPairs` não-vazio → dispatchar `Agent("image-crop-reviewer", { edition: $1, pairs: cropReviewPairs, out_path })`, depois persistir com `run-image-crop-reviewer.ts --edition-dir {EDIR}/ --input-json <output-do-agent>`.

**Fallback**: se o script não existir, ou falhar de um jeito não coberto pelos `code`s acima (erro de spawn, exceção fora do `try/catch`), seguir os comandos individuais documentados em `.claude/agents/orchestrator-stage-3.md` §3b (fonte única do fallback em prosa — não duplicar aqui, pra não recriar o mesmo drift que motivou este passo).

@see scripts/stage-3-run.ts (docstring no topo tem o mapeamento seção-a-seção do que está coberto vs. delegado)

### 2d. Gate unificado de imagens

Antes do gate, rodar o invariant check (defesa em profundidade — mesmo comando que `.claude/agents/orchestrator-stage-3.md` roda no pre-gate, cobre a regra `card-4x5-exists` entre outras):

```bash
npx tsx scripts/check-invariants.ts --stage 3 --edition-dir {EDIR}/
```

Exit 0 → seguir para o gate abaixo. Exit 1 → bloquear o gate, mostrar as violações ao editor (qual destaque/arquivo falta) e voltar ao passo correspondente (2b ou 2c) antes de tentar de novo — **nunca apresentar o gate com invariante vermelho**.

**Se `--no-gate`:** pular. Emitir `[AUTO] Etapa 3 auto-aprovada`, escrever o sentinel (#5793) e finalizar:

```bash
npx tsx scripts/pipeline-sentinel.ts write \
  --edition $1 --step 3 \
  --outputs "01-eia.md,01-eia-A.jpg,01-eia-B.jpg,04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-1x1.jpg,04-d3-1x1.jpg,04-d1-4x5.jpg,04-d2-4x5.jpg,04-d3-4x5.jpg"
```

**Caso contrário:**

```
Etapa 3 — Imagens prontas.

É IA?:
  📁 {EDIR}/01-eia-A.jpg
  📁 {EDIR}/01-eia-B.jpg

Imagens de destaque:
  📁 {EDIR}/04-d1-2x1.jpg  (+ 04-d1-1x1.jpg, 04-d1-4x5.jpg)
  📁 {EDIR}/04-d2-1x1.jpg  (+ 04-d2-4x5.jpg)
  📁 {EDIR}/04-d3-1x1.jpg  (+ 04-d3-4x5.jpg)

Aprovar (sim) / regenerar imagem individual (ex: "d2") / pedir retry completo?
```

**Se `--no-gates` (#5738):** pular este gate — assumir "sim", finalizar direto (escrever o sentinel abaixo antes de retornar). É o que o runner agendado precisa: em `--print` ninguém responde, e sem isto a sessão queimaria os turnos aguardando e morreria sem escrever o sentinel do Stage 3.

Caso contrário, aguardar resposta. "sim" → finalizar (escrever o sentinel abaixo). "d1"/"d2"/"d3" → re-rodar Parte 2 (2b + 2c) para aquela imagem. "retry" → re-rodar Parte 2 completa.

**Escrever sentinel de conclusão (#5793)** — cobre tanto `--no-gates` quanto o "sim" respondido organicamente pelo editor:

```bash
npx tsx scripts/pipeline-sentinel.ts write \
  --edition $1 --step 3 \
  --outputs "01-eia.md,01-eia-A.jpg,01-eia-B.jpg,04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-1x1.jpg,04-d3-1x1.jpg,04-d1-4x5.jpg,04-d2-4x5.jpg,04-d3-4x5.jpg"
```

## Outputs

- `{EDIR}/01-eia.md` — frontmatter `eia_answer` + linha de crédito
- `{EDIR}/01-eia-A.jpg` — slot A (real ou IA, depende do sorteio)
- `{EDIR}/01-eia-B.jpg` — slot B (oposto de A)
- `{EDIR}/_internal/01-eia-meta.json` — metadata com `ai_side`
- `{EDIR}/04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg`, `04-d3-1x1.jpg`
- `{EDIR}/04-d1-4x5-nativo.jpg`, `04-d2-4x5-nativo.jpg`, `04-d3-4x5-nativo.jpg` — arte 4:5 nativa, insumo do card
- `{EDIR}/04-d1-4x5.jpg`, `04-d2-4x5.jpg`, `04-d3-4x5.jpg` — card final com título embutido (#4114), o que `selectSocialCardImageFile` escolhe pro feed Facebook/Instagram
- `{EDIR}/04-d{N}-carousel-{p1,p2,p3,cta}-4x5.jpg` — slides sem foto do carrossel do Instagram (#6005 Parte B), 1 por destaque presente, gerados por `gen-carousel-cards.ts` dentro do runner do passo 2b
- `{EDIR}/04-d{N}-sd-prompt.json` — prompts usados na geração

## Notas

- Requer conexão com internet (Wikimedia API pública para É IA?, Gemini API para geração).
- Se `01-eia-A.jpg`/`01-eia-B.jpg` já existirem, perguntar se quer regenerar.
- Edições antigas (pré-#192) têm `01-eia-real.jpg`/`01-eia-ia.jpg` no lugar.
- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
