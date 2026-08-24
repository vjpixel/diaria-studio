---
name: orchestrator-stage-3
description: Detalhe da Etapa 3 (imagens — É IA? coleta + destaques) do orchestrator diar.ia.br. O miolo determinístico de §3b roda via `scripts/stage-3-run.ts` (#5415); a prosa detalhada é referência/fallback. Lido pelo orchestrator principal durante a execução — não é um subagente invocável diretamente.
---

> Este arquivo é referenciado por `orchestrator.md` via `@see`. Não executar diretamente.

---

## Etapa 3 — Imagens

**`{EDITION_DIR}` (#2463/#3025/#3530):** diretório REAL da edição no disco — pode ser o layout flat legado OU o nested novo, dependendo de quando a edição foi criada. Já foi resolvido em stages anteriores — se este stage estiver rodando na mesma sessão, reusar o valor. Se estiver rodando isolado (resume, skill separada), resolver de novo (idempotente — encontra o que já está no disco):
```bash
EDITION_DIR=$(npx tsx scripts/lib/find-current-edition.ts --resolve {AAMMDD})
```

### Pré-condição: sentinel Stage 2

<!-- outputs must match the `write` call at the end of orchestrator-stage-2.md §Escrever sentinel de conclusão do Stage 2 -->
```bash
npx tsx scripts/pipeline-sentinel.ts assert \
  --edition {AAMMDD} --step 2 \
  --outputs "02-reviewed.md,03-social.md"
```

Exit code handling:
- `0` → continuar.
- `1` → **FATAL:** "Etapa 2 não completou (sentinel ausente). Re-rodar `/diaria-2-escrita {AAMMDD}` antes de continuar." Parar.
- `2` → **FATAL:** "Outputs do Stage 2 ausentes. Re-rodar Etapa 2." Parar.
- `3` → logar warn (`npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 3 --agent orchestrator --level warn --message "stage2_sentinel_missing_legacy"`), continuar.

**MCP disconnect logging:** ver `orchestrator.md` § "MCP disconnect — logging + halt banner" (#759/#737). Nesta etapa: `--stage 3`, banner `--stage "3 — Imagens"`, reason inclui também falha na API de imagem (Gemini/ComfyUI).

### Runner determinístico (`scripts/stage-3-run.ts`, #5415) — CAMINHO PRINCIPAL DO MIOLO DE §3b

Cobre só o miolo determinístico de §3b: lint pre-flight → `image-generate.ts` (2x1/1x1 + 4x5 nativo) por destaque → card 4:5 → leaderboard top1 → box de campeões → pre-gate invariants → descoberta dos pares do crop-reviewer. **Não cobre** §3a (polling do É IA? em background), §3a-bis (`Skill("humanizador")` + `mcp__clarice__correct_text`), o dispatch `Agent("image-crop-reviewer", ...)` de §3b, nem o gate humano final + sentinel — nenhum desses é alcançável de um `spawnSync` (script Node puro, sem MCP/Skill/Agent/espera de resposta). Rodar §3a e §3a-bis normalmente primeiro (abaixo); com `01-eia.md` disponível (ou skip decidido), invocar:
```bash
npx tsx scripts/stage-3-run.ts --edition {AAMMDD} [--only d1,d2] [--force]
```
Interpretar o JSON de saída:
- `code: 0` → miolo concluído. Usar `destaques[]` (por destaque: `lintOk`/`imageGenerated`/`nativeArt4x5Generated`), `cardsGenerated`, `championsInjected`, `invariantsPassed`/`invariantsViolations` e `cropReviewPairs` no lugar de rodar os comandos individuais de §3b abaixo.
- `code: 1` → erro duro/BLOQUEANTE (ex: geração de imagem ou composição do card com exit ≠ 0) — parar e reportar `notes[]` ao editor, mesma severidade do #4090.
- `code: 2` → HALT obrigatório (`haltRequired`, banner já renderizado pelo script — ComfyUI indisponível, ou #4583 raffle stale) — parar mesmo com `auto_approve`.
- Destaque com `lintOk: false` → geração pausada só naquele destaque (`lintViolations` no resultado) — mostrar ao editor, mesmo fluxo do lint pre-flight abaixo.
- `cropReviewPairs` não-vazio → `pendingAgentDispatch[0]` já traz a chamada pronta: dispatchar `Agent("image-crop-reviewer", { edition, pairs: cropReviewPairs, out_path })`, depois persistir com `run-image-crop-reviewer.ts --edition-dir {EDITION_DIR}/ --input-json <output-do-agent>` (mesmo fluxo do §3b abaixo).
- `delegatedSteps[]` — confirma os passos que o script nunca tenta (3a, 3a-bis, dispatch do crop-reviewer, gate+sentinel).

**Fallback**: se o script não existir, ou falhar de um jeito não coberto pelos `code`s acima (erro de spawn, exceção fora do `try/catch`), seguir a prosa de §3b turno a turno (abaixo), exatamente como antes do #5415. A prosa abaixo permanece — é o fallback e a documentação do que o runner faz e por quê.

@see scripts/stage-3-run.ts (docstring no topo tem o mapeamento seção-a-seção do que está coberto vs. delegado)

### 3a. É IA? (coleta do background dispatch — gate absorvido pela Etapa 1, #371, #1111)

O `scripts/eia-compose.ts` foi disparado em background bash durante a Etapa 1 (#1111). O bloco É IA? já foi embutido em `01-categorized.md` para revisão integrada no gate da Etapa 1. Aqui apenas garantimos que o resultado está disponível antes de gerar as imagens de destaque.

Detecção de conclusão por **file-presence check** (mais robusto que pollar bash status). **Ler `eia_dispatch_ts` do disco, não de sessão (#5414)** — este stage roda com frequência como sessão nova (`/diaria-3-imagens`), sem o `eia_bash_id`/`eia_dispatch_ts` da conversa que disparou o Stage 1:
```bash
npx tsx scripts/lib/eia-dispatch-state.ts --edition-dir {EDITION_DIR} --read
```
Se `dispatchedAt` vier `null` (arquivo ausente — edição pré-#5414, ou dispatch nunca aconteceu) e `01-eia.md` também não existir, tratar como se o timeout já tivesse expirado: pular direto para a oferta de retry/skip abaixo em vez de aguardar 10min sem referência de quando começar a contar.

- **Se `{EDITION_DIR}/01-eia.md` existe:** script terminou. Continuar.
- **Se ainda não existe:** aguardar até 10 minutos a partir de `dispatchedAt` (do `eia-dispatch-state.json` lido acima — `eia_dispatch_ts` de sessão só serve como atalho quando esta é a MESMA sessão do Stage 1), pollando a cada ~10s via `existsSync`. Se expirar sem conclusão, reportar: `"⚠️ eia-compose não completou em 10min. Opções: (r) retry — re-disparar Bash; (s) skip — pular È IA? e continuar (será necessário adicionar manualmente antes do Stage 4)."` Em retry: re-disparar `npx tsx scripts/eia-compose.ts --edition {AAMMDD} --out-dir {EDITION_DIR}/ --force`, regravar `eia-dispatch-state.json` com o novo `dispatchedAt` (`npx tsx scripts/lib/eia-dispatch-state.ts --edition-dir {EDITION_DIR} --bash-id "{novo_bash_id}" --dispatched-at "{now_iso}"`) e aguardar mais 10min. Em skip: logar warn `eia_compose_timeout`, definir `eia_available = false`, continuar para 3b.
- Se eia-compose falhou (exit code != 0), logar erro + reportar. Oferecer retry com `--force`. Após retry bem-sucedido, re-renderizar `01-categorized.md` se ainda não tiver passado pelo gate da Etapa 1. (Edições antigas têm `01-eia-real.jpg`/`01-eia-ia.jpg`; ajustar manualmente em retry de pré-#192.)
- **Sem gate separado (#371).** O editor já aprovou (ou verá) o É IA? no gate integrado da Etapa 1. Se o eia-composer completou com sucesso, prosseguir pro passo de humanizador+Clarice abaixo, depois 3b. Se `rejections[]` no output do composer não estiver vazio, informar: `"É IA?: pulei N dia(s) — motivos: vertical (X), já usada em edição anterior (Y). Imagem escolhida é de {image_date_used}."` — contexto para o editor, sem bloquear o pipeline.
- **#4625: se `sd_prompt_locale` no output do composer vier `"pt_fallback"`**, informar: `"É IA?: prompt de imagem seguiu em pt-BR (fallback) — o backend configurado (não-gemini) esperava EN e o fetch de fallback à Wikimedia falhou/veio vazio; pode degradar a fidelidade da imagem gerada."` — mesmo tratamento não-bloqueante de `rejections[]` acima (contexto pro editor, sem interromper o pipeline; detalhe completo do erro já está em `data/run-log.jsonl`, ver `/diaria-log {AAMMDD}`). `"pt"`/`"en"` não precisam de nenhum aviso — são os caminhos saudáveis.
- **Opção de retry do É IA?:** se o editor precisar regenerar o É IA? isoladamente (ex: imagem insatisfatória), usar `/diaria-3-imagens {AAMMDD} eia` — o sub-skill tem gate próprio de aprovação para esse caso.
- **Sub-stage 3a (É IA?) tracking** (#1217 — removed cost.md). É IA? roda em background bash e termina sem chamada explícita de update-stage-status — orchestrator pode opcionalmente registrar conclusão via `--cost-usd 0 --tokens-in 0` se quiser explicitar gratuitidade do passo (Gemini API key).

### 3a-bis. Humanizador + Clarice na frase de descrição do É IA? (#4258 item 3)

Único texto do "É IA?" que passa por humanizador/Clarice — `wikimedia.description` (tradução Gemini EN→pt-BR), que alimenta a creditLine de `01-eia.md` E a revelação do jogo (`01-eia-meta.json`→KV→`renderEiaMetaHtml`). `buildPrevResultLine` é templado, fora de escopo.

1. `npx tsx scripts/extract-eia-description.ts --edition-dir {EDITION_DIR}/ --out {EDITION_DIR}/_internal/01-eia-description-raw.txt` — exit `2` = meta.json OK mas sem `description`, **skip pra 3b** (não é erro). Exit `3` = meta.json ausente/malformado → halt banner (#738), nunca skip silencioso.
2. `Skill("humanizador", "Leia {EDITION_DIR}/_internal/01-eia-description-raw.txt, humanize removendo marcas de IA, calibrando voz com data/past-editions.md. É 1 frase de descrição de imagem, não artigo. Salve em {EDITION_DIR}/_internal/01-eia-description-humanized.txt.")` — **retry 3x + abort Stage 3** se erro ou no-op byte-idêntico (#1072).
3. Clarice inline sobre o `-humanized.txt` (`mcp__clarice__correct_text`, sempre <9k chars, sem chunking; fallback REST `scripts/clarice-correct.ts --retry`, #738/#1329) → salvar em `-corrected.txt`. **Retry 3x + abort Stage 3** se MCP e fallback REST falharem ambos (mesmo padrão do passo 2 acima — nunca prosseguir pro passo 4 sem `-corrected.txt`). **Filtrar antes de aplicar** (achado ao vivo desta issue): Clarice tende a formalizar contrações casuais ("pra"→"para", "de novo"→"novamente") — destoa da voz do produto. Aplicar só correção de verdade (concordância, tu/você, anglicismo). **Na dúvida (#5321): default — descartar a correção duvidosa** (o texto original, casual, já passou pelo humanizador — o risco de manter uma marca de IA remanescente é menor que o de formalizar a voz do produto) **e registrar no log** (`log-event.ts --level info --message "clarice_correction_discarded"` com a correção descartada nos `--details`) — o editor revisa o descarte no gate da Etapa 4 se quiser reverter, em vez de travar o Stage 3 esperando resposta.
4. `npx tsx scripts/apply-eia-description.ts --edition-dir {EDITION_DIR}/ --corrected {EDITION_DIR}/_internal/01-eia-description-corrected.txt` — regenera creditLine + sincroniza `wikimedia.description` (mesma fonte, nunca divergem). Exit `3` = qualquer erro, inclusive `01-eia-compose-context.json` ausente (desde #4281 nunca mais tratado como skip benigno — histórico: `docs/orchestrator-stage-narrative-history.md#stage-3-eia-description-postmortem`) → **halt banner, nunca skip**.

### 3b. Imagens de destaque (referência/fallback — coberto por `scripts/stage-3-run.ts`, ver bloco "Runner determinístico" acima)

- `destaque_count` vem de `_internal/01-approved-capped.json` (`highlights.length`; default 3). `_internal/02-d3-prompt.md` só entra **se `destaque_count === 3`**.
- Se `platform.config.json > image_generator === "comfyui"`, checar `curl -sf http://127.0.0.1:8188/system_stats`; falhou → pausar e instruir o editor a subir o ComfyUI.
- **Lint pre-flight (#810).** Por destaque presente, `npx tsx scripts/lint-image-prompt.ts {EDITION_DIR}/_internal/02-d{N}-prompt.md` antes de gastar API call — detecta "Noite Estrelada"/"Starry Night" (mesmo negado), espiral/redemoinho perto de céu/estrelas/amarelo (#4201), pixels/DPI. Exit `1` = pausar só esse destaque (violações no stderr; editor edita e responde "retry" — nunca chamar `image-generate.ts` antes do lint passar). Exit `2` = I/O error, fatal pra esse destaque.
- **Gerar via script (sem Agent).** Por destaque, sequencial, DEPOIS do lint:
  ```bash
  npx tsx scripts/image-generate.ts --editorial {EDITION_DIR}/_internal/02-d{N}-prompt.md --out-dir {EDITION_DIR}/ --destaque d{N}
  ```
  **#2133/#2141:** D2/D3 também geram `04-d{N}-2x1.jpg` + `04-d{N}-1x1.jpg`, igual D1 (default de ratio é 2x1). Exit ≠ 0 → logar erro, não seguir pro próximo destaque. **#1325: nunca `--force` sem pedido explícito do editor** — skip-if-exists já cobre reentrada; `eia-compose` tem partial-state guard (HALT em vez de regen silenciosa).
- **Card 4:5 do feed (#4114).** Por destaque, gerar a arte 4:5 **nativa** (não recorte do 2:1 — o card é 0,8:1, precisa da altura que o 2:1 descarta) e compor o card com o título:
  ```bash
  npx tsx scripts/image-generate.ts --editorial {EDITION_DIR}/_internal/02-d{N}-prompt.md --out-dir {EDITION_DIR}/ --destaque d{N} --ratio 4x5
  # compõe TODOS os destaques prontos de uma vez — #5852: fonte COMPARTILHADA entre os cards
  # (computeCarouselTitleFontSize usa o menor overlayFittingFontSize do conjunto)
  npx tsx scripts/gen-social-card-4x5.ts --edition-dir {EDITION_DIR}/
  ```
  **Não é opcional pra feature existir** — `publish-facebook.ts`/`publish-instagram.ts` escolhem `04-d{N}-4x5.jpg` via `selectSocialCardImageFile`, com fallback SILENCIOSO pra 1x1 sem título se o arquivo faltar. **Falha aqui é BLOQUEANTE (#4090)** — parar o Stage 3 inteiro, mostrar stderr completo (causa comum: `assertBrandSerifAvailable` sem fonte Georgia — instalar ou `DIARIA_ALLOW_FONT_FALLBACK=1`). `check-invariants.ts --stage 3` (regra `card-4x5-exists`) reforça no pre-gate. Skip-if-exists vale igual; sem `--force` automático.
- **Carrossel do Instagram (#6005 Parte B).** Logo depois do card 4:5, gerar os 4 slides sem foto (3 parágrafos + CTA — a capa é o `04-d{N}-4x5.jpg` acima, não regenerado aqui):
  ```bash
  npx tsx scripts/gen-carousel-cards.ts --edition-dir {EDITION_DIR}/
  ```
  Lê `03-social.md` (`# Social` → `## d{N}`), divide o corpo em 3 parágrafos-card (`splitIntoParagraphCards`, `scripts/lib/daily-carousel-card.ts`). **Falha do render é BLOQUEANTE**, mesma classe do card 4:5 acima; falta de texto de UM destaque específico é best-effort (só aquele destaque cai pro fallback single-image no publish, ver `resolveCarouselImageUrls`). **Idempotência por CONTEÚDO desde o #6064**: pula o destaque só quando os 4 arquivos existem E o texto ainda bate com o carimbo de `_internal/.carousel-source-hash.json`; texto editado depois (painel Revisão do Stage 4) é REGERADO na próxima invocação, sem `--force`. Rodar de novo depois de editar o social é barato e é o conserto que o invariante `carousel-cards-stale` (Stage 4) manda fazer.
- **Revisor de crop (#3951, generalizado #4223).** Depois de gerar as imagens (inclusive o card):
  ```bash
  npx tsx scripts/run-image-crop-reviewer.ts --edition-dir {EDITION_DIR}/
  ```
  Exit 1 (sem pares) → warn, pula, não bloqueia. Exit 0 → stdout lista pares `(destaque, ratio)` — `1x1` (hero 2:1 + crop, ou 1x1 nativo) e `4x5` (fonte do card + `04-d{N}-4x5.jpg`) combinados. Dispatchar UMA chamada `Agent("image-crop-reviewer", { edition: "{AAMMDD}", pairs, out_path: "{EDITION_DIR}/_internal/04-crop-review.json" })` com o array `pairs` COMPLETO; depois persistir:
  ```bash
  npx tsx scripts/run-image-crop-reviewer.ts --edition-dir {EDITION_DIR}/ --input-json {EDITION_DIR}/_internal/04-crop-review.json
  ```
  Sempre exit 0 (warning-only). Reaparece no gate da Etapa 4 via `check-invariants.ts --stage 4` (`image-crop-warn`) — nunca gate-blocking.
- **Leaderboard top1 (#1160/#1753 — só 1ª edição do mês, período ANTERIOR).**
  ```bash
  npx tsx scripts/fetch-leaderboard-top1.ts --edition {AAMMDD} --out {EDITION_DIR}/_internal/04-leaderboard-top1.json
  ```
  Falha (Worker offline/timeout) grava `top1: []`; renderer omite. Não-bloqueante.
- **Box campeões/sorteio (#2725).** Logo após o fetch acima (mesmo gate "1ª edição do mês"):
  ```bash
  npx tsx scripts/inject-champions-callout.ts --edition {AAMMDD} --edition-dir {EDITION_DIR}/
  ```
  **Graceful/no-op**: não é 1ª edição do mês, pódio incompleto, `raffle` ausente, ou `02-reviewed.md` já tem callout de intro (ex: patrocínio manual — o existente vence, evita corromper `extractIntroCallout` #2727; reportar ao editor se isso ocorrer) → sai 0 sem alterar nada. **NÃO-graceful, exit 1 (#4583):** `raffle.sorteio_do_mes.mes` presente mas divergente do mês da edição (dia herdado do mês anterior) é FATAL — tratar como parada inesperada (CLAUDE.md "MCP indisponível = fail-fast"): halt banner pedindo ao editor o dia do sorteio deste mês, atualizar `platform.config.json` → `raffle.sorteio_do_mes` `{ "mes": "{YYYY-MM}", "dia": N }`, re-rodar.
- **Pre-gate invariants (#1007 Fase 1).** Imagens obrigatórias (eia A/B + d1/d2 2x1/1x1; d3 condicional a `destaque_count === 3`, #2352) + prompts sem violação editorial:
  ```bash
  npx tsx scripts/check-invariants.ts --stage 3 --edition-dir {EDITION_DIR}/
  ```
  Exit 1 = bloquear gate até fix; violations apontam destaque/arquivo.
- **GATE HUMANO (É IA? + imagens):** mostrar paths do É IA? + imagens geradas (`04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-2x1.jpg`, `04-d2-1x1.jpg`; incluir `04-d3-2x1.jpg`/`04-d3-1x1.jpg` **somente se `destaque_count === 3`**). Todos os destaques têm hero 2:1 (#2133/#2141). Opções: aprovar / regenerar individual (`d{N}`).
- **Escrever sentinel de conclusão do Stage 3 (após aprovação do gate):**
  ```bash
  # destaque_count=3:
  npx tsx scripts/pipeline-sentinel.ts write \
    --edition {AAMMDD} --step 3 \
    --outputs "01-eia.md,04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-2x1.jpg,04-d2-1x1.jpg,04-d3-2x1.jpg,04-d3-1x1.jpg"
  # destaque_count=2:
  npx tsx scripts/pipeline-sentinel.ts write \
    --edition {AAMMDD} --step 3 \
    --outputs "01-eia.md,04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-2x1.jpg,04-d2-1x1.jpg"
  ```
  Falha do sentinel → logar warn (`log-event.ts --stage 3 --level warn --message 'sentinel_write_failed'`). Não bloquear.
- **Atualizar `stage-status.md` (#1217).** `update-stage-status.ts --stage 3 --status done --end ISO --duration-ms X`, depois `capture-stage-usage.ts --edition-dir {EDITION_DIR}/ --stage 3` (#3441 — só custo do lado Claude; Gemini/ComfyUI ficam fora do transcript, gap documentado, não fabricado como zero). `"source":"unavailable"` no stdout → logar warn `stage_usage_capture_unavailable` (#5475). Não bloquear.
