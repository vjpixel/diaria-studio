---
name: orchestrator-stage-2
description: Detalhe da Etapa 2 (escrita — newsletter + social em paralelo) do orchestrator Diar.ia. Lido pelo orchestrator principal durante a execução — não é um subagente invocável diretamente.
---

> Este arquivo é referenciado por `orchestrator.md` via `@see`. Não executar diretamente.

---

## Etapa 2 — Escrita

**MCP disconnect logging (#759):** Quando detectar `<system-reminder>` de MCP disconnect (Clarice, Beehiiv, Gmail, Chrome, etc.), logar: `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 2 --agent orchestrator --level warn --message "mcp_disconnect: {server}" --details '{"server":"{server}","kind":"mcp_disconnect"}'`. Ao reconectar: mesmo comando com `--level info --message "mcp_reconnect: {server}"`. Persiste em `data/run-log.jsonl` para `collect-edition-signals.ts` (#759). **Sempre acompanhar** com halt banner pra alertar o editor: `npx tsx scripts/render-halt-banner.ts --stage "2 — Escrita" --reason "mcp__{server} desconectado" --action "reconecte e responda 'retry', ou 'abort' para abortar"` (#737).
**Timestamps (#716):** Timestamps apresentados ao editor usam BRT (America/Sao_Paulo, UTC-3) — formato `HH:MM (BRT)`. ISO UTC apenas em logs/JSON internos.

Newsletter e social rodam **em paralelo** a partir de `_internal/01-approved.json` — nenhum depende do outro. O gate ao final é unificado.

### Pré-condição: sentinel Stage 1

<!-- outputs must match the `write` call at the end of orchestrator-stage-1-research.md §gate approval -->
```bash
npx tsx scripts/pipeline-sentinel.ts assert \
  --edition {AAMMDD} --step 1 \
  --outputs "01-categorized.md,_internal/01-approved.json"
```

Exit code handling:
- `0` → continuar.
- `1` → **FATAL:** "Etapa 1 não completou (sentinel ausente). Re-rodar `/diaria-1-pesquisa {AAMMDD}` antes de continuar." Parar.
- `2` → **FATAL:** "Outputs do Stage 1 ausentes. Re-rodar Etapa 1." Parar.
- `3` → logar warn (`npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 2 --agent orchestrator --level warn --message "stage1_sentinel_missing_legacy"`), continuar.

### 2a. Writer + social em paralelo

**Limites por bucket (#358, #742, #907) — aplicados antes de passar ao writer via `apply-stage2-caps.ts`:**
- Ler `_internal/01-approved.json` e calcular contagens de cada bucket.
- Destaques: preservar todos (sempre ≤3).
- Lançamentos: top-5 por score (se houver mais de 5, truncar nos 5 de maior score).
  - **Validar lançamentos ANTES do cap (#742, #876):** rodar `validate-lancamentos.ts` na lista de lançamentos do approved JSON para identificar URLs não-oficiais. Remover lançamentos rejeitados ANTES de calcular `lançamentos_final`. Isso garante que slots liberados por lançamentos inválidos sejam compensados em Outras Notícias. **Persistir o resumo** em `_internal/02-lancamentos-removed.json` para que o `sync-intro-count.ts` (§2b) ajuste menções narrativas a "X lançamentos" no intro:
    ```bash
    npx tsx scripts/validate-lancamentos.ts \
      --approved data/editions/{AAMMDD}/_internal/01-approved.json \
      --write-removed data/editions/{AAMMDD}/_internal/02-lancamentos-removed.json
    ```
    Exit 1 (URLs removidas) é esperado quando o approved tem URL não-oficial — não bloquear, só informativo.
- Pesquisas: top-3 por score (se houver mais de 3, truncar nos 3 de maior score).
- Outras Notícias: `max(2, 12 − destaques − lançamentos_final − pesquisas_final)` — mínimo de 2 garantido.
  - `lançamentos_final` deve ser contado **após** o passo de validação acima (lançamentos inválidos já removidos).
  - Se validação de lançamentos removeu N itens, os N slots liberados são preenchidos a partir do pool de `noticias` (top por score, respeitando o cap resultante).
- **Aplicar caps via script TS (#907)** — não confiar no writer LLM pra respeitar:
  ```bash
  npx tsx scripts/apply-stage2-caps.ts \
    --in data/editions/{AAMMDD}/_internal/01-approved.json \
    --out data/editions/{AAMMDD}/_internal/01-approved-capped.json
  ```
  Writer recebe `01-approved-capped.json`. Lint pós-writer (`--check section-counts`) valida que o output respeitou os caps; falha = re-disparar writer.

**Em uma única mensagem**, disparar os 3 agents simultaneamente:

1. `Agent` → `writer` (Sonnet) passando:
   - `highlights` (extraído de `_internal/01-approved-capped.json` — sempre exatamente 3 entradas após o gate da Etapa 1)
   - `categorized = _internal/01-approved-capped.json` (já truncado pelos caps de #358 via `apply-stage2-caps.ts` — nunca o arquivo bruto)
   - `edition_date`
   - `out_path = data/editions/{AAMMDD}/_internal/02-draft.md`
   - `d1_prompt_path = data/editions/{AAMMDD}/_internal/02-d1-prompt.md`
   - `d2_prompt_path = data/editions/{AAMMDD}/_internal/02-d2-prompt.md`
   - `d3_prompt_path = data/editions/{AAMMDD}/_internal/02-d3-prompt.md`

2. `Agent` → `social-linkedin` passando `approved_json_path = data/editions/{AAMMDD}/_internal/01-approved.json` e `out_dir = data/editions/{AAMMDD}/`.

3. `Agent` → `social-facebook` passando `approved_json_path = data/editions/{AAMMDD}/_internal/01-approved.json` e `out_dir = data/editions/{AAMMDD}/`.

Aguardar os 3 retornarem. Writer retorna JSON `{ out_path, d1_prompt_path, d2_prompt_path, d3_prompt_path, checklist, warnings }`. Se `warnings[]` não estiver vazio, **pare** e reporte ao usuário antes de prosseguir.

**Validar outputs dos 3 agents antes de qualquer processamento (#872):** se um dos 3 falhou silenciosamente (timeout, retorno mal-formado), o merge em 2c crasharia lendo arquivo ausente. Antes de prosseguir, rodar:

```bash
npx tsx scripts/validate-stage-2-outputs.ts --edition-dir data/editions/{AAMMDD}/
```

O script verifica que `_internal/02-draft.md`, `_internal/03-linkedin.tmp.md` e `_internal/03-facebook.tmp.md` existem e não estão vazios. Exit 1 = algum agent falhou — relatar ao editor com sugestão de re-rodar isolado (`/diaria-2-escrita {AAMMDD} newsletter` ou `social`). Não prosseguir.

### 2b. Processar newsletter

- **Pull pós-gate** (antes de qualquer edição local pós-aprovação):
  ```bash
  npx tsx scripts/drive-sync.ts --mode pull --edition-dir data/editions/{AAMMDD}/ --stage 2 --files 02-reviewed.md
  ```
  Garante que edições manuais do editor no Drive durante a revisão do gate não sejam sobrescritas pelo processamento local. Se o pull falhar, usar versão local e logar warn.

- **Lint seções vs buckets (#165).** Antes de qualquer processamento, validar que cada URL nas seções LANÇAMENTOS / PESQUISAS / OUTRAS NOTÍCIAS bate com o bucket correspondente em `_internal/01-approved-capped.json`:
  ```bash
  npx tsx scripts/lint-newsletter-md.ts \
    --md data/editions/{AAMMDD}/_internal/02-draft.md \
    --approved data/editions/{AAMMDD}/_internal/01-approved-capped.json
  ```
  Exit 1 = URL na seção errada ou URL fantasma (não existe no approved). Se falhar, **re-disparar o writer** com a lista de erros explicitada no prompt. Até 3 tentativas; se persistir após 3, reportar erro e pausar pra fix manual no `02-draft.md`. Caso de borda comum: ferramenta nova com `bucket: "noticias"` que o writer põe em LANÇAMENTOS por associação temática.

- **Lint section-counts (#358, #907).** Validar que cada seção secundária respeita o cap de #358 (lançamentos≤5, pesquisas≤3, outras=`max(2, 12-d-l-p)`). O writer pode ignorar caps mesmo recebendo `01-approved-capped.json` se ele decidir incluir runners-up por achar relevante:
  ```bash
  npx tsx scripts/lint-newsletter-md.ts \
    --check section-counts \
    --md data/editions/{AAMMDD}/_internal/02-draft.md \
    --approved data/editions/{AAMMDD}/_internal/01-approved-capped.json
  ```
  Exit 1 = re-disparar writer com a violação no prompt.

- **Lint destaque-min-chars (#914) + destaque-max-chars (#964).** Validar mínimo e máximo de cada destaque (D1: 1000–1200, D2/D3: 900–1000):
  ```bash
  npx tsx scripts/lint-newsletter-md.ts \
    --check destaque-min-chars \
    --md data/editions/{AAMMDD}/_internal/02-draft.md
  npx tsx scripts/lint-newsletter-md.ts \
    --check destaque-max-chars \
    --md data/editions/{AAMMDD}/_internal/02-draft.md
  ```
  Exit 1 do min = destaque anêmico — re-disparar writer com instruction explícita:
  > "Destaque D{N} tem {chars} chars (mínimo {min}). Expanda: (a) adicione 1 frase em 'Por que isso importa' contextualizando impacto pro leitor BR — ex: timing eleitoral, custo de infra, mudança de processo; OU (b) adicione mais 1 parágrafo curto de body com detalhe técnico/empresarial. NÃO repetir conteúdo já presente." (#1208 — anti-pattern observado em 260517: D2/D3 saiam ~860 chars com why em 1 frase só).
  Exit 1 do max = destaque inflado — re-disparar writer com instruction de trimar parágrafo menos relevante OU encurtar 'Por que isso importa'.

- **Normalizar layout (inline — sem Agent, #157):**
  ```bash
  npx tsx scripts/normalize-newsletter.ts \
    --in data/editions/{AAMMDD}/_internal/02-draft.md \
    --out data/editions/{AAMMDD}/_internal/02-normalized.md \
    2> data/editions/{AAMMDD}/_internal/02-normalize-report.json
  ```
  Heurístico conservador — só quebra quando o pattern é inequívoco (ex: 3 títulos do destaque colados no header, ou título+URL+descrição colados num item de seção). Se nenhum bug detectado, `02-normalized.md` é cópia idêntica do draft. Falha do script → log warn + fallback usa `02-draft.md`.

- **Humanizar (#308, #1072):** invocar skill `humanizador` no arquivo `02-normalized.md` — remove tics LLM (gerúndio em cascata, vocabulário inflado, aberturas cenográficas, etc.), calibrando a voz com `context/past-editions.md` como referência:
  ```
  Skill("humanizador", "Leia data/editions/{AAMMDD}/_internal/02-normalized.md, humanize o texto removendo marcas de IA em português, calibrando a voz com context/past-editions.md como referência, e salve o resultado em data/editions/{AAMMDD}/_internal/02-humanized.md.")
  ```
  **Retry 3x + abort se persistir (#1072).** Se a skill retornar erro OU se `02-humanized.md` for byte-idêntico a `02-normalized.md` (no-op), re-invocar até 3 vezes total. Após 3 falhas, **abortar Stage 2** com erro claro pro editor — não usar fallback "normalized direto pra Clarice" silenciosamente. Justificativa: humanizador remove marcas IA que Clarice **não** pega; sem ele a edição sai com prosa polida-vazia (issue #1072). Logar cada tentativa: `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 2 --agent orchestrator --level warn --message 'humanizador attempt N/3 failed'`. Após 3ª falha: `--level error --message 'humanizador esgotou retries — abortar Stage 2'` + exit do pipeline.

- **Revisar com Clarice (inline — sem Agent):**
  Determinar e **persistir** `CLARICE_INPUT` em arquivo (#871) — evita drift entre o passo de leitura e o passo de diff:
  ```bash
  npx tsx scripts/resolve-clarice-input.ts --edition-dir data/editions/{AAMMDD}/
  ```
  O script aplica a fallback chain `(02-humanized.md → 02-normalized.md → 02-draft.md)`, valida que o arquivo escolhido existe, e grava o nome relativo em `data/editions/{AAMMDD}/_internal/02-clarice-input.txt`. Se nenhum existir, exit 1 (FATAL).

  **Snapshot pré-Clarice (#874).** Antes de aplicar Clarice, copiar o `CLARICE_INPUT` resolvido para `_internal/02-pre-clarice.md`. Esse snapshot é (a) source-of-truth pra resume mid-Clarice (ver SKILL diaria-2-escrita), (b) input pro check de estabilidade de URLs (#873) abaixo, (c) input do `clarice-diff.ts`:
  ```bash
  CLARICE_INPUT=$(cat data/editions/{AAMMDD}/_internal/02-clarice-input.txt)
  cp "data/editions/{AAMMDD}/_internal/$CLARICE_INPUT" data/editions/{AAMMDD}/_internal/02-pre-clarice.md
  ```

  **Assertion obrigatória (review #889 P2).** Antes de chamar `mcp__clarice__correct_text`, verificar que o snapshot foi gravado. Se ausente, abortar e logar erro — sem snapshot não há como detectar URL stability nem fazer resume mid-Clarice:
  ```bash
  test -f data/editions/{AAMMDD}/_internal/02-pre-clarice.md || {
    npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 2 --agent orchestrator --level error --message "pre-clarice snapshot missing — aborting before MCP Clarice call"
    echo "ERRO: snapshot pré-Clarice ausente — abortar antes de chamar MCP Clarice." >&2
    exit 1
  }
  ```

  1. Ler `_internal/02-clarice-input.txt` pra obter o filename relativo. Ler conteúdo de `data/editions/{AAMMDD}/_internal/{FILENAME}`.
  2. Chamar `mcp__clarice__correct_text` passando o texto completo. A ferramenta retorna uma lista de sugestões (cada uma com trecho original → corrigido). Salvar a resposta crua em `data/editions/{AAMMDD}/_internal/02-clarice-suggestions.json` antes de aplicar (auditoria + resume).
  3. Aplicar **todas** as sugestões ao texto original, produzindo o texto revisado. Gravar esse texto corrigido (não a lista de sugestões) em `data/editions/{AAMMDD}/02-reviewed.md`.
  4. Gerar diff legível usando o snapshot pré-Clarice:
     ```bash
     npx tsx scripts/clarice-diff.ts \
       data/editions/{AAMMDD}/_internal/02-pre-clarice.md \
       data/editions/{AAMMDD}/02-reviewed.md \
       data/editions/{AAMMDD}/_internal/02-clarice-diff.md
     ```
  Se a Clarice falhar, propagar o erro — **não** usar o rascunho sem revisão.

- **Verificar estabilidade de URLs em LANÇAMENTOS (#873).** Clarice pode "limpar" URLs (remover query params, normalizar paths, adicionar trailing slash) — isso quebra a regra "LANÇAMENTOS só com link oficial" (#160) silenciosamente, porque a URL pós-Clarice pode não bater mais com a whitelist. Comparar URLs pré/pós-Clarice **antes** de `validate-lancamentos.ts`:
  ```bash
  npx tsx scripts/verify-clarice-url-stability.ts \
    --pre data/editions/{AAMMDD}/_internal/02-pre-clarice.md \
    --post data/editions/{AAMMDD}/02-reviewed.md
  ```
  Exit 0 = todas URLs em LANÇAMENTOS estáveis (warnings em outras seções são informativos, não bloqueiam). Exit 1 = Clarice mexeu em URL de lançamento — incluir o output no prompt do gate humano com diff `antes/depois` pra editor decidir: aceitar a versão pós-Clarice (pode quebrar #160) ou restaurar manualmente em `02-reviewed.md`. Não auto-restaurar — preserva agência editorial.

- **Sincronizar contagem da intro (#743, #876):** após a Clarice, o número declarado na intro pode divergir do número real de artigos (ex: lançamentos rejeitados reduziram o total) e a narrativa pode mencionar "X lançamentos" com X antigo. Corrigir automaticamente, passando o resumo de lançamentos removidos escrito em §2a:
  ```bash
  npx tsx scripts/sync-intro-count.ts \
    --md data/editions/{AAMMDD}/02-reviewed.md \
    --lancamentos-removed data/editions/{AAMMDD}/_internal/02-lancamentos-removed.json
  ```
  Se o script retornar `changed: true` ou `lancamentos_changed: true`, logar `warn` no run-log com os valores antes/depois. Não bloquear — correções são cirúrgicas (apenas o número, sem mexer no resto do texto). Quando `02-lancamentos-removed.json` não existe (ex: §2a foi pulado em rerun), o script ignora silenciosamente esse passo.

- **Validar LANÇAMENTOS oficiais (#160):**
  ```bash
  npx tsx scripts/validate-lancamentos.ts data/editions/{AAMMDD}/02-reviewed.md
  ```
  Garante que todo URL na seção LANÇAMENTOS bate com whitelist oficial (`scripts/categorize.ts > LANCAMENTO_DOMAINS`/`PATTERNS`). Se exit code != 0 (URL não-oficial detectada), **incluir os erros no prompt do gate humano** mostrando linha + URL + sugestão de mover pra NOTÍCIAS. Não bloquear automaticamente — editor decide se é erro real ou caso de borda novo (ex: domínio oficial não cadastrado ainda).

- **Sincronizar linha de cobertura (#1097):** após Clarice + validate-lancamentos, antes do render-erro-intencional, rodar:
  ```bash
  npx tsx scripts/sync-coverage-line.ts --edition-dir data/editions/{AAMMDD}/
  ```
  Auto-calcula X (editor_submitted + newsletter_extracted + source:inbox no pool inicial), Y (auto-found = total - X), Z (itens visíveis no 02-reviewed.md final). Substitui a linha "Para esta edição..." no topo do MD. Antes era chutada pelo writer LLM e ficava stale após podas. Stdout: `{ x, y, z, changed, mdPath }`. Falha não-bloqueante (log warn) — números errados são cosméticos, não bloqueiam publicação.

- **Render ERRO INTENCIONAL obrigatório (#1073):** após Clarice (e antes do gate humano), rodar:
  ```bash
  npx tsx scripts/render-erro-intencional.ts \
    --edition {AAMMDD} \
    --md data/editions/{AAMMDD}/02-reviewed.md
  ```
  Substitui o placeholder do writer pelo reveal do erro anterior (`Na última edição, …`) + preserva ou insere placeholder pra `Nessa edição, …` (autor preenche manualmente). **Falha = abortar Stage 2** (não silenciar). Justificativa: sem o script, edição vai com `{placeholder, script render-erro-intencional.ts substitui pós-Clarice}` literal no MD; quando colado manualmente no Beehiiv (#1083), aparece como texto bruto no email — contamina UX e mata o concurso "Ache o erro".

- **Validator final Stage 2 (#1072, #1073):** antes do gate humano, rodar invariant check que detecta passos pulados silenciosamente:
  ```bash
  npx tsx scripts/check-stage2-invariants.ts \
    --edition-dir data/editions/{AAMMDD}/
  ```
  Cobre 3 checks: (a) Humanizador rodou (02-humanized.md ≠ 02-normalized.md), (b) Clarice rodou (02-reviewed.md ≠ 02-pre-clarice.md), (c) render-erro-intencional rodou (sem placeholder literal no MD). Exit 1 = abort + mostrar o(s) check(s) que falharam ao editor. Existe pra capturar regressões de retry/skip silencioso — humanizador/Clarice/render-erro são todos invariantes do Stage 2.

### 2c. Processar social

Após os social agents retornarem, fazer merge em `03-social.md` via script TS. Substitui o snippet inline anterior (#870) — agora com try/catch, validação de tmp files e error reporting actionable:

```bash
npx tsx scripts/merge-social-md.ts --edition-dir data/editions/{AAMMDD}/
```

O script:
- Verifica que `_internal/03-linkedin.tmp.md` e `_internal/03-facebook.tmp.md` existem e não estão vazios; exit 1 com mensagem clara indicando qual agent falhou se algum estiver ausente
- Faz strip de comentários HTML (`<!-- ... -->`) com fallback safe pra comments mal-formados (#875)
- Concatena em `# LinkedIn` + `# Facebook` e grava em `03-social.md`
- Deleta os tmp files após sucesso

Falha = abortar e reportar ao editor com sugestão de re-rodar isolado.

**Humanizar social (#308, #1072):** invocar skill `humanizador` in-place no `03-social.md`:
```
Skill("humanizador", "Leia data/editions/{AAMMDD}/03-social.md, humanize o texto removendo marcas de IA em português, e salve no mesmo arquivo.")
```
**Retry 3x + abort se persistir (#1072).** Se skill retornar erro OU `03-social.md` post-humanizador for byte-idêntico ao pré (no-op), re-invocar até 3 vezes total. Após 3 falhas, **abortar Stage 2** — não publicar social com tom corporativo de agent output. Antes da invocação, fazer snapshot: `cp data/editions/{AAMMDD}/03-social.md data/editions/{AAMMDD}/_internal/03-social-pre-humanizador.md` pra diff post-skill.

**Revisar social com Clarice (inline, ordem #1072: Humanizador → Clarice):** ler `03-social.md` (já humanizado), chamar `mcp__clarice__correct_text`, aplicar sugestões, sobrescrever. **Após sobrescrever**, verificar que as seções `# LinkedIn`, `# Facebook`, `## d1`, `## d2`, `## d3` ainda existem. Se algum cabeçalho estiver ausente, restaurar com `Edit` antes de prosseguir. Se Clarice falhar (retornar erro OU output byte-idêntico ao input), **retry 3x + abort** — mesma regra do reviewed.

**Lint timestamps relativos pré-gate (#877):** após humanizar+Clarice, rodar:
```bash
npx tsx scripts/lint-social-md.ts --check relative-time --md data/editions/{AAMMDD}/03-social.md
```
Detecta "hoje", "ontem", "amanhã", "esta semana", "próxima semana", "este mês", "recentemente", "há N dias/semanas/meses" — palavras que envelhecem entre escrever e publicar (posts vão pra fila com D+1+ delay). Matches dentro de aspas (citação direta) são pulados. Exit 1 = matches encontrados. **Incluir os matches no prompt do gate** mostrando linha + palavra + contexto, mas não bloquear automaticamente — editor decide se reescreve ou aceita (caso de borda raro: nome próprio com palavra-chave).

**Lint LinkedIn schema 3-textos pré-gate (#595):** social-linkedin agora gera main + comment_diaria + comment_pixel por destaque. Validar:
```bash
npx tsx scripts/lint-social-md.ts --check linkedin-schema --md data/editions/{AAMMDD}/03-social.md
```
Falha = subseção ausente (missing_main / missing_comment_diaria / missing_comment_pixel) ou char count fora do range. Exit 1 = re-disparar `social-linkedin` agent.

### 2d. Sync push + gate unificado

- **Sync push antes do gate:**
  ```bash
  npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD}/ --stage 2 --files 02-reviewed.md,03-social.md,_internal/02-clarice-diff.md --on-conflict pull-merge --fail-on-conflict
  ```
  - `--on-conflict pull-merge` (#963): quando Drive foi modificado depois do último push, tenta 3-way merge automático via `git merge-file --diff3` usando snapshot pre-push como base. Edits disjuntos (pipeline mexeu em D2, editor mexeu em D3) merge clean e seguem.
  - `--fail-on-conflict` (#977): quando 3-way detecta overlap real (mesma região editada por ambos), exit 2. Markers `<<<<<<<` ficam em local pra editor resolver.
  - Anotar resultado em `sync_results[2]`. Exit 0 = OK (com ou sem warnings não-conflito); Exit 2 = CONFLICT real — **parar imediatamente** e renderizar halt banner:
  ```bash
  npx tsx scripts/render-halt-banner.ts \
    --stage "2 — Escrita" \
    --reason "drive-sync 3-way merge tem conflitos não-resolvíveis: editor e pipeline editaram a mesma região" \
    --action "abrir 02-reviewed.md, resolver markers <<<<<<<, e re-rodar drive-sync push"
  ```

- **Pre-gate invariants (#1007 Fase 1).** Antes do gate, rodar lints como invariantes (defense-in-depth — lints individuais já rodaram, mas registry centraliza):
  ```bash
  npx tsx scripts/check-invariants.ts --stage 2 --edition-dir data/editions/{AAMMDD}/
  ```
  Exit 1 = re-disparar writer ou bloquear gate até fix manual. Violations são logadas com `source_issue` pra rastreabilidade.

- **Medir tamanho dos destaques (#739).** Antes de apresentar o gate, rodar:
  ```bash
  npx tsx scripts/measure-highlights.ts data/editions/{AAMMDD}/02-reviewed.md
  ```
  Stderr exibe `d1: N chars (M palavras)` por destaque + total + warnings quando algum destaque está fora da faixa saudável (600-1500 chars). Incluir o output stderr no prompt do gate pra editor avaliar balanceamento (d1 muito longo vs d3 raso = desbalanceio editorial; >1500 = newsletter densa, CTR cai). Não bloquear — informativo only.

- **GATE HUMANO unificado (newsletter + social):** mostrar `_internal/02-clarice-diff.md` e o conteúdo de `03-social.md`. Instruir:
  ```
  ✏️  Etapa 2 — Escrita pronta.

  Newsletter — edite data/editions/{AAMMDD}/02-reviewed.md:
      — Mantenha exatamente 1 título por destaque (delete os outros 2).
        URL fica na linha imediatamente abaixo do título escolhido (#172).

  Social — revise data/editions/{AAMMDD}/03-social.md:
      — 3 posts LinkedIn (d1/d2/d3) + 3 posts Facebook (d1/d2/d3)

  📁 Drive: Work/Startups/diar.ia/edicoes/{YYMM}/{AAMMDD}/
  ```
  Quando o editor responder "sim", os arquivos locais são os textos finais.

  - **Auto-pick de título via Opus (#159).** Após aprovação, **fazer snapshot do 02-reviewed.md** pra `_internal/02-pre-title-picker.md` (necessário pra validar estrutura post-#1205), depois dispatch `title-picker` (Opus, Agent) passando:
    - `md_path = data/editions/{AAMMDD}/02-reviewed.md`
    - `out_path = data/editions/{AAMMDD}/02-reviewed.md` (in-place)
    - `audience_path = context/audience-profile.md`
    - `editorial_rules_path = context/editorial-rules.md`
    - `picks_log_path = data/editions/{AAMMDD}/_internal/02-title-picks.json`

    ```bash
    cp data/editions/{AAMMDD}/02-reviewed.md data/editions/{AAMMDD}/_internal/02-pre-title-picker.md
    ```

    Title-picker detecta destaques que ainda têm >1 título (editor não podou) e escolhe 1 baseado em concretude + tom + variedade lexical. Se `destaques_picked > 0`, logar info: `"title-picker: auto-podou N destaque(s) — log em _internal/02-title-picks.json"`. Se `destaques_picked === 0`, editor já podou tudo manualmente — title-picker é no-op.

    Erro do agent (ex: destaque sem título nenhum) deve ser reportado ao editor antes de prosseguir pra Etapa 3 — não há fallback automático pra título inexistente.

  - **Validar estrutura preservada (#1205).** Após title-picker, comparar estrutura de seções pré/pós:
    ```bash
    npx tsx scripts/validate-section-structure.ts \
      --before data/editions/{AAMMDD}/_internal/02-pre-title-picker.md \
      --after data/editions/{AAMMDD}/02-reviewed.md
    ```
    Exit 1 = title-picker mexeu na estrutura (removeu `---`, moveu ERRO INTENCIONAL, etc — caso 260517). **Restaurar do snapshot** e reportar ao editor: `"⚠️ title-picker corrompeu estrutura — restaurando 02-reviewed.md do snapshot. Pode podar 1 título por destaque manualmente."`. Não re-disparar — agent vai cometer o mesmo erro.

  - **Validar 1 título por destaque (#178).** Após o title-picker:
    ```bash
    npx tsx scripts/lint-newsletter-md.ts \
      --check titles-per-highlight \
      --md data/editions/{AAMMDD}/02-reviewed.md
    ```
    Exit 1 = algum destaque ainda tem ≠1 título. **Não prosseguir** — re-apresentar o gate com o erro destacado:
    > ⚠️ DESTAQUE N tem K títulos — delete os K-1 excedentes em `data/editions/{AAMMDD}/02-reviewed.md` antes de aprovar de novo.

    Se exit 0, prosseguir pra Etapa 3 normalmente. (Em caso normal, title-picker já podou tudo e este check passa silenciosamente.)

  - **Inserir TÍTULO/SUBTÍTULO no topo (#916).** Roda depois que cada destaque tem 1 só título (pós title-picker / poda manual). Stage 4 (Beehiiv) usa esse bloco como subject + preview text — sem isso, editor preenche manualmente todo dia. Idempotente.

    ```bash
    npx tsx scripts/insert-titulo-subtitulo.ts \
      --in data/editions/{AAMMDD}/02-reviewed.md
    ```
    Falha = warning, **não bloqueia** (gate já aprovou).

  - **Escrever sentinel de conclusão do Stage 2:**
    ```bash
    npx tsx scripts/pipeline-sentinel.ts write \
      --edition {AAMMDD} --step 2 \
      --outputs "02-reviewed.md,03-social.md"
    ```
    Falha do sentinel → logar warn (`npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 2 --agent orchestrator --level warn --message 'sentinel_write_failed'`). Não bloquear.

  - **Atualizar `stage-status.md` (#1217 — removed cost.md).** Marcar stage 2 done via `update-stage-status.ts --stage 2 --status done --end ISO --duration-ms X [--cost-usd Y --tokens-in N --tokens-out N --models "sonnet-4-6,opus-4-7"]`.
    `title_picker:?1` = só conta se foi disparado (destaques_picked > 0); senão 0.
