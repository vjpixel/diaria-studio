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

**#2316: 2-destaque editions** — antes de rodar o sentinel, verificar quantos destaques a edição tem:
```bash
npx tsx scripts/extract-destaques.ts data/editions/{AAMMDD}/02-reviewed.md 2>/dev/null | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(String(d.destaques.length))"
```
Se 2 destaques: usar `--outputs` sem `04-d3-*.jpg` (os arquivos D3 não existem). Se 3 destaques: comando padrão abaixo.

**3 destaques (padrão):**
```bash
npx tsx scripts/pipeline-sentinel.ts assert \
  --edition {AAMMDD} --step 3 \
  --outputs "01-eia.md,04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-2x1.jpg,04-d2-1x1.jpg,04-d3-2x1.jpg,04-d3-1x1.jpg"
```

**2 destaques:**
```bash
npx tsx scripts/pipeline-sentinel.ts assert \
  --edition {AAMMDD} --step 3 \
  --outputs "01-eia.md,04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-2x1.jpg,04-d2-1x1.jpg"
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

   **Exit codes de `substitute-image-urls.ts` (#2316, #2335):**

   | Exit | Significado | Ação |
   |------|-------------|------|
   | `0` | Sucesso | Continuar |
   | `1` | Erro de args (CLI) | Verificar comando; abortar |
   | `2` | Placeholders não resolvidas | Abortar — verificar `06-public-images.json` e fluxo de upload |
   | `3` | **HTML stale** — `newsletter-draft.html` mais antigo que `02-reviewed.md` | Re-rodar `render-newsletter-html.ts` primeiro, depois re-rodar `substitute-image-urls.ts`. **Não é fatal** — não tratar como falha de pipeline. |

   > **Exit 3 (#2316):** mensagem stderr: `[substitute-image-urls] ERRO: HTML de input está desatualizado`. Ação: re-renderizar e re-substituir. Ver beehiiv-playbook.md §1.3 para o exit-code table completo.

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

**4c.2b — Lint social + consistência post_pixel + sentinel humanizador (#2145, #2279):**
```bash
npx tsx scripts/lint-social-md.ts --check post_pixel-matches-d1 --md data/editions/{AAMMDD}/03-social.md
```
Compara tokens (Jaccard) do `## post_pixel` com o main de cada `## d{N}`. Falha quando post_pixel é claramente mais parecido com outro destaque que com o D1 vigente. Sinal de que houve reordenação pós-Stage-2 sem re-sincronizar o post pessoal. **Exit 1 = GATE-BLOCKING** (igual aos outros lints invariantes de §4c.2) — ❌ mostrar no resumo com ação: "post_pixel stale — re-sincronizar com D1 atual antes de aprovar". Gate só pode ser aprovado (`sim`) após lint verde (exit 0).

**Guard determinístico do humanizador social (#2279):**
```bash
npx tsx scripts/check-humanizer-social.ts --check --edition-dir data/editions/{AAMMDD}/
```
Exit code handling:
- `0` → humanizador rodou e `03-social.md` não foi editado depois. Continuar.
- `1` → **GATE-BLOCKING:** sentinel ausente — humanizador não rodou no social ou sentinel não foi gravado. Ação: re-rodar humanizador, depois `--write`, antes de aprovar.
- `2` → **GATE-BLOCKING:** `03-social.md` foi editado/reordenado após humanização (hash diverge — caso real: edição inline em §4d.1 ou reorder de destaques). **Re-humanizar antes de aprovar:**
  ```
  Skill("humanizador", "Leia data/editions/{AAMMDD}/03-social.md, humanize o texto removendo marcas de IA … Salve no mesmo arquivo.")
  ```
  Após humanização: (a) re-rodar lints do §2c que cobrem qualidade social:
  ```bash
  npx tsx scripts/lint-social-md.ts --check humanizer-section-coverage \
    --pre data/editions/{AAMMDD}/_internal/03-social-pre-humanizador.md \
    --md data/editions/{AAMMDD}/03-social.md
  npx tsx scripts/lint-social-md.ts --check relative-time --md data/editions/{AAMMDD}/03-social.md
  npx tsx scripts/lint-social-md.ts --check linkedin-schema --md data/editions/{AAMMDD}/03-social.md
  ```
  (b) gravar sentinel: `npx tsx scripts/check-humanizer-social.ts --write --edition-dir data/editions/{AAMMDD}/`
  (c) re-rodar o check; só prosseguir quando exit 0.

**4c.3 — Imagens geradas:**
- Listar `04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg`, `04-d3-1x1.jpg` com tamanhos (bytes).
- URL pública no Worker KV: `{newsletter_url}` (capturada em §4b step 2).

**4c.4 — Social preview:**
- Social preview URL: `{social_url}` (de `_internal/05-social-preview.json`).
- Ler `03-social.md` para exibir os títulos dos 6 posts (3 LinkedIn + 3 Facebook) em tabela.

**4c.5 — Diffs vs fonte (#1694 — novo no Stage 4):**
- Comparar os títulos finais em `02-reviewed.md` com os títulos originais em `_internal/01-approved.json` para mostrar se houve mudança editorial.
- Informativo — sem bloqueio.

**4c.6 — Fact-check de claims (#2455):**

Disparar o subagente `fact-checker` em paralelo com (ou logo após) os lints acima:

```bash
# 1. Validar pré-condições e obter parâmetros para o subagente:
npx tsx scripts/run-fact-checker.ts --edition-dir data/editions/{AAMMDD}/
```

Em seguida, despachar o subagente `fact-checker` via Agent tool com os parâmetros:
```
Agent("fact-checker", {
  newsletter_path: "data/editions/{AAMMDD}/02-reviewed.md",
  social_path: "data/editions/{AAMMDD}/03-social.md",
  approved_json_path: "data/editions/{AAMMDD}/_internal/01-approved.json",
  out_path: "data/editions/{AAMMDD}/_internal/fact-check.json"
})
```

Após o subagente concluir (gravar `_internal/fact-check.json`), formatar o gate summary:
```bash
# 2. Formatar seção para o gate (lê o fact-check.json gravado pelo subagente):
npx tsx scripts/run-fact-checker.ts --edition-dir data/editions/{AAMMDD}/ \
  --input-json data/editions/{AAMMDD}/_internal/fact-check.json
```

**Exit code handling:**
- `0` → capturar stdout (seção formatada) e incluir na seção `━━━ FACT-CHECK` do gate.
- `1` → fact-checker não rodou (pré-condição falhou ou arquivo ausente) → mostrar `⚠️ Fact-check indisponível: {motivo do stderr}` no gate. **Não bloquear** — fact-check é assistido, não gate-blocking.

**Comportamento em `auto_approve = true` (`--no-gates`):** executar normalmente (grava `_internal/fact-check.json`), mas pular a apresentação no gate (que é pulado inteiramente). O arquivo fica disponível para auditoria pós-edição.

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

{fact_check_block}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Aprovar e prosseguir para Publicação (Etapa 5)?

  sim     → segue para /diaria-5-publicacao (dispatch automático)
  editar  → halt; editor edita no Drive → pull → responde "sim" quando pronto
  ajustar → editor dita a mudança no chat; orchestrator aplica e re-apresenta o resumo
  abortar → encerra sem publicar (sentinel não escrito)
  Qualquer outra resposta → repetir prompt (fail-closed)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Regras de apresentação:
- `{verify_verdict}` = `✅ acessível` / `⚠️ inacessível` / `⏱ timeout`.
- `{violations_block}` = uma linha por violation com ❌ (crítico) ou ⚠️ (warning) + mensagem.
- `{fact_check_block}` = saída do `formatGateSummary` de `scripts/run-fact-checker.ts --input-json` (§4c.6). Se fact-checker falhou ou `fact-check.json` não existe: `⚠️ Fact-check indisponível — verificar manualmente antes de publicar.` **Nunca bloquear o gate por ausência do fact-check.** Decisão final é sempre do editor.
- Títulos dos posts sociais: primeira linha não-vazia de cada post no `03-social.md` (o "hook").
- Se pré-render falhou em algum passo (newsletter HTML, social HTML), indicar `⚠️ preview indisponível` com motivo.

Logar a resposta:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator --level info \
  --message "gate revisao response: {sim|editar|ajustar|abortar}"
```

**"editar":** rodar `update-stage-status --stage 4 --status pending` + halt banner. NÃO escrever sentinel. Editor edita no Drive e re-roda quando pronto. Adequado para revisões longas ou fora do terminal.

**"ajustar":** ver §4d.1 abaixo — edição inline no chat, orchestrator aplica e volta ao gate. Adequado para tweaks rápidos.

**"abortar":** logar warn `"gate_revisao_abortado"`, encerrar sem sentinel.

### 4d.1 — Edição inline ("ajustar") (#1694)

O editor dita a mudança em linguagem natural (ex: "muda o título do D2 para X", "tira o link do D3", "troca lança por apresenta no corpo do D1").

**Fluxo:**

1. **Pull antes de editar** (#494): `drive-sync --mode pull --stage 4 --files 02-reviewed.md` (e `03-social.md` se a mudança afetar social).
2. **Aplicar edição cirúrgica** em `02-reviewed.md` seguindo #495: substituições linha-a-linha mínimas via `Edit` com `old_string` mínimo. Nunca substituir blocos grandes.
3. **Cascata de título (crítico):** se a mudança alterar um TÍTULO de destaque:
   - O orchestrator **avisa** o editor: "Essa mudança afeta a imagem e os posts sociais do D{N} — vou re-gerar os passos afetados."
   - Re-rodar: re-render do HTML (§4b steps 1-3), regenerar imagem do destaque (`scripts/image-generate.ts --edition {AAMMDD} --highlight d{N}`), e regenerar post social do D{N} (`social-linkedin` / `social-facebook` para aquele destaque).
   - Edição de **corpo ou link** (sem mudar título) não cascateia — só re-render do HTML basta.

4. **Reordenação/swap de destaques (#2145 — post_pixel stale):** se a mudança reordenar os destaques (ex: troca D1↔D3) ou trocar qual destaque ocupa a posição D1:
   - O `## post_pixel` foi gerado sobre o D1 **original** (Stage 2) e **não é remapeado automaticamente** junto com os blocos `## d{N}`.
   - O orchestrator **avisa** o editor imediatamente: "Reordenação detectada — o `## post_pixel` pode estar referenciando o D1 antigo. Re-verificar e re-sincronizar antes de aprovar."
   - Re-rodar lint: `npx tsx scripts/lint-social-md.ts --check post_pixel-matches-d1 --md data/editions/{AAMMDD}/03-social.md`.
   - Se falhar (exit 1): o post_pixel precisa ser atualizado manualmente — reescrever o bloco `## post_pixel` em `03-social.md` para refletir o D1 atual, depois re-rodar o lint até exit 0. **Não há modo de re-dispatch parcial** — o `social-linkedin` não aceita `--only post_pixel` e um re-dispatch completo clobberia os posts de d1/d2/d3 já aprovados. Edição manual do bloco é a única via segura.
   - Lint verde (exit 0) = post_pixel já alinhado com o D1 atual → sem bloqueio.

5. **Logar:**
   ```bash
   npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator --level info \
     --message "gate revisao: ajustar inline aplicado ({descrição curta})"
   ```

6. **Re-humanizar e gravar sentinel se `03-social.md` foi tocado (#2279/#2290/#2373):** qualquer ajuste que altere `03-social.md` (reorder de destaques, edição de post social inline) OBRIGATORIAMENTE:
   1. **Rodar o humanizador** em `03-social.md` (passagem completa via Skill humanizador).
   2. **Rodar `mcp__clarice__correct_text`** no `## post_pixel` (revisão ortográfica).
   3. **Só então gravar o sentinel** com `--bypass-reason` descritivo:
      ```bash
      npx tsx scripts/check-humanizer-social.ts --write \
        --bypass-reason "humanizador re-rodou após ajuste {descrição} no Stage 4" \
        --edition-dir data/editions/{AAMMDD}/
      ```
      O `--write` SEM `--bypass-reason` falhará com exit 3 se o hash divergir — essa é a trava que impede bypasse acidental (#2373). Nunca usar `--write` como atalho para limpar o lint sem re-humanizar.
   4. Re-rodar lints de qualidade social (mesmo fluxo do exit-2 em §4c.2b):
      ```bash
      npx tsx scripts/lint-social-md.ts --check humanizer-section-coverage \
        --pre data/editions/{AAMMDD}/_internal/03-social-pre-humanizador.md \
        --md data/editions/{AAMMDD}/03-social.md
      npx tsx scripts/lint-social-md.ts --check relative-time --md data/editions/{AAMMDD}/03-social.md
      npx tsx scripts/lint-social-md.ts --check linkedin-schema --md data/editions/{AAMMDD}/03-social.md
      ```
   5. Re-rodar check para confirmar exit 0 antes de voltar ao gate:
      ```bash
      npx tsx scripts/check-humanizer-social.ts --check --edition-dir data/editions/{AAMMDD}/
      ```

7. **Voltar ao §4d** (re-apresentar o resumo consolidado atualizado) — loop até o editor responder `sim` ou `abortar`. `ajustar` pode ser repetido N vezes.

**Distinção `editar` vs `ajustar`:**
- `editar`: round-trip via Drive — adequado para revisões longas, múltiplas seções, ou quando o editor não está no terminal.
- `ajustar`: inline no chat — adequado para tweaks rápidos (título, palavra, link), orchestrator aplica na hora.
- Ambos voltam ao gate; `sim` só depois de aprovação explícita.

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
