---
name: orchestrator-stage-3
description: Detalhe da Etapa 3 (imagens — É IA? coleta + destaques) do orchestrator Diar.ia. Lido pelo orchestrator principal durante a execução — não é um subagente invocável diretamente.
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

### 3a. É IA? (coleta do background dispatch — gate absorvido pela Etapa 1, #371, #1111)

O `scripts/eia-compose.ts` foi disparado em background bash durante a Etapa 1 (#1111). O bloco É IA? já foi embutido em `01-categorized.md` para revisão integrada no gate da Etapa 1. Aqui apenas garantimos que o resultado está disponível antes de gerar as imagens de destaque.

Detecção de conclusão por **file-presence check** (mais robusto que pollar bash status):

- **Se `{EDITION_DIR}/01-eia.md` existe:** script terminou. Continuar.
- **Se ainda não existe:** aguardar até 10 minutos a partir de `eia_dispatch_ts`, pollando a cada ~10s via `existsSync`. Se expirar sem conclusão, reportar: `"⚠️ eia-compose não completou em 10min. Opções: (r) retry — re-disparar Bash; (s) skip — pular È IA? e continuar (será necessário adicionar manualmente antes do Stage 4)."` Em retry: re-disparar `npx tsx scripts/eia-compose.ts --edition {AAMMDD} --out-dir {EDITION_DIR}/ --force` e aguardar mais 10min. Em skip: logar warn `eia_compose_timeout`, definir `eia_available = false`, continuar para 3b.
- Se eia-compose falhou (exit code != 0), logar erro + reportar. Oferecer retry com `--force`. Após retry bem-sucedido, re-renderizar `01-categorized.md` se ainda não tiver passado pelo gate da Etapa 1. (Edições antigas têm `01-eia-real.jpg`/`01-eia-ia.jpg`; ajustar manualmente em retry de pré-#192.)
- **Sem gate separado (#371).** O editor já aprovou (ou verá) o É IA? no gate integrado da Etapa 1. Se o eia-composer completou com sucesso, prosseguir diretamente para 3b. Se `rejections[]` no output do composer não estiver vazio, informar: `"É IA?: pulei N dia(s) — motivos: vertical (X), já usada em edição anterior (Y). Imagem escolhida é de {image_date_used}."` — contexto para o editor, sem bloquear o pipeline.
- **Opção de retry do É IA?:** se o editor precisar regenerar o É IA? isoladamente (ex: imagem insatisfatória), usar `/diaria-3-imagens {AAMMDD} eia` — o sub-skill tem gate próprio de aprovação para esse caso.
- **Sub-stage 3a (É IA?) tracking** (#1217 — removed cost.md). É IA? roda em background bash e termina sem chamada explícita de update-stage-status — orchestrator pode opcionalmente registrar conclusão via `--cost-usd 0 --tokens-in 0` se quiser explicitar gratuitidade do passo (Gemini API key).

### 3b. Imagens de destaque

- Logar início:
  ```bash
  npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 3 --agent orchestrator --level info --message 'etapa 3 imagens started'
  ```
- Prompts de imagem derivam dos destaques escritos na Etapa 2. Ler `destaque_count` de `_internal/01-approved-capped.json` (campo `highlights.length`; default 3 se ausente). Considerar `_internal/02-d3-prompt.md` **somente se `destaque_count === 3`**.
- Se `platform.config.json > image_generator` é `"comfyui"`, verificar que ComfyUI está acessível:
  ```bash
  Bash("curl -sf http://127.0.0.1:8188/system_stats > /dev/null")
  ```
  Se falhar, pausar e instruir o usuário a iniciar o ComfyUI.
- **Lint pre-flight do prompt (#810).** Para cada destaque presente (d1, d2 — e d3 **somente se `destaque_count === 3`**), rodar lint determinístico antes de gastar API call. Detecta violações da regra editorial (`context/editorial-rules.md`): "Noite Estrelada" / "Starry Night", resolução em pixels, DPI:
  ```bash
  npx tsx scripts/lint-image-prompt.ts {EDITION_DIR}/_internal/02-d{N}-prompt.md
  ```
  Se exit `1` (violações encontradas), pausar geração desse destaque e mostrar ao editor as violações (stderr lista trechos + categoria + regra). Editor pode editar `_internal/02-d{N}-prompt.md` localmente e responder "retry". Não chamar `image-generate.ts` antes do lint passar — defesa em profundidade vs `NEGATIVE_PROMPT` parcial do `image-generate`. **Exit `2` (I/O error — arquivo ausente):** tratar como erro fatal para aquele destaque e reportar ao editor (não confundir com exit `1` = violação de conteúdo).
- **Gerar imagens via script (sem Agent).** Para cada destaque presente (d1, d2 — e d3 **somente se `destaque_count === 3`**) sequencialmente (Gemini API por default), DEPOIS do lint passar:
  ```bash
  npx tsx scripts/image-generate.ts \
    --editorial {EDITION_DIR}/_internal/02-d{N}-prompt.md \
    --out-dir {EDITION_DIR}/ \
    --destaque d{N}
  ```
  **#2133/#2141:** D2 e D3 agora também geram `04-d{N}-2x1.jpg` (hero inline no email) + `04-d{N}-1x1.jpg` (social crop), igual ao D1. O default de ratio para d1/d2/d3 é 2x1.
  Se o script sair com código ≠ 0, logar erro com o stderr e reportar ao usuário — não continuar para o próximo destaque.

  **#1325: nunca regerar imagens existentes sem `--force` explícito.** Tanto `eia-compose.ts` quanto `image-generate.ts` já tem skip-if-exists (`exit 0` com `skipped: outputs exist`). `eia-compose` ganhou partial-state guard (#1325): se A existe e B falhou, **HALT** com exit 2 — não regenera silenciosamente. Editor responde `--force` se quiser regen do zero (vai picar nova POTD). Orchestrator NÃO deve passar `--force` automaticamente em retry — só se o editor pedir explicitamente.
- **Fetch leaderboard top1 (#1160 — rodapé do È IA?).** Antes do render no Stage 4, popular `_internal/04-leaderboard-top1.json`. **#1753:** o bloco só aparece na **1ª edição do mês** e anuncia o mês que acabou de fechar (período ANTERIOR ao da edição); em qualquer outra edição o script grava `top1: []` e o renderer omite. O gate é interno ao script (cruza com `data/past-editions-raw.json`) — o orchestrator só invoca normalmente. Renderer lê automaticamente:
  ```bash
  npx tsx scripts/fetch-leaderboard-top1.ts \
    --edition {AAMMDD} \
    --out {EDITION_DIR}/_internal/04-leaderboard-top1.json
  ```
  Falha do fetch (Worker offline, timeout) escreve `top1: []` — renderer detecta e omite bloco. **Não-bloqueante** — newsletter funciona sem leaderboard.
- **Injetar box campeões/sorteio de início de mês (#2725).** Logo após o fetch acima (mesmo gate "1ª edição do mês", reusado internamente — não duplica a detecção), preencher e injetar o box `🎉 Os campeões do É IA?... + Sorteio` em `02-reviewed.md` a partir do `podium` recém-escrito + do bloco `raffle` de `platform.config.json`:
  ```bash
  npx tsx scripts/inject-champions-callout.ts \
    --edition {AAMMDD} \
    --edition-dir {EDITION_DIR}/
  ```
  **Graceful/no-op** (mesmo padrão do fetch): não é a 1ª edição do mês, pódio vazio/incompleto, ou bloco `raffle` ausente → loga o motivo e sai 0 sem alterar `02-reviewed.md`. **Precedência:** se `02-reviewed.md` já tem um callout na região de intro (ex: patrocínio 📣 colado manualmente), a injeção é PULADA — o callout existente vence, evitando corromper o parse greedy de `extractIntroCallout` (#2727) com dois blocos empilhados. Se isso ocorrer, reportar ao editor no resumo do gate: "Box de campeões do mês não injetado — já havia um callout ({tipo}) no topo desta edição." Só roda quando `02-reviewed.md` já existe (Stage 2 completo) — nunca antes.
- **Pre-gate invariants (#1007 Fase 1).** Validar que as imagens obrigatórias existem (eia A/B + d1/d2 2x1/1x1; d3 2x1/1x1 **condicional a `destaque_count === 3`**, #2352) e prompts não violam regras editoriais (sem pixels, sem Noite Estrelada):
  ```bash
  npx tsx scripts/check-invariants.ts --stage 3 --edition-dir {EDITION_DIR}/
  ```
  Exit 1 = bloquear gate até fix (regenerar imagem ausente / corrigir prompt). Violations explicam qual destaque/arquivo precisa atenção. O script já é 2-destaque-aware (#2352) — não requer flag adicional.
- **GATE HUMANO (É IA? + imagens):** mostrar paths do É IA? + paths de imagem gerados (`04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-2x1.jpg`, `04-d2-1x1.jpg`; incluir `04-d3-2x1.jpg`, `04-d3-1x1.jpg` **somente se `destaque_count === 3`**). **#2133/#2141:** todos os destaques têm hero 2:1 no email. Opções: aprovar / regenerar individual (re-rodar o script só para `d{N}`).
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
  Falha do sentinel → logar warn (`npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 3 --agent orchestrator --level warn --message 'sentinel_write_failed'`). Não bloquear.
- **Atualizar `stage-status.md` (#1217 — removed cost.md).** Marcar stage 3 done via `update-stage-status.ts --stage 3 --status done --end ISO --duration-ms X`. Em seguida `npx tsx scripts/capture-stage-usage.ts --edition-dir {EDITION_DIR}/ --stage 3` (#3441) — captura tokens/custo REAIS só do lado Claude (transcript local da sessão); **não captura** o custo de Gemini/ComfyUI da geração de imagem (APIs externas, fora do transcript do harness) — esse gap fica documentado, não fabricado como zero.
