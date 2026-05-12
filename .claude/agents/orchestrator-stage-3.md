---
name: orchestrator-stage-3
description: Detalhe da Etapa 3 (imagens — É IA? coleta + destaques) do orchestrator Diar.ia. Lido pelo orchestrator principal durante a execução — não é um subagente invocável diretamente.
---

> Este arquivo é referenciado por `orchestrator.md` via `@see`. Não executar diretamente.

---

## Etapa 3 — Imagens

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

**MCP disconnect logging (#759):** Quando detectar `<system-reminder>` de MCP disconnect (Clarice, Beehiiv, Gmail, Chrome, etc.), logar: `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 3 --agent orchestrator --level warn --message "mcp_disconnect: {server}" --details '{"server":"{server}","kind":"mcp_disconnect"}'`. Ao reconectar: mesmo comando com `--level info --message "mcp_reconnect: {server}"`. Persiste em `data/run-log.jsonl` para `collect-edition-signals.ts` (#759). **Sempre acompanhar** com halt banner pra alertar o editor: `npx tsx scripts/render-halt-banner.ts --stage "3 — Imagens" --reason "{erro específico — mcp__{server} desconectado, ou falha na API de imagem (Gemini/ComfyUI)}" --action "reconecte e responda 'retry', ou 'abort' para abortar"` (#737).
**Timestamps (#716):** Timestamps apresentados ao editor usam BRT (America/Sao_Paulo, UTC-3) — formato `HH:MM (BRT)`. ISO UTC apenas em logs/JSON internos.

### 3a. É IA? (coleta do background dispatch — gate absorvido pela Etapa 1, #371, #1111)

O `scripts/eia-compose.ts` foi disparado em background bash durante a Etapa 1 (#1111). O bloco É IA? já foi embutido em `01-categorized.md` para revisão integrada no gate da Etapa 1. Aqui apenas garantimos que o resultado está disponível antes de gerar as imagens de destaque.

Detecção de conclusão por **file-presence check** (mais robusto que pollar bash status):

- **Se `data/editions/{AAMMDD}/01-eia.md` existe:** script terminou. Continuar.
- **Se ainda não existe:** aguardar até 10 minutos a partir de `eia_dispatch_ts`, pollando a cada ~10s via `existsSync`. Se expirar sem conclusão, reportar: `"⚠️ eia-compose não completou em 10min. Opções: (r) retry — re-disparar Bash; (s) skip — pular È IA? e continuar (será necessário adicionar manualmente antes do Stage 4)."` Em retry: re-disparar `npx tsx scripts/eia-compose.ts --edition {AAMMDD} --out-dir data/editions/{AAMMDD}/ --force` e aguardar mais 10min. Em skip: logar warn `eia_compose_timeout`, definir `eia_available = false`, continuar para 3b.
- Se eia-compose falhou (exit code != 0), logar erro + reportar. Oferecer retry com `--force`. Após retry bem-sucedido, re-renderizar `01-categorized.md` se ainda não tiver passado pelo gate da Etapa 1.
- **Sync push das imagens do É IA? para o Drive:**
  ```bash
  npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD}/ --stage 3 --files 01-eia-A.jpg,01-eia-B.jpg
  ```
  Anotar em `sync_results[3]` (eia); ignorar falhas. (Edições antigas têm `01-eia-real.jpg`/`01-eia-ia.jpg`; ajustar manualmente em retry de pré-#192.)
  **Nota (#582):** `01-eia.md` **não vai pro Drive** — conteúdo já em `01-categorized.md` (#371) e `eia_answer` propagado pra `02-reviewed.md` frontmatter (#744).
- **Sem gate separado (#371).** O editor já aprovou (ou verá) o É IA? no gate integrado da Etapa 1. Se o eia-composer completou com sucesso, prosseguir diretamente para 3b. Se `rejections[]` no output do composer não estiver vazio, informar: `"É IA?: pulei N dia(s) — motivos: vertical (X), já usada em edição anterior (Y). Imagem escolhida é de {image_date_used}."` — contexto para o editor, sem bloquear o pipeline.
- **Opção de retry do É IA?:** se o editor precisar regenerar o É IA? isoladamente (ex: imagem insatisfatória), usar `/diaria-3-imagens {AAMMDD} eia` — o sub-skill tem gate próprio de aprovação para esse caso.
- **Atualizar `_internal/cost.md`.** Append linha da É IA?, recalcular `Total de chamadas`, gravar:
  ```
  | 3a | {eia_dispatch_ts} | {now} | eia_composer:1, drive_syncer:1 | 2 | 0 |
  ```

### 3b. Imagens de destaque

- Logar início:
  ```bash
  npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 3 --agent orchestrator --level info --message 'etapa 3 imagens started'
  ```
- **Sync pull antes de começar** — prompts de imagem derivam dos destaques escritos na Etapa 2:
  ```bash
  npx tsx scripts/drive-sync.ts --mode pull --edition-dir data/editions/{AAMMDD}/ --stage 3 --files _internal/02-d1-prompt.md,_internal/02-d2-prompt.md,_internal/02-d3-prompt.md
  ```
- Se `platform.config.json > image_generator` é `"comfyui"`, verificar que ComfyUI está acessível:
  ```bash
  Bash("curl -sf http://127.0.0.1:8188/system_stats > /dev/null")
  ```
  Se falhar, pausar e instruir o usuário a iniciar o ComfyUI.
- **Lint pre-flight do prompt (#810).** Para cada destaque d1, d2, d3, rodar lint determinístico antes de gastar API call. Detecta violações da regra editorial (`context/editorial-rules.md`): "Noite Estrelada" / "Starry Night", resolução em pixels, DPI:
  ```bash
  npx tsx scripts/lint-image-prompt.ts data/editions/{AAMMDD}/_internal/02-d{N}-prompt.md
  ```
  Se exit `1` (violações encontradas), pausar geração desse destaque e mostrar ao editor as violações (stderr lista trechos + categoria + regra). Editor pode editar `_internal/02-d{N}-prompt.md` no Drive ou local e responder "retry". Não chamar `image-generate.ts` antes do lint passar — defesa em profundidade vs `NEGATIVE_PROMPT` parcial do `image-generate`.
- **Gerar imagens via script (sem Agent).** Para cada destaque d1, d2, d3 sequencialmente (Gemini API por default), DEPOIS do lint passar:
  ```bash
  npx tsx scripts/image-generate.ts \
    --editorial data/editions/{AAMMDD}/_internal/02-d{N}-prompt.md \
    --out-dir data/editions/{AAMMDD}/ \
    --destaque d{N}
  ```
  Se o script sair com código ≠ 0, logar erro com o stderr e reportar ao usuário — não continuar para o próximo destaque.
- **Sync push antes do gate:**
  ```bash
  npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD}/ --stage 3 --files 04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-1x1.jpg,04-d3-1x1.jpg,_internal/02-d1-prompt.md,_internal/02-d2-prompt.md,_internal/02-d3-prompt.md
  ```
  Anotar em `sync_results[3]`; ignorar falhas.
- **Pre-gate invariants (#1007 Fase 1).** Validar que as 6 imagens existem e prompts não violam regras editoriais (sem pixels, sem Noite Estrelada):
  ```bash
  npx tsx scripts/check-invariants.ts --stage 3 --edition-dir data/editions/{AAMMDD}/
  ```
  Exit 1 = bloquear gate até fix (regenerar imagem ausente / corrigir prompt). Violations explicam qual destaque/arquivo precisa atenção.
- **GATE HUMANO (É IA? + imagens):** mostrar paths do É IA? + 4 paths de imagem gerados (`04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg`, `04-d3-1x1.jpg`). Mencionar: "Imagens full-size disponíveis no Drive em `Work/Startups/diar.ia/edicoes/{YYMM}/{AAMMDD}/`." Opções: aprovar / regenerar individual (re-rodar o script só para `d{N}` e re-disparar o push).
- **Escrever sentinel de conclusão do Stage 3 (após aprovação do gate):**
  ```bash
  npx tsx scripts/pipeline-sentinel.ts write \
    --edition {AAMMDD} --step 3 \
    --outputs "01-eia.md,04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-1x1.jpg,04-d3-1x1.jpg"
  ```
  Falha do sentinel → logar warn (`npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 3 --agent orchestrator --level warn --message 'sentinel_write_failed'`). Não bloquear.
- **Atualizar `_internal/cost.md`.** Append linha da Etapa 3, atualizar `Fim` e `Total de chamadas`, gravar:
  ```
  | 3b | {stage_start} | {now} | drive_syncer:1 | 1 | 0 |
  ```
  Atualizar `Fim: {now}` no cabeçalho.
