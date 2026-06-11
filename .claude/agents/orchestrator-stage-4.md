---
name: orchestrator-stage-4
description: Detalhe da Etapa 4 (revisão editorial assistida — resumo consolidado + gate humano pré-publicação) do orchestrator Diar.ia. Lido pelo orchestrator principal durante a execução — não é um subagente invocável diretamente.
---

> Este arquivo é referenciado por `orchestrator.md` via `@see`. Não executar diretamente.

---

## Etapa 4 — Revisão editorial assistida (#1694)

Antes de publicar, o orchestrator monta um **resumo consolidado da edição final** e apresenta ao editor num gate humano explícito. Aprovado → segue para Etapa 5 (Publicação). O pre-render técnico (HTML + imagens + upload + close-poll, o antigo §4a-pre-gate) ocorre neste stage, tornando a revisão visual e completa.

**`--no-gates` behavior:** quando `auto_approve = true` (via `--no-gates`), o orchestrator executa o pré-render completo e pula **apenas o gate humano** — o resumo é gerado mas não apresentado. Prossegue automaticamente para Etapa 5.

### Pré-condição: sentinel Stage 3

<!-- outputs must match the `write` call at the end of orchestrator-stage-3.md §Escrever sentinel de conclusão do Stage 3 -->
```bash
npx tsx scripts/pipeline-sentinel.ts assert \
  --edition {AAMMDD} --step 3 \
  --outputs "01-eia.md,04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-1x1.jpg,04-d3-1x1.jpg"
```

Exit code handling:
- `0` → continuar.
- `1` → **FATAL:** "Etapa 3 não completou (sentinel ausente). Re-rodar `/diaria-3-imagens {AAMMDD}` antes de continuar." Parar.
- `2` → **FATAL:** "Outputs do Stage 3 ausentes. Re-rodar Etapa 3." Parar.
- `3` → logar warn (`npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator --level warn --message "stage3_sentinel_missing_legacy"`), continuar.

### 4a. Pré-requisitos + sync

**Marcar Stage 4 `running` no início (#1783).** Garante o `start` pra que o `done` do §4i feche a duração no relatório. Sem `--start` — auto-carimbo (#1789) preserva o original em resume:
```bash
npx tsx scripts/update-stage-status.ts --edition-dir data/editions/{AAMMDD}/ --stage 4 --status running
```

**⚠️ MCP fail-fast (#738):** Durante qualquer passo desta etapa, se um `<system-reminder>` do runtime indicar que um MCP ficou offline, **parar imediatamente**, logar via:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator \
  --level warn --message "mcp_disconnect: {server_name}" \
  --details '{"server":"{server_name}","kind":"mcp_disconnect"}'
```
E renderizar halt banner pra alertar o editor (#737):
```bash
npx tsx scripts/render-halt-banner.ts \
  --stage "4 — Revisão" \
  --reason "mcp__{server_name} desconectado" \
  --action "responda 'retry' para continuar ou 'abort' para encerrar Etapa 4"
```
**Timestamps (#716):** Timestamps apresentados ao editor usam BRT (America/Sao_Paulo, UTC-3) — formato `HH:MM (BRT)`. ISO UTC apenas em logs/JSON internos.

- Logar início:
  ```bash
  npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator --level info --message 'etapa 4 revisao started'
  ```
- **Sync pull antes de começar** (todos os arquivos que entram na revisão + pre-render):
  ```bash
  npx tsx scripts/drive-sync.ts --mode pull --edition-dir data/editions/{AAMMDD}/ --stage 4 --files 02-reviewed.md,01-eia-A.jpg,01-eia-B.jpg,03-social.md,04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-1x1.jpg,04-d3-1x1.jpg
  ```
  Editor pode ter refinado texto/imagens no Drive.

### 4b. Pré-render técnico

**Pré-render completo sempre roda** (independente de `auto_approve`) — garante que `newsletter-final.html` e previews estejam prontos pra revisão e pra publicação. Com `--no-gates` o gate é pulado, mas o pré-render nunca é.

0. **capture-livros-promo — ANTES do upload (#2071).** Re-captura o screenshot da página de livros se o conteúdo mudou (md5 diferente):
   ```bash
   npx tsx scripts/capture-livros-promo.ts --edition-dir data/editions/{AAMMDD}/
   ```
   Exit code handling: `0` = imagem nova em `04-livros-promo.jpg`; `2` = md5 igual, nada a fazer; `1` = falha — logar warn + continuar (asset opcional).

1. **upload-images-public — TODOS modos** (cobre pre-render completo):
   ```bash
   npx tsx scripts/upload-images-public.ts --edition-dir data/editions/{AAMMDD}/ --mode newsletter
   npx tsx scripts/upload-images-public.ts --edition-dir data/editions/{AAMMDD}/ --mode social
   ```

2. Pre-render do newsletter HTML — seguir steps 1-5 do `context/publishers/beehiiv-playbook.md` **sem** o Chrome MCP / Beehiiv interaction. Output: `_internal/newsletter-final.html` + URL no draft worker. **Capturar a `url` do JSON stdout de `upload-html-public.ts`** — Worker usa key `html:{AAMMDD}-{contentHash}` (#1494, hash dos primeiros 6 chars de md5 do HTML). Sem o hash, fetch retorna 404 (review #1612 regression).

3. Pre-render do social preview HTML:
   ```bash
   # #1800: --images é OBRIGATÓRIO — sem ele o preview sai sem imagens.
   npx tsx scripts/render-social-html.ts --md data/editions/{AAMMDD}/03-social.md --out data/editions/{AAMMDD}/_internal/social-preview.html --images data/editions/{AAMMDD}/06-public-images.json
   # #1734: --persist-to grava a URL durável (com hash) em 05-social-preview.json.
   npx tsx scripts/upload-html-public.ts --edition {AAMMDD}-social --html data/editions/{AAMMDD}/_internal/social-preview.html --persist-to data/editions/{AAMMDD}/_internal/05-social-preview.json --field social_preview_url
   ```

4. close-poll (set gabarito — idempotente):
   ```bash
   npx tsx scripts/close-poll.ts --edition {AAMMDD}
   ```

5. **Pre-dispatch invariants (#1007 Fase 1).** Validar que `06-public-images.json` está populado e env vars críticas estão setadas:
   ```bash
   npx tsx scripts/check-invariants.ts --stage 4 --edition-dir data/editions/{AAMMDD}/
   ```
   Exit 1 = pausar com violations no stderr. Editor corrige e re-roda.

### 4c. Montar resumo consolidado da edição

Coletar e organizar todas as informações da edição final para apresentar ao editor. **Reusar os validate-*/lint-* existentes** para gerar o relatório — nada novo aqui, apenas consolidação.

**4c.1 — Destaques + títulos + links:**
- Ler `_internal/01-approved.json` para os destaques aprovados (D1, D2, D3) com `url`, `category`, `score`.
- Ler `02-reviewed.md` para extrair os títulos escolhidos (1 por destaque após poda) e os URLs no corpo final.
- Verificar acessibilidade dos 3 URLs principais (simples HEAD request, ~3s):
  ```bash
  npx tsx scripts/verify-accessibility.ts --urls "{url1},{url2},{url3}" --out /dev/null
  ```
  Capturar `verify_verdict` (accessible/inaccessible/timeout) para cada URL. Inacessível = mostrar ⚠️ no resumo mas não bloquear.

**4c.2 — Lints consolidados:**
```bash
npx tsx scripts/validate-lancamentos.ts --edition-dir data/editions/{AAMMDD}/
npx tsx scripts/lint-newsletter-md.ts --check all --file data/editions/{AAMMDD}/02-reviewed.md
```
Capturar violations. Críticas (P1) = mostrar ❌ no resumo com ação sugerida.

**4c.3 — Imagens geradas:**
- Listar `04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg`, `04-d3-1x1.jpg` com tamanhos (bytes).
- URL pública no Worker KV: `{newsletter_url}` (capturada em §4b step 2).

**4c.4 — Social preview:**
- Social preview URL: `{social_url}` (de `_internal/05-social-preview.json`).
- Ler `03-social.md` para exibir os títulos dos 6 posts (3 LinkedIn + 3 Facebook) em tabela.

**4c.5 — Diffs vs fonte (#1694 — novo no Stage 4):**
- Comparar os títulos finais em `02-reviewed.md` com os títulos originais em `_internal/01-approved.json` para mostrar se houve mudança editorial.
- Informativo — sem bloqueio.

### 4d. Gate humano (#1694)

**Sync push antes do gate (#507):** Subir outputs pra o editor revisar no Drive antes de aprovar:
```bash
npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD}/ --stage 4 --files 02-reviewed.md,03-social.md,04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-1x1.jpg,04-d3-1x1.jpg,01-eia-A.jpg,01-eia-B.jpg
```

**GATE HUMANO — RESUMO CONSOLIDADO (#1694):**

Apresentar ao editor numa visualização limpa:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 REVISÃO EDITORIAL — Edição {AAMMDD}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📰 Newsletter HTML:   {newsletter_url}
📱 Social preview:   {social_url}
📁 Drive:            Work/Startups/diar.ia/edicoes/{YYMM}/{AAMMDD}/

━━━ DESTAQUES ━━━━━━━━━━━━━━━━━━━━━━

D1  "{título_d1}"  [{verify_verdict_d1}]
    {url_d1}

D2  "{título_d2}"  [{verify_verdict_d2}]
    {url_d2}

D3  "{título_d3}"  [{verify_verdict_d3}]
    {url_d3}

━━━ SOCIAL (6 posts) ━━━━━━━━━━━━━━━━

LinkedIn  D1  "{hook_d1_linkedin}"
LinkedIn  D2  "{hook_d2_linkedin}"
LinkedIn  D3  "{hook_d3_linkedin}"
Facebook  D1  "{hook_d1_facebook}"
Facebook  D2  "{hook_d2_facebook}"
Facebook  D3  "{hook_d3_facebook}"

━━━ IMAGENS ━━━━━━━━━━━━━━━━━━━━━━━━

✓ D1 cover 2:1    04-d1-2x1.jpg ({size_kb} KB)
✓ D1 inline 1:1   04-d1-1x1.jpg ({size_kb} KB)
✓ D2 inline 1:1   04-d2-1x1.jpg ({size_kb} KB)
✓ D3 inline 1:1   04-d3-1x1.jpg ({size_kb} KB)
✓ É IA? A         01-eia-A.jpg
✓ É IA? B         01-eia-B.jpg

━━━ LINTS ━━━━━━━━━━━━━━━━━━━━━━━━━━

{violations_block ou "✅ Nenhuma violação detectada"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Aprovar e prosseguir para Publicação (Etapa 5)?

  sim     → segue para /diaria-5-publicar (dispatch automático)
  editar  → halt; editor edita no Drive → responde "sim" quando pronto
  abortar → encerra sem publicar (sentinel não escrito)
  Qualquer outra resposta → repetir prompt (fail-closed)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Regras de apresentação:
- `{verify_verdict}` = `✅ acessível` / `⚠️ inacessível` / `⏱ timeout`.
- `{violations_block}` = uma linha por violation com ❌ (crítico) ou ⚠️ (warning) + mensagem.
- Títulos dos posts sociais: primeira linha não-vazia de cada post no `03-social.md` (o "hook").
- Se pré-render falhou em algum passo (newsletter HTML, social HTML), indicar `⚠️ preview indisponível` com motivo.

Logar a resposta:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator --level info \
  --message "gate revisao response: {sim|editar|abortar}"
```

**"editar":** rodar `update-stage-status --stage 4 --status pending` + halt banner. NÃO escrever sentinel. Editor edita e re-roda.

**"abortar":** logar warn `"gate_revisao_abortado"`, encerrar sem sentinel.

### 4e. Escrever sentinel de conclusão (#978, adaptado de #1694)

**Após aprovação do gate** (ou imediatamente em `auto_approve = true` após §4b):

```bash
npx tsx scripts/pipeline-sentinel.ts write \
  --edition {AAMMDD} --step 4 \
  --outputs "02-reviewed.md,03-social.md"
```

**Marcar Stage 4 `done` AQUI (#1783):**
```bash
npx tsx scripts/update-stage-status.ts --edition-dir data/editions/{AAMMDD}/ --stage 4 --status done
```

- Falha do sentinel → logar warn. Não bloquear.
- O sentinel de Stage 4 garante que resume-aware (Stage 0b) detecta que a Revisão completou e pula direto para a Etapa 5.

---

## Fluxo pós-gate

Após aprovação do gate (ou auto-approve com `--no-gates`), o orchestrator prossegue imediatamente para a **Etapa 5 — Publicação** (leia `orchestrator-stage-5.md`).

O pré-render do Stage 4 já populou todos os artefatos que o Stage 5 precisa:
- `_internal/newsletter-final.html` (HTML pronto)
- `_internal/05-social-preview.json` (URL do preview social)
- `06-public-images.json` (URLs públicas das imagens)
- `_internal/.close-poll-done.json` (gabarito setado)

O Stage 5 **não repete** pré-render — vai direto para o dispatch.
