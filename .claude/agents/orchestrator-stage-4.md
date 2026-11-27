---
name: orchestrator-stage-4
description: Detalhe da Etapa 4 (revisão editorial assistida — resumo consolidado + gate humano pré-publicação) do orchestrator diar.ia.br. Lido pelo orchestrator principal durante a execução — não é um subagente invocável diretamente.
---

> Este arquivo é referenciado por `orchestrator.md` via `@see`. Não executar diretamente.

---

## Etapa 4 — Revisão editorial assistida (#1694)

Antes de publicar, o orchestrator monta um **resumo consolidado da edição final** e apresenta ao editor num gate humano explícito. Aprovado → segue para Etapa 5 (Publicação). O pre-render técnico (HTML + imagens + upload + close-poll, o antigo §4a-pre-gate) ocorre neste stage, tornando a revisão visual e completa.

**`--no-gates` behavior:** quando `auto_approve = true` (via `--no-gates`), o orchestrator executa o pré-render completo e pula **apenas o gate humano** — o resumo é gerado mas não apresentado. Segue para o §4e em `orchestrator-stage-4-gate.md` (obrigatório) e para na fronteira pós-gate (#6171).

**Pré-gate headless (`pre_gate_only = true`, via `--pre-gate-only`, #14034).** É o spawn `claude -p` que o `/diaria-edicao` faz com `run-edition-stages.ts --stage4-pre-gate`, para a sessão do editor abrir já no gate. Roda §4a–§4c como no modo com editor (`auto_approve = false`: nada de `--headless true` nos lints, nada de halt por falta de editor), com estas diferenças:
- **Pular** o que só existe na sessão interativa: §4b step 3b (doc do Claude Docs, sem conector no `-p`), a publicação dos Artifacts (§4b steps 2b/3, §4c.6b; o §4d publica os que faltarem antes da 1ª apresentação) e a navegação do Chrome. Remetente novo (`pending_senders`, `context/newsletter-intake-gate.md`): não perguntar nem gravar decisão; a pergunta fica para o gate.
- **Bloqueio que pede o editor** (fact-check exit 2 que continua depois das ações do §4c.6, exit 1 DEFASADO repetido, invariante com exit 1 que manda pausar, qualquer halt banner): parar o pré-gate ali e registrar o motivo em `--blocking` no passo final abaixo. Nunca auto-aprovar nem contornar.
- **Snapshot do conteúdo logo depois do §4c.6c** (a última autocorreção do texto): `npx tsx scripts/lib/stage4-pregate.ts snapshot --edition-dir {EDITION_DIR}`. Daí em diante não editar `02-reviewed.md`, `03-social.md`, `01-eia.md`, `_internal/01-approved.json` nem as imagens `04-d*`/`01-eia-*`: o `write` recusa o marcador se algo mudou desde o snapshot, e o `write` exit 2 encerra o pré-gate sem marcador (não refazer o snapshot para forçar). O `write` roda sozinho os checks GATE-BLOCKING (fact-check `--check-blocking`, `check-invariants --stage 4`, `lint-newsletter-md --stage 4`, `validate-*`) e grava os bloqueios pelo exit code; `--blocking` só acrescenta.
- **Nunca** ler `orchestrator-stage-4-gate.md`, apresentar o gate, escrever `.step-4-done.json` nem rodar `update-stage-status.ts --status done` (o runner põe em quarentena o sentinel escrito pelo spawn e sai com exit 7).
- **Passo final, sempre (inclusive com bloqueio):** (1) gravar `{EDITION_DIR}/_internal/04-pregate-summary.md` com os blocos do resumo que o §4c produziu, um por seção `## {nome_do_placeholder}` com o texto pronto para o template do §4d (`violations_block`, `fact_check_block` com o bloco FACT-CHECK AUTO-CORRIGIDO e os resíduos do #9400, `social_critic_block`, `box_click_report_block`, `late_refresh_block`, `newsletter_consensus_block`, a tabela do intake de newsletters com os `pending_senders`, `verify_verdict` de D1/D2/D3, títulos/URLs dos destaques e hooks sociais) e, num bloco `## bloqueios`, os motivos de bloqueio; (2) `npx tsx scripts/lib/stage4-pregate.ts write --edition-dir {EDITION_DIR} [--blocking "motivo"]...`; (3) standalone, `npx tsx scripts/edition-lock.ts release --edition-dir {EDITION_DIR}` (senão a sessão do editor encontra a trava viva e sai com exit 3; se o spawn morrer antes, o runner solta a trava pelo `--session-id` que deu ao spawn); (4) responder numa linha (`pré-gate 4 concluído` ou `pré-gate 4 bloqueado: {motivo}`) e encerrar.

**Abertura no gate (#14034) — sessão com editor (`auto_approve = false`, sem `pre_gate_only`), ANTES da pré-condição abaixo.** Rodar `npx tsx scripts/lib/stage4-pregate.ts check --edition-dir {EDITION_DIR}`:
- **exit 0 (`usable: true`)** — o pré-gate headless já fez §4a–§4c para o conteúdo atual. Não reexecutar §4a–§4c. Fazer só: o guard #11690 e a trava do §4a (`stale-edition-guard.ts`, `edition-lock.ts acquire`, mesmas regras de exit); o §4b step 3b (doc do Claude Docs, que o `-p` pulou); ler `{EDITION_DIR}/_internal/04-pregate-summary.md` (é a fonte dos blocos do resumo, no lugar das variáveis de sessão); e seguir para `orchestrator-stage-4-gate.md` §4d, que já re-serve os previews, publica os Artifacts que faltam e roda os blocos recalculados a cada apresentação. Em `ajustar`, recomputar os blocos afetados como hoje (o resumo do disco vale para a 1ª apresentação).
- **exit 1** — seguir o fluxo inline abaixo desde a pré-condição. Com `reason: "blocked"`, mostrar antes `⚠️ Pré-gate headless parou: {blocking}` e tratar o bloqueio no passo do §4c correspondente. `absent` (pré-gate não rodou ou falhou), `stale` (conteúdo mudou depois dele), `corrupt` e `summary_missing` seguem o fluxo inline sem aviso extra.

**`{EDITION_DIR}` (#2463/#3025):** diretório REAL da edição no disco — pode ser o layout flat legado OU o nested novo, dependendo de quando a edição foi criada. Resolver **uma vez**, logo após ter `{AAMMDD}`, e usar em todo path abaixo — nunca montar `data/editions/` + `{AAMMDD}` à mão:
```bash
EDITION_DIR=$(npx tsx scripts/lib/find-current-edition.ts --resolve {AAMMDD})
```

### Pré-condição: sentinel Stage 3

<!-- outputs must match the `write` call at the end of orchestrator-stage-3.md §Escrever sentinel de conclusão do Stage 3 -->

**#2316: 2-destaque editions** — antes de rodar o sentinel, verificar quantos destaques a edição tem:
```bash
npx tsx scripts/extract-destaques.ts {EDITION_DIR}/02-reviewed.md 2>/dev/null | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(String(d.destaques.length))"
```
Se 2 destaques: usar `--outputs` sem `04-d3-*.jpg` (os arquivos D3 não existem). Se 3 destaques: comando padrão abaixo.

**3 destaques (padrão):**
```bash
npx tsx scripts/pipeline-sentinel.ts assert \
  --edition {AAMMDD} --step 3 \
  --outputs "01-eia.md,04-d1-2x1.jpg,04-d2-2x1.jpg,04-d3-2x1.jpg"
```

**2 destaques:**
```bash
npx tsx scripts/pipeline-sentinel.ts assert \
  --edition {AAMMDD} --step 3 \
  --outputs "01-eia.md,04-d1-2x1.jpg,04-d2-2x1.jpg"
```

Exit code handling:
- `0` → continuar.
- `1` → **ANTES do FATAL (#11712):** rodar `npx tsx scripts/stale-edition-guard.ts check --edition-dir {EDITION_DIR} --step 3`; exit 4 (outra máquina à frente, data/ defasado) → halt banner `render-halt-banner.ts --stage "4 — Revisão" --reason "data/ possivelmente defasado (outra máquina à frente)" --action "aguardar o sync do OneDrive e re-rodar; se a outra sessão morreu, o editor confirma e re-roda o guard com --force"` e NÃO mandar re-rodar `/diaria-3-imagens` (a Etapa 3 regeneraria as imagens e o sync as devolveria por cima da edição da outra máquina, o clobber do #11690). Qualquer outro exit ≠ 0 (2, crash) = mesmo halt. Exit 0 → **FATAL:** "Etapa 3 não completou (sentinel ausente). Re-rodar `/diaria-3-imagens {AAMMDD}` antes de continuar." Parar.
- `2` → **ANTES do FATAL (#11712):** rodar `npx tsx scripts/stale-edition-guard.ts check --edition-dir {EDITION_DIR} --step 3 --outputs-missing`; exit 4 → mesmo halt banner do exit 1 acima (saída: editor confirma e re-roda o guard com `--force`) e NÃO recomendar re-rodar Stage 3. Qualquer outro exit ≠ 0 (2, crash) = mesmo halt. Exit 0 → **FATAL:** "Outputs do Stage 3 ausentes. Re-rodar Etapa 3." Parar.
- `3` → logar warn (`npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator --level warn --message "stage3_sentinel_missing_legacy"`), continuar.
- `4` → sentinel do Stage 3 presente mas malformado (#14133/#14221: JSON ilegível ou campos inválidos). **Não é o exit 4 do `stale-edition-guard.ts`** ("outra máquina à frente"): nada de rodar o guard. Halt banner `render-halt-banner.ts --stage "4 — Revisão" --reason "sentinel do Stage 3 ilegível: {linha [error] do stderr}" --action "conferir {EDITION_DIR}/_internal/.step-3-done.json e aguardar o sync; se seguir inválido depois do sync (ou o [error] apontar campo inválido, não JSON ilegível), o editor confirma e re-roda `/diaria-3-imagens {AAMMDD}` para regravar o sentinel"`. Nunca re-rodar a etapa anterior por conta própria. Parar.

### 4a. Pré-requisitos + sync

**Guard de data/ defasado (#11690) — ANTES da trava e de qualquer escrita, se o sentinel do Stage 4 estiver ausente** (re-run por sentinel ausente): rodar `npx tsx scripts/stale-edition-guard.ts check --edition-dir {EDITION_DIR} --step 4`. Exit 4 (sentinel de stage seguinte ou `edition-lock` de OUTRO host: outra máquina possivelmente à frente, OneDrive atrasado) → NÃO escrever nada em `data/`; `render-halt-banner.ts --stage "4 — Revisão" --reason "data/ possivelmente defasado (outra máquina à frente)" --action "aguardar o sync do OneDrive e re-rodar; se a outra sessão morreu, o editor confirma e re-roda o guard com --force"`. **Qualquer exit ≠ 0 do guard (2 uso inválido, crash do tsx, exceção) é o mesmo halt — nunca seguir como "sem sinais".** O halt do guard NÃO libera a trava nem apaga o tombstone (exceção à regra "liberar antes de qualquer halt" do parágrafo abaixo). `--force` do guard só com confirmação do editor (trava órfã, ou tombstone remoto que ficou para trás porque sentinel/outputs foram removidos de propósito). `edition-lock.ts acquire` com exit 4 (`stale_other_host`: trava vencida de outro host) é o mesmo halt; ali o override é `acquire --force`.

**Trava da edição entre sessões (#10309)** — antes de qualquer escrita em `{EDITION_DIR}` — inclusive o `update-stage-status.ts --status running` logo abaixo, que já escreve na edição (#10354) —, rodar STANDALONE (o hook injeta `--session-id`; encadeado sai exit 2): `npx tsx scripts/edition-lock.ts acquire --edition-dir {EDITION_DIR} --stage 4`. Re-rodar o mesmo comando a cada volta ao §4d (antes de re-apresentar) e antes de processar `ajustar`/`sim` — renova o heartbeat (TTL 45 min) e acusa um fork que tenha assumido no meio. Exit 0 → seguir; com `action` `took_stale`/`taken_over` no JSON, avisar antes: `ℹ️ Sessão assumiu a edição {AAMMDD} de {previous.session_id} ({previous.host}, heartbeat há {N} min)`. **Exit 3 = outra sessão viva está nesta edição** (fork do gate; caso 261016: `docs/orchestrator-stage-narrative-history.md#stage-4-edition-lock-10309`): NÃO escrever nada; mostrar `⚠️ Edição {AAMMDD} em uso por outra sessão ({session_id} em {host}, heartbeat há {N} min) — duas sessões no mesmo gate sobrescrevem as edições uma da outra` e oferecer `assumir` (a outra sessão para de valer: re-rodar com `--force`) ou `abortar` (encerrar esta sessão e continuar na outra). Em `auto_approve` (sem editor): logar warn `edition_lock_held_by_other` e parar com halt banner. Exit 2 (sem `--session-id`) → logar warn e seguir (fail-soft). **Liberar em todo ramo terminal (#10326):** `editar`, `abortar` e ANTES de qualquer halt banner deste stage (exceto o do próprio exit 3 — a trava não é desta sessão — e o halt do guard #11690, que não escreve nada) rodar standalone `npx tsx scripts/edition-lock.ts release --edition-dir {EDITION_DIR}` (exit ≠ 0 é log-only); quem voltar com `retry` re-roda o `acquire` (por que liberar: mesma âncora acima).

**Marcar Stage 4 `running` no início (#1783) — só DEPOIS do `acquire` acima com exit 0 (#10354; exit 3 não carimba nada).** Garante o `start` pra que o `done` do §4i feche a duração no relatório. Sem `--start` — auto-carimbo (#1789) preserva o original em resume:
```bash
npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 4 --status running
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

- Logar início: `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator --level info --message 'etapa 4 revisao started'`
- **Clarice pendente (#12257) — logo aqui, ANTES do pré-render, do fact-check e dos lints, para todos eles verem o texto já revisado:** se `_internal/02-clarice-pending.json` existir (o Stage 2 seguiu sem a Clarice, `clarice-correct.ts` exit 6 ou skip consciente), rodar `npx tsx scripts/clarice-pending.ts resume --edition-dir {EDITION_DIR}/ --edition {AAMMDD}` com a Bash tool em `timeout: 600000` (até 9 min com a API lenta: falha de API, exit 3/6, ganha uma 2ª rodada 2 min depois, com o teto do `clarice-correct.ts` cortado para caber, #13330; `--rounds 1` desliga). Se a Clarice seguir fora, o stderr traz `Clarice segue fora depois de N rodadas espaçadas` e o `last_reason` do marcador registra as rodadas: levar ao gate. Num re-run do Stage 4 depois do fact-check, o `resume` aplica a proteção do #11798 (trechos do `fact-check-autofix.json` e verbos condicionais) e restaura verbatim o reveal da edição anterior (mesma detecção do render). Cada sugestão retida pela proteção sai no stderr (`sugestão retida pela proteção do fact-check: "from" → "to"`) e em `protectedSuggestions` no JSON: levar ao gate. Exits: **0** = Clarice aplicada e guards pós-Clarice limpos, ou nada pendente; **13** = Clarice aplicada, mas `verify-clarice-url-stability`/`verify-clarice-coupons` acharam algo (campo `attention` do JSON): levar ao gate, sem auto-restaurar; **2/3/4/5/6** = exit do `clarice-correct.ts` repassado (2 sem chave, 3 HTTP/timeout/rede/certificado TLS recusado depois das tentativas (#12693), com o motivo na última linha JSON `{"failure": {...}}` do stdout do filho, em `reason` no JSON do resume e em `last_reason` no marcador, 4 I/O, 5 staleness, 6 API fora; 3/6 também quando a última tentativa falhou por API há menos de 20 min, para não gastar 8 min a cada volta ao gate; `--retry-now` força): seguir o Stage 4 com a pendência; **7** = `02-reviewed.md` mudou durante a chamada: rodar de novo; **8** = a Clarice corrigiu o erro intencional ou o reveal: nada aplicado, levar ao gate (manter sem a Clarice, ou `--accept-intentional-error-change` e replantar o erro); **9** = Clarice aplicada, mas um passo pós-Clarice falhou (`strip-emdashes-reviewed`/`sync-eia-block`/`clarice-diff` com exit ≠ 0, `verify-*` com exit ≥ 2, ou crash): rodar à mão os de `hard_failures` antes do gate; a recusa do `sync-eia-block` (exit 4: espelho no placeholder do stitch com `01-eia.md` real) não conta, o resume roda o `--from 01` sozinho e lista o passo em `recovered` (#13908); **10** = correção parcial ou não verificável, nada aplicado (o `reason` original fica; `last_outcome: partial`); **11** = `02-reviewed.md` ausente, ou `fact-check-autofix.json`/`intentional-error.json` ilegível: halt banner com o stderr; **12** = o `clarice-correct.ts` morreu por signal/erro de spawn: nada aplicado, seguir com a pendência e levar o stderr ao gate. Em todos os casos sem Clarice aplicada o marcador fica e o invariante `clarice-pending` (§4c.2b) leva o aviso ao gate.
### 4b. Pré-render técnico
**Antes dos invariantes**, executar integralmente `context/newsletter-intake-gate.md` (#12188): auditoria, scores completos e decisão em lote de remetentes; repetir após ajustes para atualizar destinos. **#13885:** apresentar TODAS as linhas de `_internal/newsletter-consensus-gate.md` em `{newsletter_consensus_block}`, após pontuação suplementar; informativo, nunca bloqueia nem promove automaticamente.
**Pré-render completo sempre roda** (independente de `auto_approve`) — garante que `newsletter-final.html` e previews estejam prontos pra revisão e pra publicação. Com `--no-gates` o gate é pulado, mas o pré-render nunca é. **Contagem da intro derivada do conteúdo, ANTES do pré-render (#12594):** `npx tsx scripts/sync-intro-count.ts --md {EDITION_DIR}/02-reviewed.md` reescreve o N de "selecionei os N mais relevantes" com a contagem real (`countSelectedItems`: destaques + USE MELHOR + LANÇAMENTOS + RADAR + VÍDEOS, sem É IA?, boxes nem rodapé), sem tocar o resto da linha. Fail-soft: exit ≠ 0 = logar warn e seguir (o invariante `intro-count-consistent` do step 5 acusa o que sobrar). Caso 261109: intro com 12, rascunho com 13 itens.

0. **capture-livros-promo — ANTES do upload (#2071).** Re-captura o screenshot da página de livros se o conteúdo mudou (md5 diferente):
   ```bash
   npx tsx scripts/capture-livros-promo.ts --edition-dir {EDITION_DIR}/
   ```
   Exit code handling: `0` = imagem nova em `04-livros-promo.jpg`; `2` = md5 igual, nada a fazer; `1` = falha — logar warn + continuar (asset opcional).

1. **upload-images-public — TODOS modos** (cobre pre-render completo):
   ```bash
   npx tsx scripts/upload-images-public.ts --edition-dir {EDITION_DIR}/ --mode newsletter
   npx tsx scripts/upload-images-public.ts --edition-dir {EDITION_DIR}/ --mode social
   ```

2. Pre-render do newsletter HTML — seguir steps 1.1-1.3 do `context/publishers/newsletter-prerender.md` (#14048; extract-destaques, upload-images-public, render-newsletter-html + substitute-image-urls). Output: `_internal/newsletter-final.html`.

   **Exit codes de `substitute-image-urls.ts` (#2316, #2335):**

   | Exit | Significado | Ação |
   |------|-------------|------|
   | `0` | Sucesso | Continuar |
   | `1` | Erro de args (CLI) | Verificar comando; abortar |
   | `2` | Placeholders não resolvidas | Abortar — verificar `06-public-images.json` e fluxo de upload |
   | `3` | **HTML stale** — `newsletter-draft.html` mais antigo que `02-reviewed.md` | Re-rodar `render-newsletter-html.ts` primeiro, depois re-rodar `substitute-image-urls.ts`. **Não é fatal** — não tratar como falha de pipeline. |
   > **Exit 3 (#2316):** mensagem stderr: `[substitute-image-urls] ERRO: HTML de input está desatualizado`. Ação: re-renderizar e re-substituir. Ver `newsletter-prerender.md` §1.3 para o exit-code table completo (inclui o exit 4, merge tag de ESP no HTML neutro, #13568: abortar).

2a-kit. **Render de MEDIÇÃO do canal Kit (#6506) — sempre roda.** Gera `_internal/newsletter-final-kit.html` (sem isso, `checkKitHtmlSize` abaixo nunca tem artefato pra medir, e só veríamos o e-mail Kit passar de 102 KB — limite de clipping do Gmail — DEPOIS do cutover real). Zero chamada de rede: `npx tsx scripts/render-kit-html-preview.ts {EDITION_DIR}/`. Exit 1 (uso/erro fatal, não deveria acontecer aqui) → logar warn e continuar — o invariant `kit-html-too-large` degrada pra `[]` sem o arquivo, bloqueando só por TAMANHO, nunca por ausência.

2b. **Servir preview LOCALMENTE via `serve-preview.ts` (#3546 — substitui o Worker Cloudflare no caminho de REVISÃO).** Serve o HTML LOCALMENTE (loopback, `http://127.0.0.1:{porta}/...`) com imagens embutidas em `data:` URI via `embed-images-base64.ts` (por que nem Worker nem Artifact: `docs/orchestrator-stage-narrative-history.md#stage-4-preview-local-3546`). **Nunca chamar `upload-html-public.ts` neste passo** — esse script fica reservado ao upload REAL que a Etapa 5 refaz independentemente no dispatch (`docs/archive/beehiiv-playbook.md` §5.2 Fase 3, registro histórico, sobre `newsletter-final.html` intacto, sem a variante embedded).

    Gerar a variante embedded (`newsletter-final.html` fica intacto, com a merge tag de identidade do voto — `{{poll_token}}`, #4487; era `{{email}}` — preservada pro paste real da Etapa 5):
    ```bash
    npx tsx scripts/embed-images-base64.ts --require-all-embedded \
      --html {EDITION_DIR}/_internal/newsletter-final.html \
      --images {EDITION_DIR}/06-public-images.json \
      --edition-dir {EDITION_DIR}/ \
      --out {EDITION_DIR}/_internal/newsletter-final-embedded.html
    ```
    `missing` indica arquivo local ausente; `remaining_remote` lista os src HTTP(S) restantes (#13928). Exit 1 bloqueia servir/republicar esse preview: corrigir os arquivos ausentes ou re-renderizar o HTML com o `06-public-images.json` atual (especialmente após regenerar/upload de imagens), embutir novamente e só seguir com exit 0. A mesma regra vale nos passos de re-serve abaixo.

    Servir localmente em background (porta efêmera) e persistir `{newsletter_url}` + PID (pra teardown em §4e):
    ```bash
    npx tsx scripts/serve-preview.ts \
      --file {EDITION_DIR}/_internal/newsletter-final-embedded.html --port 0 --watch --edition {AAMMDD} \
      --persist-to {EDITION_DIR}/_internal/04-newsletter-url.json --field newsletter_url --detach
    ```
    **`--watch` não é opcional (#8123).** É ele que liga o live-reload da Fatia 1 — sem a flag, o preview só muda se o editor der refresh à mão, e a meta de "~10 s entre o ajuste e ver o resultado" simplesmente não existe (histórico: `docs/orchestrator-stage-narrative-history.md#stage-4-watch-8123`). `--edition` etiqueta as medições de reload no run-log (ver §4d.1).
    **`--detach` não é opcional, e o comando roda em FOREGROUND — NUNCA com `run_in_background: true` nem `&` (#9678).** O harness mata background task no teto de tempo (2h no máximo; default 30min; caso 261006: `docs/orchestrator-stage-narrative-history.md#stage-4-preview-detach-9678`). Com `--detach` o `serve-preview.ts` sobe o servidor num processo desanexado (`setsid` no Linux, grupo próprio no Windows) e SAI em ~1-2s imprimindo o JSON do filho (`url`, `pid`, `log`); o servidor não pertence à task e vive até o teardown (`--stop-pid`, §4d/§4e). Ler `newsletter_url` (e `newsletter_url_pid`, guardado pro teardown) de `04-newsletter-url.json` pra popular `{newsletter_url}` no resumo do gate (§4d). Em modo `local` (`scripts/lib/exec-mode.ts`), pode-se navegar o Chrome do editor pra essa URL pra revisão visual assistida: `mcp__claude-in-chrome__tabs_context_mcp` (obter/criar o `tabId` do grupo MCP) → `mcp__claude-in-chrome__navigate` com esse `tabId` e `url: {newsletter_url}`. Em `cloud`, só logar a URL — sem navegação (sem Chrome do editor na sessão, ver issue #3546 "Fora de escopo").

    **#3700 — persistir o `tabId` usado**, no mesmo JSON, pra o teardown de §4d/§4e conseguir fechar a aba (não só matar o servidor — sem isso a aba fica órfã apontando pro loopback morto e o "Continuar de onde parei" do Chrome a reabre a cada restart):
    ```bash
    node -e "const p='{EDITION_DIR}/_internal/04-newsletter-url.json';const j=JSON.parse(require('fs').readFileSync(p,'utf8'));j.newsletter_url_tab_id={tab_id};require('fs').writeFileSync(p,JSON.stringify(j,null,2));"
    ```
    **Publicar a mesma variante embedded como Artifact, em paralelo ao preview local (#6003) — SEMPRE, e SEMPRE os DOIS (newsletter aqui + social no step 3), #9678.** Não é passo opcional nem "se lembrar": o Artifact é o fallback do preview local quando o loopback cai (caso 261006: `#stage-4-preview-detach-9678` do doc de histórico). Aditivo — cobre revisão fora do terminal (outra máquina, celular) e sobrevive ao fim da sessão/processo local, o que o loopback não faz (mesmo HTML com `data:` URI, sem problema de CSP). Chamar a tool `Artifact` direto (sem skill `artifact-design`/`artifact-capabilities` — HTML final estático, publicação as-is): `Artifact(file_path: "{EDITION_DIR}/_internal/newsletter-final-embedded.html", title: "Newsletter {AAMMDD}", description: "Preview da edição diária para revisão", favicon: "📰")`. Persistir a URL retornada como `{newsletter_artifact_url}` em `04-newsletter-url.json` (campo novo, pro resumo do gate §4d): `node -e "const p='{EDITION_DIR}/_internal/04-newsletter-url.json';const j=JSON.parse(require('fs').readFileSync(p,'utf8'));j.newsletter_artifact_url='{artifact_url}';require('fs').writeFileSync(p,JSON.stringify(j,null,2));"`. **Falha/indisponibilidade da tool é warning-only, nunca bloqueia o gate** — logar aviso e seguir com `{newsletter_artifact_url}` vazio (§4d omite a linha).

3. Pre-render do social preview HTML + servir localmente (mesmo padrão do step 2b acima):
   ```bash
   npx tsx scripts/probe-instagram-comment-scope.ts --edition-dir {EDITION_DIR}/  # #11750: só leitura, fail-soft — o token do Worker comenta? grava _internal/instagram-comment-scope.json; sem prova, preview do 4º post do Instagram mostra a linha da bio (igual ao publish)
   # #1800: --images é OBRIGATÓRIO — sem ele o preview sai sem imagens.
   npx tsx scripts/render-social-html.ts --md {EDITION_DIR}/03-social.md --out {EDITION_DIR}/_internal/social-preview.html --images {EDITION_DIR}/06-public-images.json

   # Variante embedded (data: URI) — mesmo script/motivo do step 2b.
   npx tsx scripts/embed-images-base64.ts --require-all-embedded \
     --html {EDITION_DIR}/_internal/social-preview.html \
     --images {EDITION_DIR}/06-public-images.json \
     --edition-dir {EDITION_DIR}/ \
     --out {EDITION_DIR}/_internal/social-preview-embedded.html

   # Servir localmente em background, persistir social_preview_url + PID.
   npx tsx scripts/serve-preview.ts \
     --file {EDITION_DIR}/_internal/social-preview-embedded.html --port 0 --watch --edition {AAMMDD} \
     --persist-to {EDITION_DIR}/_internal/05-social-preview.json --field social_preview_url --detach
   ```
   Mesmo padrão do step 2b acima pro `navigate`/`tabId` — se o Chrome do editor for navegado pra `{social_url}`, persistir `social_preview_url_tab_id` em `05-social-preview.json` (mesmo mecanismo, #3700). **Publicar a mesma variante embedded como Artifact (#6003), mesmo padrão/motivo do step 2b acima — obrigatório, o par do Artifact da newsletter (#9678):** `Artifact(file_path: "{EDITION_DIR}/_internal/social-preview-embedded.html", title: "Social {AAMMDD}", description: "Preview dos posts sociais para revisão", favicon: "📱")`. Persistir a URL retornada como `{social_artifact_url}` em `05-social-preview.json` (campo novo): `node -e "const p='{EDITION_DIR}/_internal/05-social-preview.json';const j=JSON.parse(require('fs').readFileSync(p,'utf8'));j.social_artifact_url='{artifact_url}';require('fs').writeFileSync(p,JSON.stringify(j,null,2));"`. Mesma tolerância warning-only.

3b. **Documento editável do gate no Claude Docs (#9964) — SÓ A PEDIDO DO EDITOR desde o #14116 (27/11/2026).** Na preparação do gate este passo NÃO roda (custava ~31k tokens por edição sem uso). Roda quando o editor responde `doc` no gate (§4d): executar o bloco abaixo, depois voltar ao §4d e re-apresentar com o link. Resume com `doc_url` já gravado segue valendo como antes. `auto_approve = true` (`--no-gates`): nunca criar; se o `04-docs-gate.json` já tiver `doc_url` de uma sessão anterior, rodar `npx tsx scripts/stage4-docs-sync.ts disable --edition-dir {EDITION_DIR} --reason "auto_approve"`, senão o `check` do §4e trava. Sem `doc_url` o `check` do §4e não trava. Quando criado, o TEXTO do gate (`02-reviewed.md` + `03-social.md`) vai também para um documento editável, com sync automático de volta. **Aditivo** — os previews HTML (loopback + Artifacts, steps 2b/3) continuam iguais; o doc é só texto. O repo segue fonte de verdade: o sync de volta (`apply`, §4d) acusa conflito, nunca sobrescreve em silêncio. O conector Claude Docs é MCP da sessão top-level — os nomes das tools (`mcp__<uuid>__create`/`batch`/`update`/`export`/`read`) variam por sessão, identificar pelo papel; **antes da 1ª chamada, carregar a skill `anthropic-skills:docs` ou, sem ela, `guide(items: ["topic.index"])` do servidor de docs.** Scripts TS nunca chamam o conector. **Fluxo de export ÚNICO (#10078, decisão do editor de 13/10/2026):** o editor edita no doc durante todo o gate; o export do doc chega ao disco **uma vez só, na finalização** (ramo `sim` de §4d) — nunca a cada apresentação nem na criação (motivo: `docs/orchestrator-stage-narrative-history.md#stage-4-docs-export-unico-10078`). **Antes de tudo, conferir o resume:** `_internal/04-docs-gate.json` já tem `doc_url` → **não criar outro doc nem rodar o bloco abaixo** — o doc existente segue valendo (as edições dele entram no apply final). Sem `doc_url`:
   ```bash
   npx tsx scripts/stage4-docs-sync.ts render --edition-dir {EDITION_DIR} --edition {AAMMDD}
   ```
   Grava o markdown do doc em `{EDITION_DIR}/_internal/04-docs-gate.md` (linhas-sentinela `=== INÍCIO 02-reviewed (não edite esta linha) ===` / `=== FIM ... ===` delimitam cada arquivo) e a BASE do merge em `_internal/04-docs-gate.json`; o JSON do stdout traz `title` (= o H1 do markdown). Criar o doc pelo conector com esse markdown e esse `title`, gravar o link com `npx tsx scripts/stage4-docs-sync.ts set-url --edition-dir {EDITION_DIR} --doc-url "{doc_url}" --doc-version {version}` (`{version}` = `container.version` — o `rev` — devolvida pela criação; é o mesmo contador do `rev` do `read` do corpo, confirmado em 20/10/2026, #10310; sem ela, omitir `--doc-version` e o fast path do ramo `sim` fica indisponível, #10177; não mexe na base) e seguir — **sem export na criação**: o `check-roundtrip` (o export do doc intocado tem de voltar equivalente; reprovado grava `sync_disabled`) deixou de ser passo obrigatório e só roda se o editor pedir. A proteção contra o conector alterar o texto sem edição fica no próprio apply final: normalização de export, linha não des-escapável/HTML/remoção em massa viram CONFLITO (nunca gravação), e o editor vê o diff puxado. **Sync desligado** (`sync_disabled`, por `disable` ou por um `check-roundtrip` reprovado): `apply`/`render` saem com exit 2 citando "sync desativado"; o doc fica só como leitura e o resumo mostra o aviso alto de `{doc_url}`. Religar: exportar o doc para `{EDITION_DIR}/_internal/04-docs-gate-export.md` (mesmo passo de gravação do ramo `sim`) e rodar `npx tsx scripts/stage4-docs-sync.ts enable --edition-dir {EDITION_DIR} --doc-export {EDITION_DIR}/_internal/04-docs-gate-export.md` — exit 0 limpa `sync_disabled` (e o `final_apply` antigo); exit 1 = o export não voltou equivalente à base (o conector alterou o texto, ou o doc já tem edição feita enquanto estava desligado) e o sync segue desligado com o motivo original. Nunca editar `04-docs-gate.json` à mão. **Fail-soft, warning-only, nunca bloqueia o gate:** conector ausente (ex.: sessão headless no servidor), erro do conector ou `render` com exit 2 → logar `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator --level warn --message "docs_gate_indisponivel: {motivo}"`, guardar o motivo como `{doc_unavailable_reason}` e seguir sem doc.

4. close-poll (set gabarito — idempotente):
   ```bash
   npx tsx scripts/close-poll.ts --edition {AAMMDD}
   ```

5. **Pre-dispatch invariants (#1007 Fase 1).** ANTES, medir o tempo dos USE MELHOR inseridos/alterados à mão no gate (#12108; grava o tempo medido no md, preserva o texto sem fonte medida, fail-soft exit 0): `npx tsx scripts/refresh-use-melhor-tempo.ts --edition-dir {EDITION_DIR}/ --write` — `use-melhor-tempo-item-sem-medicao` avisa a divergência. Em seguida, re-auditar o intake de newsletters logo antes dos invariantes (#12188; o invariante `newsletter-intake` compara o hash de conteúdo das entradas): `npx tsx scripts/audit-newsletter-intake.ts --edition {AAMMDD} --edition-dir {EDITION_DIR}`. Depois: Validar que `06-public-images.json` está populado e env vars críticas estão setadas:
   ```bash
   npx tsx scripts/check-invariants.ts --stage 4 --edition-dir {EDITION_DIR}/
   ```
   Exit 1 = pausar com violations no stderr. Editor corrige e re-roda. Inclui `image-crop-warn` (#3951, revisor de crop do Stage 3; só o card 4:5, o crop 1:1 não chega ao leitor e não avisa, #12226) — severity warning, nunca pausa; incluir no `{violations_block}` do gate (§4d). Inclui também `image-starry-night-detected` (#10312) — **error** quando o revisor acusou Noite Estrelada (`categoria: "estilo"`) na imagem ATUAL de um destaque e a regeneração automática do Stage 3 esgotou ou não rodou; conserto na própria mensagem (`run-image-crop-reviewer.ts --estilo-regen-plan` ou prompt reescrito + regeneração, depois re-rodar o revisor; falso positivo: `run-image-crop-reviewer.ts --mark-false-positive dN`, chaveado pelo md5 da imagem e fora do veredito, sobrevive às re-revisões do §4d.1 — `status: "ok"` manual some no próximo persist, #10328). Inclui também `card-4x5-upload-missing` (#4090 item 4) — dispara quando `04-d{N}-4x5.jpg` existe no disco mas `06-public-images.json` não tem `d{N}_4x5.url` (upload não subiu o card); severity warning, nunca pausa, mas silêncio aqui publica o post no formato errado (1:1 sem título) — incluir no `{violations_block}` do gate (§4d). Inclui também `carousel-cards-missing` (#6740) — dispara **error** quando NENHUM dos N×4 slides do carrossel existe pra NENHUM destaque com texto em `03-social.md` (ausência TOTAL, não staleness/incompletude parcial): sinal de que `gen-carousel-cards.ts` nunca rodou nesta edição (os 3 checks abaixo saem cedo sem NENHUM slide; caso real: `docs/orchestrator-stage-narrative-history.md#stage-4-carousel-cards-missing-6740`). Inclui também `carousel-cards-stale`, `carousel-upload-incomplete` (#6064) e `carousel-upload-stale` (#6068) — o 1º dispara quando o `03-social.md` mudou DEPOIS que os slides do carrossel foram rasterizados no Stage 3 (**error** na divergência, warning quando não há carimbo pra comparar; conserto na própria mensagem — regerar + re-subir), o 2º quando os 4 slides existem no disco mas falta alguma das 5 chaves em `06-public-images.json` (warning — o post cai pro single-image em silêncio), e o 3º quando a arte no KV está ATRÁS do arquivo local (md5 divergente, **error**: sem ele o par regerar-sem-re-subir passava verde nos outros dois e publicava a arte velha). Inclui também `render-warnings-consumed` (#4673) — lê `_internal/render-warnings.json` (escrito pelo `render-newsletter-html.ts` do step 2 acima, a cada chamada) e surfaced os eventos `divulgacao_box_dropped_no_gap` (caixa de divulgação COMERCIAL que não coube em nenhuma lacuna) e `whatsapp_share_no_d1` (bloco WhatsApp sem D1); severity warning, nunca pausa — incluir no `{violations_block}` do gate (§4d). Inclui também `max-content-items` (#9785) — `02-reviewed.md` com mais de 13 conteúdos (destaques + seções secundárias; o corte por score já rodou no Stage 2, então sobra só item pinado pelo editor ou conteúdo inserido depois); severity warning, nunca pausa — incluir no `{violations_block}` do gate (§4d). Inclui também `intentional-error-present-in-final` (#7243) — verifica que `wrong_value` de `_internal/intentional-error.json` (a grafia/valor ERRADO plantado, irmão de `correct_value`) ainda aparece em `02-reviewed.md`; **error** quando declarado e ausente (sinal de item removido/reescrito), warning quando `wrong_value` não foi preenchido (não dá pra verificar mecanicamente). **Esta chamada aqui roda ANTES do editor ver o gate — não cobre edições feitas DEPOIS (loop `ajustar`, painel Studio). Re-roda de novo, sozinha, em §4e logo antes do sentinel — é aquela chamada que de fato fecha a janela do incidente #7243.**

  - **`image-starry-night-detected` em `auto_approve = true` (`--no-gates`, rodada agendada, #10312):** sem editor, o exit 1 para a edição — não tratar como exit 1 genérico nem prosseguir pra Etapa 5 sozinho. Antes do halt (#10346): se a mensagem do invariante sugerir `--estilo-regen-plan` (plano não rodou, ou não rodou para a imagem ATUAL depois de um swap), rodar o loop do plano descrito em §4d.1a ("Revisão de crop da imagem regerada"; `orchestrator-stage-4-gate.md` §4d.1a, ler agora) e re-rodar os invariantes — halt só se o erro persistir. Renderizar halt banner com causa e ação específicas: `npx tsx scripts/render-halt-banner.ts --stage "4 — Revisão" --reason "image-starry-night-detected: Noite Estrelada na imagem de {dN}, regeneração automática do Stage 3 esgotada ou não rodou (ver mensagem do invariante)" --action "regenere a imagem à mão (reescreva _internal/02-{dN}-prompt.md + comandos da mensagem do invariante) e re-rode o revisor, OU, se falso positivo, rode run-image-crop-reviewer.ts --edition-dir {EDITION_DIR}/ --mark-false-positive {dN}; depois re-rode /diaria-4-revisao"`.
  - **`source-not-read` (#12258; error desde o #13884, decisão do editor de 25/11/2026):** item de POOL (LANÇAMENTOS/RADAR/USE MELHOR/VÍDEOS) cuja fonte não foi lida (download falho, prévia de paywall, resumo curto sem descrição reescrita do texto pelo `writer-pool`) é **error**: não entra sem decisão explícita do editor. Destaque com fonte não lida segue warning (o fact-check já o expõe). **Interativo:** mostrar no gate a lista da mensagem do invariante, item a item, e o editor decide — tirar (`remove-pool-item.ts`), trocar o item, ou manter: só então registrar o aceite com `npx tsx scripts/ack-source-not-read.ts --edition-dir {EDITION_DIR}/ --url {URL} --reason "{motivo do editor}"` (rebaixa o item a warning, "aceito pelo editor") e re-rodar os invariantes. Nunca registrar aceite sem a resposta do editor. **`auto_approve = true` (`--no-gates`):** sem editor, o exit 1 para a edição; não registrar aceite sozinho nem seguir para a Etapa 5. Halt banner: `npx tsx scripts/render-halt-banner.ts --stage "4 — Revisão" --reason "source-not-read: item(ns) de pool sem texto lido (ver mensagem do invariante)" --action "abra a fonte de cada item listado e decida: tire/troque o item, ou registre o aceite com ack-source-not-read.ts --url URL --reason motivo; depois re-rode /diaria-4-revisao"`.
  - **Snapshot pós-Stage 4 pre-render para derivação de pedidos editoriais (#5731).** Após o pre-render completo e validação de invariantes, criar snapshots dos HTMLs finais para permitir derivação determinística posterior de mudanças no pré-render:
    ```bash
    npx tsx scripts/derive-editor-requests.ts snapshot-stage4 --edition {AAMMDD}
    ```
    Exit code handling: `0` = snapshots criados; `!=0` = logar warn, não bloquear.

### 4c. Montar resumo consolidado da edição

Coletar e organizar todas as informações da edição final para apresentar ao editor. **Reusar os validate-*/lint-* existentes** para gerar o relatório — nada novo aqui, apenas consolidação.

**4c.1 — Destaques + títulos + links:**
- Ler `_internal/01-approved.json` para os destaques aprovados (D1, D2, D3) com `url`, `category`, `score`.
- Ler `02-reviewed.md` para extrair os títulos escolhidos (1 por destaque após poda) e os URLs no corpo final.
- Verificar acessibilidade dos 3 URLs principais (simples HEAD request, ~3s). **#5585: o script só aceita argumentos posicionais** (`<urls.json | url1,url2,...> [out.json] [--bodies-dir ...] [...]`) — `--urls`/`--out` NÃO existem e quebram o parser (o valor de `--urls` cai malformado como positional); `/dev/null` também não funciona no Windows/Git Bash, usar um path real de scratch:
  ```bash
  npx tsx scripts/verify-accessibility.ts "{url1},{url2},{url3}" "{EDITION_DIR}/_internal/verify-accessibility-4c1.json"
  ```
  Capturar `verify_verdict` (accessible/inaccessible/timeout) para cada URL. Inacessível = mostrar ⚠️ no resumo mas não bloquear.

**4c.1b — URL prevista do bloco WhatsApp (#4570):** computar a URL EXATA que já está baked-in no HTML do bloco WhatsApp (dentro do D1, #5152), pra conferência do editor ANTES de aprovar — ela depende de `seoSlug(título_d1)` bater com o slug real do post, o que só é possível de garantir no Stage 6 (post ainda não existe aqui), então esta linha é só PREVISÃO/conferência visual:
  ```bash
  npx tsx -e "
    import { buildWhatsappEditionUrl } from './scripts/lib/newsletter-render-html.ts';
    console.log(buildWhatsappEditionUrl('{AAMMDD}', '{título_d1}'));
  "
  ```
  Capturar como `{whatsapp_url}` e **persistir em disco (#5414)** — um corte de contexto entre este passo e o gate (§4d) não pode perder o valor:
  ```bash
  npx tsx scripts/lib/stage4-capture-state.ts --edition-dir {EDITION_DIR} --whatsapp-url "{whatsapp_url}"
  ```
  Incluído no gate (§4d), que lê de volta deste arquivo. Se o editor mudar o título do D1 via "ajustar" (§4d.1), recomputar E regravar antes de re-apresentar o gate (mesma cascata de re-render já disparada pela mudança de título).

**4c.1c — Sugestão de meta description do D1 (#5101 item 2)** (por que: `docs/orchestrator-stage-narrative-history.md#stage-4-meta-description-5101`). Computar a sugestão (pura, determinística, sem LLM):
  ```bash
  npx tsx -e "
    import { buildMetaDescriptionSuggestion } from './scripts/lib/meta-description.ts';
    const s = buildMetaDescriptionSuggestion({ body: {corpo_d1_json_stringificado} });
    console.log(s ?? '');
  "
  ```
  Capturar como `{meta_description_suggestion}` e **persistir em disco (#5414)**, mesmo motivo do §4c.1b acima:
  ```bash
  npx tsx scripts/lib/stage4-capture-state.ts --edition-dir {EDITION_DIR} --meta-description-suggestion "{meta_description_suggestion}"
  ```
  (String vazia é um valor legítimo já capturado — grava normalmente, não pular a escrita.) Incluído no gate (§4d), que lê de volta deste arquivo. Puramente informativo. **Não decidir sozinho trocar o preview text em produção** — é decisão do editor (trade-off contra a taxa de abertura do e-mail): o editor cola esta sugestão no campo de SEO description da Beehiiv **se esse campo existir separado do preview text** — não confirmado a partir daqui (sem acesso à UI da Beehiiv nesta sessão; checar manualmente e registrar em `docs/seo-notes.md` se ainda não estiver lá). Se `{corpo_d1}` estiver vazio/nulo (ex: falha de parse) OU se o 1º parágrafo do corpo não tiver prosa aproveitável (ex: só uma imagem ou um link markdown, sem texto ao redor), `buildMetaDescriptionSuggestion` retorna `null` (`s ?? ''` acima já normaliza pra string vazia na captura) — mostrar `⚠️ sugestão indisponível` nesse caso, sem bloquear o gate.

**4c.2 — Lints consolidados:**
```bash
npx tsx scripts/validate-lancamentos.ts {EDITION_DIR}/02-reviewed.md
npx tsx scripts/validate-domain-diversity.ts {EDITION_DIR}/02-reviewed.md
npx tsx scripts/validate-amazon-affiliate-tags.ts {EDITION_DIR}/02-reviewed.md --audience diaria
npx tsx scripts/lint-newsletter-md.ts --stage 4 --json --edition-dir {EDITION_DIR}
```
(#5416) O último comando é o agregador dos checks de `lint-newsletter-md.ts` (histórico: `docs/orchestrator-stage-narrative-history.md#stage-4-lint-agregador-5416`). `validate-lancamentos.ts` continua separado (script próprio, fora de `lint-newsletter-md.ts`). Output do agregador (stdout): JSON `{ stage: 4, passed: boolean, checks: [{ id, source_issue, severity, ok, result }, ...] }`. `passed` já reflete "nenhum check `gate-blocking` falhou" — não recompute na mão. Pra cada `checks[]` com `ok:false`: `severity: "gate-blocking"` → tratar como ❌ (mesma ação descrita no parágrafo do check correspondente abaixo, indexado pelo `id`); `severity: "warn-only"` → ⚠️ no `{violations_block}`, nunca bloqueia. Os `id` batem com os nomes de `--check X` de antes (`secondary-items-have-summary`, `no-untranslated-summary`, etc.) — os parágrafos abaixo continuam sendo a referência de rationale/ação por check, só a invocação mudou. **Exceções, NÃO 1:1 (#5455 fix):** `url-bucket` nunca teve `--check url-bucket` — roda em modo DEFAULT, sem `--check`, via `--md {file} --approved {file}` (debug isolado: `npx tsx scripts/lint-newsletter-md.ts --md {EDITION_DIR}/02-reviewed.md --approved {EDITION_DIR}/_internal/01-approved.json`); e `md-exists` (novo, #5416) não tem `--check` isolado equivalente — falha significa que o arquivo do stage não existe, investigar por que não foi escrito antes de qualquer outra ação. Pros demais `id`, debug de 1 check isolado (`--check X --md {EDITION_DIR}/02-reviewed.md`) continua funcionando exatamente como antes (modo aditivo, não removido). **`erro-intencional-placeholder` e `intentional-error-flagged` (#5566) também NÃO fazem parte do `checks[]` do agregador** — ao contrário dos demais `id` desta lista, nenhum dos dois é emitido por `runStage4LintReport()`; documentados abaixo como par de checks CLI isolados, invocados manualmente pelo orchestrator antes do gate (não via `--stage 4 --json`). **#11083 — `fact-recurrence`** roda nos invariantes do Stage 4 sobre os parágrafos atuais de todas as seções de `02-reviewed.md`, contra títulos/temas dos últimos 30 dias. Incluir os warnings no `{violations_block}` com edição anterior, item, score e evidência. É heurístico: pedir ao editor qual fato novo justifica a continuação; nunca remover automaticamente. O Stage 1 também grava `fact_recurrence_warnings` em `_internal/01-highlight-theme-check.json`: marcar esses itens como possíveis continuações no gate, mostrando o resumo para conferir a novidade. **#11496 — `story-twice-in-edition` e `theme-cross-source-repeat`** também rodam nos invariantes do Stage 4, sobre o `02-reviewed.md` FINAL (pegam a duplicata que swap/promote/demote no gate reintroduzem depois do dedup do Stage 1): a 1ª acusa a mesma história duas vezes na edição (destaque × destaque, item do pool × destaque) ou repetindo, por produto+versão, um destaque das últimas 3 edições; a 2ª traz o aviso `cross_source_match: true` de `_internal/01-highlight-theme-check.json → warnings[]` (candidato a destaque que repete tema de destaque recente) quando o item segue na edição. Listar as duas como 🚨 no `{violations_block}`, ao lado do `same_fact_warnings`; warning-only, o editor decide o corte. Exceção (#11517): `theme-cross-source-repeat` cuja mensagem não começa com 🚨 é sinal fraco (sobreposição só parcial depois de tirar palavras de anúncio genéricas) — listar como ⚠️ conferência, nunca como "cortar". **#11763 — `study-source-recurrence`**: item (destaque ou pool) do `02-reviewed.md` final que é cobertura secundária de estudo/relatório já publicado nos últimos 30 dias (mesmo publicador + menção a estudo/relatório + número-chave em comum); listar como 🚨 no `{violations_block}`, warning-only, o editor decide o corte (nunca remover automaticamente). **#11897 — `story-continuation`**: DESTAQUE do `02-reviewed.md` final que continua história já publicada nos últimos 30 dias (1º produto+versão do lead igual ao assunto de item passado, ou URL que continua a anterior no mesmo host; casos reais destes dois avisos: `docs/orchestrator-stage-narrative-history.md#stage-4-recorrencia-casos-11763-11897`); listar como ℹ️ no `{violations_block}`, nunca como "cortar": fato novo é legítimo, o aviso serve para o texto citar a edição anterior ou não repetir o contexto. **Passo incondicional — `same_fact_warnings` (#9216, resíduo do #9100), WARN-ONLY, roda sempre (não é check do agregador, não depende de nenhum `id` falhar):** com Stage 1 em `--no-gates` o `🚨 MESMO FATO` do gate 1 não aparece; ler `_internal/01-highlight-theme-check.json` (campo `same_fact_warnings`; ausente/ilegível = ignorar) e listar como 🚨 no `{violations_block}` os itens cujo `item_url` ainda está em `02-reviewed.md` (item_title + matched_edition + matched_title). Nunca bloqueia. **Desde #9386**, ler também `_internal/01-same-fact-removed.json` (campo `removed[]`; ausente = ignorar): itens de RADAR/LANÇAMENTOS que o Stage 1 em `--no-gates` REMOVEU do pool por MESMO FATO — listar como 🗑️ no `{violations_block}` (bucket + title + matched_edition + matched_title), para o editor reverter se for follow-up legítimo. **#13844:** o mesmo log inclui remoções contra os destaques finais da edição (`scope: "current-edition"`), também em USE MELHOR e no modo com gate 1. Apresentar todas; se o editor pedir restauração, recolocar `removed[].item` integralmente no bucket indicado do approved e reinserir o item na seção correspondente de `02-reviewed.md` antes de regenerar a prévia. Nunca reaplicar a remoção após essa decisão no gate 4. **Desde #9100**, ler também `_internal/01-same-fact-demoted.json` (campos `demoted[]` e `kept[]`; ausente = ignorar): `demoted[]` lista como ⬇️ no `{violations_block}` os candidatos REBAIXADOS do destaque no Stage 1 por repetirem fato dos D1–D3 recentes (title + from_rank + bucket + match.matched_edition + match.matched_title) — seguem no pool, o editor pode promovê-los de volta; `kept[]` lista como 🚨 os repetidos que ficaram no destaque por falta de substituto. Item que já sai como ⬇️ (URL em `demoted[]`) não ganha também o 🚨 do `same_fact_warnings` — um aviso por item. **Desde #9462**, ler também `_internal/01-generic-study-demoted.json` (campos `applied`, `demoted[]`, `kept[]`; ausente/ilegível = ignorar): com `applied: true`, listar cada `demoted[]` como ⬇️ ESTUDO/CASE GENÉRICO no `{violations_block}` (title + from_rank + bucket + signals + replaced_by) — saiu do destaque no Stage 1 e segue no pool, o editor promove de volta se houver fato novo; `kept[]` como ⚠️ (genérico que ficou por falta de substituto ou por ser o único negativo). Com `applied: false` (flag desligada, modo sombra), `demoted[]` NÃO vai para o `{violations_block}`: vira a pergunta explícita sim/não por item no TOPO do gate (`{generic_study_questions_block}`, §4d, #9673) — perdida no meio dos avisos o editor não responde. Nunca bloqueia.

`validate-domain-diversity.ts` (#5735, integrado ao gate no #5813): **GATE-BLOCKING** quando exit 1 — mais de 2 URLs (default `DEFAULT_MAX_PER_DOMAIN`) do mesmo domínio registrável somadas na edição inteira (destaques + RADAR + USE MELHOR + LANÇAMENTOS + VÍDEOS), regra editorial de `context/editorial-rules.md`. Script separado, fora de `lint-newsletter-md.ts` — mesmo padrão de `validate-lancamentos.ts` acima. O script já exclui hosts não-editoriais (rodapé/link de casa — `isNonEditorialHost`, `*.diar.ia.br` entre outros) antes de contar, então o rodapé fixo da própria newsletter nunca aciona falso-positivo aqui (histórico: `docs/orchestrator-stage-narrative-history.md#stage-4-domain-diversity-5813`). Exit 1 → NÃO montar o gate ainda. Ação: ler `stderr` (lista domínio + URLs + linha), substituir os excedentes por link de outro domínio, ou promover um deles a fonte primária de um destaque diferente, antes de re-rodar até exit 0.

`validate-amazon-affiliate-tags.ts --audience diaria` (#8059): **GATE-BLOCKING** quando exit 1 — link Amazon sem `tag=`, com o ID de OUTRA audiência (`claricenews-20`, reservado aos envios Brevo Clarice), ou atrás de um encurtador (`amzn.to`/`link.amazon`/`amzlinks.in`, cuja tag embutida não é reescrevível por query string — trocar por link longo `amazon.com.br/dp/{ASIN}?tag=diaria-20` no snippet/conteúdo fonte). A vitrine `amazon.com.br/shop/vjpixel` é exceção documentada (ID principal `vjpixel-20`, ver `scripts/lib/amazon-affiliate.ts`) e nunca aciona este check. Exit 1 → NÃO montar o gate ainda; ler `stderr` (URL + tipo de issue) e corrigir o link na fonte (seed/snippet) antes de re-rodar.

**Nota (#5416):** `stacked-intro-callouts` está documentado abaixo como WARN-ONLY, mas o agregador o reporta como `gate-blocking`; vale o `severity` do JSON (divergência pré-existente: `docs/orchestrator-stage-narrative-history.md#stage-4-stacked-intro-callouts-severity`).

`erro-intencional-placeholder` (#2078, #3489): validado como invariante GATE-BLOCKING já no Stage 2 (`check-invariants.ts --stage 2`, antes do gate de Stage 2) — cobre **só a narrativa** "Nessa edição, …" em `02-reviewed.md` (placeholder literal `{PREENCHER_NARRATIVA_DO_ERRO}`, ou narrativa corrompida/genérica/catalog-shaped). **Não** valida os 5 campos estruturados de `_internal/intentional-error.json` (description/location/category/correct_value/reveal — ver `orchestrator-stage-2.md` §2b "Coletar os campos do editor") — essa completude é um check IRMÃO separado, `intentional-error-flagged` (mesmo `lint-newsletter-md.ts`), documentado em `context/publishers/newsletter-prerender.md` §0 (#14048; até o #11225 rodava no Stage 5, antes de criar o draft Beehiiv). Nenhum dos dois deveria sobreviver sem resolução até o Stage 4 — **mas se sobreviver** (Stage 2 pulado/bypassado, retomada de checkpoint pré-preenchimento), rodar os dois aqui também, **GATE-BLOCKING**, antes de montar o gate (§4d) — não esperar o Stage 5 descobrir um campo `{PREENCHER...}` pendente:
```bash
npx tsx scripts/lint-newsletter-md.ts --check erro-intencional-placeholder --md {EDITION_DIR}/02-reviewed.md
npx tsx scripts/lint-newsletter-md.ts --check intentional-error-flagged --md {EDITION_DIR}/02-reviewed.md [--headless true]
```
`--headless true` (#8897): passar quando a edição roda com `--no-gates` — sem editor pra ler o warn de categoria de risco (numeric/factual/data, #2149), o 2º comando escala pra `exit 1` em vez de só logar. Exit 1 em qualquer um dos dois = placeholder pendente (narrativa MD no 1º, campos JSON no 2º — ver `label` de cada saída). **Antes de PROPOR um candidato de erro sozinho pra fechar essa lacuna** (caso o Stage 2 tenha pulado essa etapa), aplicar por padrão, ANTES de apresentar qualquer proposta ao editor, o mesmo **Filtro de segurança ao PROPOR candidatos (#3808)** já documentado em `orchestrator-stage-2.md` §"Filtro de segurança ao PROPOR candidatos" — as 3 diretrizes de `context/editorial-rules.md` §10 ("Concurso 'ache o erro'"): (1) nunca alterar um fato central de um DESTAQUE (funding, specs, dado de negócio — o que o leitor levaria como "notícia real"); (2) preferir erro cômico/leve (trocadilho, erro ortográfico bobo, nome trocado de forma óbvia) a inflação de magnitude sobre um fato real; (3) preferir plantar em menção lateral/secundária, nunca na frase que carrega a informação principal do destaque. Montar a proposta completa (os 5 campos, já filtrada pelas 3 diretrizes) e apresentar como "aceito esta proposta / quero outra / vou escrever a minha" — nunca uma pergunta em aberto sem o filtro aplicado primeiro (caso real que motivou esta nota: `docs/orchestrator-stage-narrative-history.md#stage-4-erro-intencional-safety-filter-gap`, #5566). Ação após aceite: gravar em `_internal/intentional-error.json`, rodar `render-erro-intencional.ts` (§2b) se ainda não rodou, e re-rodar os 2 comandos acima até exit 0 em ambos antes de prosseguir pro gate.

`secondary-items-have-summary` (#2545): **GATE-BLOCKING** quando exit 1 — item de LANÇAMENTOS/RADAR/USE MELHOR sem descrição renderiza título pelado no email. Ação: editar `02-reviewed.md` e adicionar descrição plain text (1 frase) abaixo de cada item pelado, ou re-rodar Etapa 1 (se a causa foi cache-miss no enrich).

`secondary-item-coherence` (#5663): cruza cada URL secundária com o `summary` bruto de `01-approved.json` e acusa aspas desbalanceadas ou reticências que não existem no summary. Não tenta medir similaridade semântica: a ação é reescrever a descrição fielmente ao fato central, fechar a citação ou remover a reticência fabricada. **Severidade dinâmica desde #6441:** aspas desbalanceadas seguem sempre GATE-BLOCKING (sem autofix possível); reticência fabricada (`fabricated-ellipsis`) vira **warn-only** — o autofix do Stage 2 (`apply-secondary-item-coherence-autofix.ts`) já tentou restaurá-la, o que sobra é residual. O único caso que permanece GATE-BLOCKING de fato é quando o próprio `summary` de origem TAMBÉM termina em reticência (lixo de RSS, ex: "saudedigitalnews" #6441) — aí não há o que restaurar, e a única saída é reescrever a descrição manualmente no gate.
`no-untranslated-summary` (#3196): **GATE-BLOCKING** quando exit 1 — item de LANÇAMENTOS/RADAR/USE MELHOR com marcador literal `[TRADUZIR]` OU descrição detectada como inglês pela heurística de stopwords (mesmo sem o marcador, caso o humanizador tenha removido o prefixo sem traduzir o texto). `stitch-newsletter.ts` injeta `[TRADUZIR] ` em descrições EN e depende do humanizador (LLM) pra traduzir — sem este lint, o item vazava pro gate/publicação intacto (histórico: `docs/orchestrator-stage-narrative-history.md#stage-4-untranslated-summary-incident`). Ação: traduzir a descrição pra PT-BR em `02-reviewed.md` e remover o prefixo `[TRADUZIR] ` antes de aprovar.

`video-links-are-youtube` (#3202): **GATE-BLOCKING** quando exit 1 — item da seção VÍDEOS com URL fora de `youtube.com`/`youtu.be` (regra editorial nova: `context/editorial-rules.md` — Seção "Vídeos"). Backstop da resolução do Stage 1 (`scripts/resolve-video-youtube.ts`, passo 1m-quinquies) e do link colado à mão (caso real: `docs/orchestrator-stage-narrative-history.md#stage-4-video-nao-youtube-caso-real`). Ação: substituir pela URL do YouTube equivalente (`youtube.com/watch?v=...` ou `youtu.be/...`) em `02-reviewed.md` antes de aprovar, ou remover o item de VÍDEOS.

`section-links-resolve` (#3821): **GATE-BLOCKING** quando exit 1 — algum item de seção secundária (LANÇAMENTOS/RADAR/USE MELHOR/VÍDEOS) saiu do parser REAL (`parseSections`, o mesmo que gera o HTML final) com `url` vazia — sintoma de formato não reconhecido por nenhum branch de `parseListItems` (caso real: `docs/orchestrator-stage-narrative-history.md#stage-4-section-links-resolve-incident`, que explica também a diferença para os lints regex). Ação: reescrever o item em `02-reviewed.md` como `[Título](URL)` numa linha + descrição na linha IMEDIATAMENTE seguinte (sem blank line entre elas) — ver `context/templates/newsletter.md`.

`no-xml-artifacts` (#4077): **GATE-BLOCKING** quando exit 1 — tag de tool-call crua (`</content>`, `</invoke>`, `</function_calls>`) grudada no FIM do arquivo, sintoma de um payload de tool-call vazando num caminho de save assistido (ex: chat drawer do Studio editando `02-reviewed.md` via `Edit`/`Write` de um agente LLM). Caso real e relação com o strip do `saveReviewFile` na origem: `docs/orchestrator-stage-narrative-history.md#stage-4-xml-artifacts-caso-real`. Ação: remover manualmente o trecho de tag XML solta do fim de `02-reviewed.md` antes de aprovar o gate.

`banned-lexicon` (#7260): **GATE-BLOCKING** quando exit 1 — vocabulário PROIBIDO sem exceção legítima conhecida (tabela de substituições em `scripts/lib/lint-checks/banned-lexicon.ts`; hoje só "agentivo/agentiva/agentivos/agentivas" → "agêntico/agêntica/agênticos/agênticas", ver `context/editorial-rules.md` seção 5). Diferente de `title-mentions-ia` abaixo (WARN-ONLY, tem exceções legítimas), este é GATE-BLOCKING porque a forma banida nunca é a palavra certa (histórico: `docs/orchestrator-stage-narrative-history.md#stage-4-banned-lexicon-7260`). Ação: substituir a forma banida pela correta em `02-reviewed.md` antes de aprovar.

`snippet-staleness` (#4076): **WARN-ONLY** — um snippet de `data/snippets/` que ENTROU nesta edição (bloco PARA ENCERRAR, sempre; box de agradecimento a apoiadores, quando preenchido; boxes de divulgação dos slots 0/1/2/3 que de fato aparecem no `02-reviewed.md` atual — slot 0 desde #4274 — ver doc de `resolveUsedSnippets` em `scripts/lib/lint-checks/snippet-staleness.ts` para a lógica exata de "usado nesta edição") — ou `platform.config.json > boxes_divulgacao` quando algum desses slots está engajado — foi editado DEPOIS do `stitch-newsletter.ts` (Stage 2) já ter rodado. A mudança fica presa no snippet-fonte: `02-reviewed.md` já foi escrito antes e não é regenerado automaticamente (caso real: `docs/orchestrator-stage-narrative-history.md#stage-4-snippet-staleness-caso-real`). Deliberadamente **nunca bloqueia o gate nem reaplica automaticamente**: reaplicar sozinho arriscaria clobberar uma edição legítima que o editor tenha feito direto em `02-reviewed.md` (mesmo racional do warn-before-save do Studio, #3729). Exibir cada warning no `{violations_block}` como:
```
⚠️ snippet '{arquivo}' foi editado APÓS o stitch — a mudança NÃO está em 02-reviewed.md.
   Reaplique manualmente ou re-rode o Stage 2.
```
Ação sugerida ao editor: reaplicar a mudança manualmente em `02-reviewed.md` (edição cirúrgica, #495) ou re-rodar `/diaria-2-escrita {AAMMDD} newsletter` para que o stitch releia o snippet atualizado.

Limitação conhecida (#4274): o lint não avisa mudança feita direto em `platform.config.json` → `para_encerrar.{slot_a,slot_b}` depois do stitch (detalhe: `docs/orchestrator-stage-narrative-history.md#stage-4-snippet-staleness-para-encerrar-4274`). Irmão (#4359): `agradecimento-hardcoded` lê `agradecimento-apoiadores.md` direto e acusa quando o placeholder `{apoiadores}` foi trocado por um nome real e nunca resetado (caso real: `docs/orchestrator-stage-narrative-history.md#stage-4-agradecimento-hardcoded-caso-real`) — `ok:false` só significa "hoje injeta um nome real", editor confirma se é apoiador NOVO ou reseta antes de aprovar.

`title-publisher-suffix` + `title-trailing-period` (#2664/#2672): **WARN-ONLY** — exibir matches como ⚠️ no `{violations_block}` com linha + sufixo/título, sem bloquear o gate. A normalização automática roda no Stage 1 (`enrich-inbox-articles.ts` → `normalizeItemTitle`); estes lints são backstop pré-gate para resíduos que escapam (títulos gerados pelo writer LLM ou curados pelo editor). O check de sufixo usa heurística de 1–4 palavras (pode ter falso-positivo em traço editorial legítimo) — por isso WARN, não BLOCK. Ação sugerida ao editor: remover o sufixo de veículo / ponto final em `02-reviewed.md` antes de aprovar.

`no-trailing-ellipsis` (#2881, estendido em #3196): **WARN-ONLY** — exibir matches como ⚠️ no `{violations_block}` com seção + linha + trecho final da descrição. Backstop para a sanitização automática que roda no Stage 1 (`enrich-inbox-articles.ts` → `sanitizeTrailingEllipsis`): muitos veículos truncam a própria meta-description com "…"/"..." e isso vaza pro item de RADAR/USE MELHOR/LANÇAMENTOS como se a frase tivesse sido cortada por nós. Deliberadamente estrito (qualquer descrição terminando em reticência, ignorando o sufixo `(N min)` do USE MELHOR, #3196); pode disparar junto com `truncated-secondary-item-summary` (#2596; diferença: `docs/orchestrator-stage-narrative-history.md#stage-4-no-trailing-ellipsis-3196`). Ação sugerida ao editor: reescrever a descrição em `02-reviewed.md` antes de aprovar. Irmão mais amplo — `pool-summary-quality` (#9358): **WARN-ONLY no Stage 4** — exibir matches como ⚠️ no `{violations_block}` com seção + linha + título + defeitos (resumo cortado em reticências, sem ponto final, curto/vago <80 caracteres, espaço antes de pontuação, rodapé do WordPress, descrição padrão do YouTube, emoji/links relacionados colados). O mesmo check já BLOQUEOU o sentinel da Etapa 2 (`reviewed-pool-summary-quality`), então o que aparece aqui é, em regra, texto que o editor mexeu depois — por isso não bloqueia (#7401). Ação sugerida: reescrever a descrição em `02-reviewed.md` com o fato central, se o editor concordar.

`mid-sentence-ellipsis` (#3196): **WARN-ONLY** — exibir matches como ⚠️ no `{violations_block}` com seção + linha + trecho da descrição. Backstop irmão de `no-trailing-ellipsis`, mas pro caso da reticência aparecer no MEIO da descrição (não só no fim) — sintoma de outlet (ex: G1) truncando a própria meta-description no meio da frase. Heurística ampla sem allowlist (mesma justificativa #2715): também pode disparar em reticência estilística legítima no meio de uma frase — o editor decide caso a caso. Ação sugerida: reescrever a descrição em `02-reviewed.md` antes de aprovar, se de fato for truncamento da fonte.

`radar-summary-matches-title` (#8594): **WARN-ONLY** — exibir matches como ⚠️ no `{violations_block}` com seção + linha + título + trecho da descrição. Heurística léxica (sobreposição de termos/entidades entre título+slug da URL e a descrição; digest com separadores " · "/" | "/" – " é suspeito): pega o caso em que o item de RADAR/LANÇAMENTOS/USE MELHOR saiu com o resumo de OUTRA matéria (edição 260921, Exame x TypeSafe/CNN). Também dispara em paráfrase legítima sem palavra em comum — o editor decide. Backstop do guard do Stage 1 (`enrich-inbox-articles.ts`), que só descarta summary com evidência positiva de troca (digest ou casa com outro item do lote) e restaura o original se o refetch falhar. Ação sugerida: conferir a descrição contra a matéria da URL e reescrever em `02-reviewed.md` se for de outro artigo.

`title-mentions-ia` (#4825): **WARN-ONLY** — exibir matches como ⚠️ no `{violations_block}` com destaque + linha + termo casado + título. Sinaliza título de DESTAQUE mencionando "IA"/"AI"/"inteligência artificial" — a newsletter é sobre IA, o termo raramente carrega informação nova no título e gasta caracteres do teto de 52. Sem allowlist (mesma justificativa #2715 dos irmãos acima): há exceções legítimas (manchete sobre a categoria em si, ambiguidade real sem o termo, nome próprio/citação/nome de produto — ver `context/editorial-rules.md` seção 5) frequentes o bastante pra um lint bloqueante virar atrito toda edição — o editor decide caso a caso. Ação sugerida: reescrever o título nomeando o agente concreto (empresa, modelo, produto) em vez da categoria, se não for uma das exceções.

`stacked-intro-callouts` (#2729): **WARN-ONLY** — exibir matches como ⚠️ no `{violations_block}` com as linhas dos blocos empilhados. Detecta ≥2 blocos `**(🎉|📣)…**` na região de intro (antes do 1º `**DESTAQUE`), que o parser funde num só (por quê: `docs/orchestrator-stage-narrative-history.md#stage-4-stacked-intro-callouts-severity`). Ação sugerida: mesclar os 2 CTAs num único bloco, ou mover o 2º para uma lacuna entre destaques (box de divulgação).

`orphan-box-in-gap` (#3204, #3476; slot 3 eliminado no #6748, o lint segue varrendo a região pós-último-destaque para box colado à mão): **GATE-BLOCKING** quando exit 1. O parser já acha o box por POSIÇÃO (bloco `---`-isolado numa lacuna D1/D2, D2/D3 ou depois do último destaque, sem allowlist de marcador; contexto: `docs/orchestrator-stage-narrative-history.md#stage-4-orphan-box-marcador-agnostico`). Este lint cobre os 2 jeitos de isso AINDA falhar silenciosamente: (a) um bloco com CARA de box (bold-line inteiro `**...**` OU parágrafo emoji-led) colado DENTRO da seção do destaque anterior, sem `---` isolando-o — não vira box, é absorvido no corpo/why do destaque (histórico: `docs/orchestrator-stage-narrative-history.md#stage-4-orphan-box-caso-real`); (b) uma lacuna/região com MAIS de 1 bloco `---`-isolado extra — ambíguo, só o 1º vira box, o(s) demais seria(m) descartado(s) em silêncio. Ação sugerida ao editor: isolar o box em sua PRÓPRIA seção, entre o `---` que fecha o destaque/box anterior e o `---` que abre o próximo — exatamente 1 bloco extra por lacuna/região. Gate só pode ser aprovado (`sim`) após lint verde (exit 0).

**Erro intencional ainda placeholder ao montar o gate (#5566):** ao ler `_internal/intentional-error.json` (§4c — sibling de `02-reviewed.md`, mesmo arquivo do #3222) pra este resumo, se algum dos 5 campos ainda contiver o placeholder literal `{PREENCHER}`, é sintoma de que o Stage 2 pulou a declaração do erro intencional (nenhum `--check` do agregador acima detecta isso: é leitura direta do JSON). **Se o Stage 4 precisar propor um candidato sozinho para preencher essa lacuna** (em vez de só perguntar em aberto), rodar PRIMEIRO `npx tsx scripts/propose-intentional-error-candidate.ts --edition-dir {EDITION_DIR}/` (#8592, gerador determinístico, nunca escreve em disco; exit 1 = histórico `data/intentional-errors.jsonl` ilegível, sem `candidate` — NUNCA propor como "já filtrado", avisar o editor no gate que a checagem de repetição não rodou, #10292) — `candidate` não-`null` já vem filtrado pelas 2 regras + 3 diretrizes abaixo (busca só em seção secundária, catálogo de grafias óbvias #5742) — apresentar direto ao editor como "aceito esta proposta / quero outra / vou escrever a minha" (mesmo texto de sempre), sem reaplicar o filtro manualmente. `candidate: null` (nenhuma entidade do catálogo mencionada numa seção secundária) é o único caso em que o Stage 4 monta a proposta na mão — **ANTES de propor, listar os erros da janela de 30 dias (#10244, mesma regra do #9101 que senão só barra DEPOIS da aprovação do editor):** `npx tsx scripts/propose-intentional-error-candidate.ts --edition-dir {EDITION_DIR}/ --list-recent`, e conferir cada grafia candidata e sua entidade com `--check-wrong "<grafia>" --check-correct "<entidade correta>"` (#12330; passar sempre os dois valores para detectar também entidade repetida com outra grafia) (`repeats` não-vazio = descartar e escolher outra; exit 1 = histórico `data/intentional-errors.jsonl` ilegível — NUNCA tratar como "sem repetição", avisar o editor no gate que a checagem não rodou, #10269). Aí sim aplicar OBRIGATORIAMENTE, antes de apresentar ao editor, as mesmas 2 regras invariáveis de `context/editorial-rules.md` §10 ("Concurso 'ache o erro' — regras do erro intencional") — Regra 1 (verificável SEM sair do email: inconsistência interna ou conhecimento comum do público; **proibido** um erro só confirmável clicando na fonte, ex: trocar número de uma pesquisa) e Regra 2 (não gerar desinformação: nunca um valor plausível-mas-falso que, se não pego, o leitor passa a acreditar) — **e** o filtro de 3 diretrizes já documentado em `.claude/agents/orchestrator-stage-2.md` §"Filtro de segurança ao PROPOR candidatos" (#3808): (1) nunca alterar um fato central de um DESTAQUE; (2) preferir erro cômico/leve (trocadilho, ortográfico bobo, nome trocado óbvio) a inflação de magnitude sobre um fato real; (3) preferir plantar em menção lateral/secundária, não na frase que carrega a informação principal (casos reais, 260818 e 260820: `docs/orchestrator-stage-narrative-history.md#stage-4-erro-intencional-propostas-5566-5742`). **Padrão de maior taxa de aceite (#5742):** erro ortográfico bobo em nome de entidade MUITO conhecida do público, mencionado dentro do próprio corpo da edição (ex: "Anthropik" em vez de "Anthropic") — passa nas duas regras de saída, ao contrário de numérico/data/nome-próprio-externo. Ação: preencher os campos faltantes em `_internal/intentional-error.json` (via chat com o editor, aplicando o filtro acima antes de propor) antes de aprovar o gate.

**4c.2b — Lint social + consistência post_pixel + sentinel humanizador (#2145, #2279):**
```bash
npx tsx scripts/lint-social-md.ts --stage 4 --json --edition-dir {EDITION_DIR}
```
(#5416) Agregador dos checks de `lint-social-md.ts` (histórico: `docs/orchestrator-stage-narrative-history.md#stage-4-lint-agregador-5416`). Output (stdout): JSON `{ stage: 4, passed: boolean, checks: [{ id, source_issue, severity, ok, result }, ...] }`. `passed` já reflete "nenhum check falhou" — todos os `id` deste stage (6 desde `curto-x-weight` #10180) são `gate-blocking` (não há warn-only em §4c.2b). Pra cada `checks[]` com `ok:false`, tratar como ❌ (mesma ação descrita no parágrafo do check correspondente abaixo, indexado pelo `id`). Debug de 1 check isolado (`--check X --md {EDITION_DIR}/03-social.md`) continua funcionando exatamente como antes (modo aditivo, não removido).

`post_pixel-matches-d1` (#1861): compara tokens (Jaccard) do `## post_pixel` com o main de cada `## d{N}`. Falha quando post_pixel é claramente mais parecido com outro destaque que com o D1 vigente. Sinal de que houve reordenação pós-Stage-2 sem re-sincronizar o post pessoal. **GATE-BLOCKING** — ❌ mostrar no resumo com ação: "post_pixel stale — re-sincronizar com D1 atual antes de aprovar". Gate só pode ser aprovado (`sim`) após lint verde.

`no-xml-artifacts` (#4118 finding 2, #4077): **GATE-BLOCKING** — mesmo backstop já aplicado a `02-reviewed.md` (§4c.2 acima), agora também em `03-social.md`: tag de tool-call crua (`</content>`, `</invoke>`, `</function_calls>`) grudada no FIM do arquivo, sintoma de um payload de tool-call vazando num caminho de save assistido (ex: chat drawer do Studio). `saveReviewFile` (`scripts/studio-ui/studio-review.ts`) já strippa esse mesmo padrão pra TODOS os slugs (inclusive `social`) ANTES de escrever em disco — este lint é o backstop independente da causa. Ação: remover manualmente o trecho de tag XML solta do fim de `03-social.md` antes de aprovar o gate.

`banned-lexicon` (#7260): **GATE-BLOCKING** — mesmo backstop já aplicado a `02-reviewed.md` (§4c.2 acima), agora também em `03-social.md`: vocabulário PROIBIDO sem exceção legítima conhecida (tabela em `scripts/lib/lint-checks/banned-lexicon.ts`, ver `context/editorial-rules.md` seção 5). Ação: substituir a forma banida pela correta em `03-social.md` antes de aprovar o gate.

`curto-x-weight` (#10180): **GATE-BLOCKING** — cada post da seção `# Curto` (`## d1`/`## d2`/`## d3` e o `## um`, 4º post USE MELHOR) tem que caber nos 280 do X pelo MESMO peso do Stage 5 (`computeTwitterWeightedLength`, `scripts/lib/twitter-weight.ts`: URL e `{edition_url}` contam 23; no `## um` a linha `{quebra}` vira linha em branco). Acima disso o `prep-twitter-posts.ts` pula o post no X sem truncar (caso real 261014: `## um` com 283). `result.errors[]` diz qual post excede e quantos caracteres cortar. Ação: encurtar só aquele post em `03-social.md` (edição cirúrgica, #495) e regravar o selo do humanizador (`check-humanizer-social.ts --write`) antes de aprovar. **Reescrita feita dentro do gate (#11124):** o mesmo cálculo também é invariante do Stage 4 (`curto-x-weight` no `check-invariants --stage 4`), então o `pipeline-sentinel.ts write --step 4` recusa o sentinel se um `ajustar`, uma edição puxada do doc ou o fast-path do painel deixou um post do `# Curto` acima de 280 (caso real 261026: D1 reescrito no gate, 287). Lead/ângulo reescrito no gate: conferir o `# Curto` do destaque antes do `sim`.

`no-antithesis-reveal` (#2526) — **GATE-BLOCKING desde #4352:** detecta construções de "negar pra revelar" que soam a IA (ex: "não é X, é Y", "de verdade, não só", "o que me chama atenção não é..."). ❌ mostrar no resumo com ação: "reescreva a frase direto, sem negar pra revelar, antes de aprovar". Gate só pode ser aprovado (`sim`) após lint verde. Promovido de WARN-ONLY no #4352 (caso real: `docs/orchestrator-stage-narrative-history.md#stage-4-antithesis-reveal-promotion`).

`no-trailing-editorial-hook` (#2658) — **GATE-BLOCKING desde #4352:** primo de #2526, detecta ", e [gancho editorial]" emendado no fim de uma frase (ex: "...entrou em prévia, e a escolha de focos diz mais sobre estratégia do que os benchmarks costumam revelar"). ❌ mostrar no resumo com ação: "mover o gancho pro corpo ou cortar a oração emendada, antes de aprovar". Gate só pode ser aprovado (`sim`) após lint verde. Promovido de WARN-ONLY no #4352, mesmo racional do check acima (por que a chamada é explícita, #2715: `docs/orchestrator-stage-narrative-history.md#stage-4-trailing-hook-2715`).

**Guard determinístico do humanizador social (#2279, #2529):**
```bash
npx tsx scripts/check-humanizer-social.ts --check --edition-dir {EDITION_DIR}/
```
Exit code handling:
- `0` → humanizador rodou e `03-social.md` não foi editado depois. Continuar.
- `1` → **GATE-BLOCKING:** sentinel ausente — humanizador não rodou no social ou sentinel não foi gravado. Ação: re-rodar humanizador, depois `--write`, antes de aprovar.
- `2` → **GATE-BLOCKING:** `03-social.md` foi editado/reordenado após humanização (hash diverge — caso real: edição inline em §4d.1 ou reorder de destaques).

  **#2529 — Tic lint automático no exit 2:** quando o hash diverge, o guard roda automaticamente `lintAntithesisReveal` sobre o `03-social.md` atual e emite WARNs adicionais no stderr. Se o stderr contiver `⚠️  TICS DE IA DETECTADOS`, incluir esses tics no bloco `{violations_block}` do gate como `⚠️ Social editado pós-humanizador acusa tics de IA (lista abaixo) — considere re-humanizar`. Se o stderr contiver apenas `ℹ️  Lint de tics: nenhum tic detectado`, a edição pode ter sido só remoção de tic — apresentar essa informação ao editor para auxiliar a decisão. O evento é sempre logado no run-log automaticamente. **Nota (#4352):** esta chamada interna é informativa; o bloqueio dos tiques vem das chamadas explícitas de §4c.2b acima (`no-antithesis-reveal`/`no-trailing-editorial-hook`), que rodam sempre (motivo: `docs/orchestrator-stage-narrative-history.md#stage-4-tic-lint-informativo-4352`).

  **Re-selar ou re-humanizar antes de aprovar** (exit 2, com ou sem tics) — **§4d.1 passo 6** (`orchestrator-stage-4-gate.md`; receita K): correção pequena do editor/pipeline usa `--reseal-surgical` (passo 6.0, #13929); o resto, SCOPED/FULL-FILE (#3446). O `{ legacy, changed_sections }` do `--check` acima serve direto.

**Proveniência do social no resumo do gate (#11534):** a cada apresentação do gate, rodar `npx tsx scripts/check-humanizer-social.ts --provenance --edition-dir {EDITION_DIR}/` e incluir as linhas do stderr (`main_d1: humanizador sim · Clarice sim`, etc.) no resumo. Seção com `NÃO`, `PENDENTE` ou `aceita sem prova (--unproven-ok)` vai como ⚠️ nomeando a seção — o editor vê o que não passou por humanizador e Clarice em vez de descobrir perguntando. **Clarice pendente no social (#13848):** seção com `Clarice PENDENTE (motivo)` (invariante `social-clarice-pending`, warning) vai junto da linha `⚠️ clarice não rodou` da newsletter, com o mesmo trato: o editor decide entre aprovar sem a Clarice ou esperar a API. Informativo, nunca bloqueia (o bloqueio é o exit 4 do `--write`). **Clarice pendente na newsletter (#12257):** se o invariante `clarice-pending` (warning) acusar, o `resume` de §4a não aplicou a Clarice. Pôr a linha `⚠️ clarice não rodou ({motivo})` no topo do resumo do gate, com o desfecho do `resume` (exit e motivo do stderr); o editor decide entre aprovar sem a Clarice ou esperar a API. Não rodar o `resume` aqui: depois do fact-check e dos lints, o texto que eles checaram mudaria sem ninguém conferir de novo. **"Esperar a API" = voltar ao §4a:** rodar o `resume` de novo (com `--retry-now` se a última tentativa falhou há menos de 20 min, senão ele devolve o mesmo exit sem chamar a Clarice) e, com a Clarice aplicada (exit 0/13), refazer o Stage 4 do §4b em diante (pré-render, lints, fact-check, resumo) antes de reapresentar o gate.

**4c.3 — Imagens geradas:**
- Listar `04-d1-2x1.jpg`, `04-d2-2x1.jpg`, `04-d3-2x1.jpg` e os cards `04-d{N}-4x5.jpg` com tamanhos (bytes; o 1:1 deixou de ser gerado no #12226) e, por destaque, quantos dos 4 slides do carrossel do Instagram existem (`04-d{N}-carousel-{p1,p2,p3,cta}-4x5.jpg`, #6005 Parte B) — são 12 imagens por edição de 3 destaques que, sem esta linha, o editor só veria depois de publicadas (#6064 item 3). Formato sugerido: `d1: 4/4 · d2: 4/4 · d3: 4/4 (capa = 04-d{N}-4x5.jpg)`; contagem parcial significa que aquele destaque publica como post single-image (carga tudo-ou-nada, `resolveCarouselImageUrls`) — cruzar com o warning `carousel-upload-incomplete` do `{violations_block}`.
- URL pública no Worker KV: `{newsletter_url}` (capturada em §4b step 2b).

**4c.4 — Social preview:**
- Social preview URL: `{social_url}` (de `_internal/05-social-preview.json`).
- Ler `03-social.md` para exibir os títulos dos 3 textos genéricos (d1/d2/d3, #3991 — texto único LinkedIn/Facebook/Instagram) + `## um` (4º post, #9568; `post_pixel` só em edição antiga) em tabela.

**4c.5 — Diffs vs fonte (#1694 — novo no Stage 4):**
- Comparar os títulos finais em `02-reviewed.md` com os títulos originais em `_internal/01-approved.json` para mostrar se houve mudança editorial.
- Informativo — sem bloqueio.

**4c.6 — Fact-check de claims (#2455):**

Disparar o subagente `fact-checker` em paralelo com (ou logo após) os lints acima:

```bash
# 1. Validar pré-condições e obter parâmetros para o subagente:
npx tsx scripts/run-fact-checker.ts --edition-dir {EDITION_DIR}/
```

Em seguida, despachar o subagente `fact-checker` via Agent tool com os parâmetros:
```
Agent("fact-checker", {
  newsletter_path: "{EDITION_DIR}/02-reviewed.md",
  social_path: "{EDITION_DIR}/03-social.md",
  approved_json_path: "{EDITION_DIR}/_internal/01-approved.json",
  out_path: "{EDITION_DIR}/_internal/fact-check.json"
})
```

**Escopo (#14035): seguir o que o passo 1 imprime.** `COMPLETO`: dispatch acima. `PARCIAL`: dispatch com `units: [lista]` e `out_path` `_internal/fact-check.partial.json`; passo 2 com `--merge-partial`; `recusado` (exit 4 do composto): passo 1 com `--full`, refazer completo. `NENHUMA`: só o passo 2. Contrato: `docs/fact-check-incremental.md`.

**Fallback de ENOENT sob a junction OneDrive (#5083).** O subagente pode reportar que o Write direto em `_internal/fact-check.json` falhou com `ENOENT` (harness, ver `.claude/agents/fact-checker.md` §4) e gravou o JSON no scratchpad da própria sessão em vez disso. Se isso acontecer, passar o path reportado em `--copy-from` no passo 2 abaixo (o composto copia para `{EDITION_DIR}/_internal/fact-check.json`; o top-level não sofre do mesmo bug). **Retry automático em erro de rede/API (#8996):** se o dispatch do Agent `fact-checker` EM SI (não `run-fact-checker.ts`) falhar com erro de API/rede (ex: `API Error: Can't reach the API server (ENOTFOUND)`, timeout, 5xx — achado ao vivo edição 260929), fazer 1 retry automático do mesmo dispatch antes de desistir; se o retry também falhar, montar a mensagem do gate com `npx tsx scripts/run-fact-checker.ts --unavailable-message --reason "{erro}" --network-error` em vez do texto genérico do exit 1 abaixo (não-bloqueante em ambos os casos — só a redação muda).

Após o subagente concluir, o passo 2 é um comando composto (#14116): numa chamada, `run-fact-checker.ts --input-json … --check-blocking` (#4361; formata o gate summary), o autofix de §4c.6b e as re-checagens de §4c.6c. Uma linha JSON no stdout: `fact_check.summary` (seção do gate) e `.stderr`, `autofix`, `rerender` (`newsletter`/`social`), `checks[]`.
```bash
# 2. Check-blocking + autofix + re-checagens pós-autofix:
npx tsx scripts/stage4-factcheck-post.ts --edition-dir {EDITION_DIR}/ [--merge-partial] [--copy-from {path}]
```

**Exit code handling** (o composto devolve um exit por desfecho; os comandos individuais citados nesta seção seguem válidos como fallback):
- `0` → incluir `fact_check.summary` na seção `━━━ FACT-CHECK` do gate e seguir com o JSON para §4c.6b.
- `3` (`FACT-CHECK DEFASADO (#11685)` em `fact_check.stderr`) → **não é o "indisponível" comum:** claim bloqueante sumiu do texto depois da checagem (removido ou REESCRITO, ex.: número trocado) e nunca foi checado de novo. **NÃO montar o gate ainda.** Ação: re-despachar o subagente `fact-checker` (passo 1 acima) **uma única vez** e rodar o passo 2 de novo. Se depois desse re-despacho ainda sair exit 3 (DEFASADO), não abrir nova iteração: montar o gate com `⚠️ Fact-check defasado — verificar manualmente antes de publicar.` no lugar do bloco de fact-check. Se o próprio re-despacho falhar (erro de API/rede), vale o caminho do #8996 acima (1 retry do dispatch, depois a mensagem de indisponível via `--unavailable-message`), nunca uma nova volta deste loop. Em `auto_approve` não seguir para a Etapa 5 com este exit 3 (ver parágrafo `--no-gates` abaixo).
- `1` (demais casos) → fact-checker não rodou (pré-condição falhou ou arquivo ausente) → mostrar `⚠️ Fact-check indisponível: {motivo do stderr}` no gate (ou a mensagem `--network-error` do parágrafo acima, se for esse o motivo). **Não bloquear** — fact-check é assistido, não gate-blocking.
- `2` → **GATE-BLOCKING (#4361):** ao menos 1 claim `NOT_FOUND_IN_SOURCE` não-superlativo (`getBlockingClaims`) — a fonte primária foi verificada com sucesso e o claim simplesmente não está lá (caso real: `docs/orchestrator-stage-narrative-history.md#stage-4-fact-check-caso-real`). **NÃO montar o gate ainda.** Ação: ler os claims no stderr (D{N} + texto + note), reescrever/remover o claim de `02-reviewed.md`/`03-social.md` (ou achar suporte adicional na fonte — se o fato vem de OUTRA fonte da mesma história, indicada pelo editor ou achada por você, registrá-la com `npx tsx scripts/add-destaque-source.ts --edition-dir {EDITION_DIR}/ --destaque N --url {URL}` e redespachar o fact-checker, nunca editar `d{N}.txt` à mão, #11531), re-rodar o fact-checker até o composto sair `0` ou `1`, antes de §4c.6b. Escopo estreito de propósito (não over-broaden, #4361): exclui `claim_type: "superlative"` (mais subjetivo, continua informativo) e `DIVERGENT`/`SUSTAINED`/`INFERRED`/`SOURCE_UNREACHABLE` (DIVERGENT já é auto-corrigido em §4c.6b; os demais não confirmam ausência).
- `4` → `--merge-partial` recusado (#14035): passo 1 com `--full` e refazer completo.
- `5` → o autofix quebrou uma re-checagem de §4c.6c (`checks[]` com `code ≠ 0`): ver "Exit code handling" de §4c.6c.
- `7` → JSON do autofix ausente/ilegível (`autofix.unreadable`), ou autofix ≠ 0 depois de gravar o texto (`autofix.wrote_before_failure`, #14174): bloqueia; re-rodar o autofix, conferir o diff.

**Fact-check defasado (#11671):** `--input-json` carimba `fact-check.json` com o hash de `02-reviewed.md`/`03-social.md` na 1ª passada e preserva o carimbo nas seguintes. Se o texto mudou depois da checagem, o stdout traz `Fact-check DEFASADO` (aviso, nunca bloqueio por si só): claim bloqueante cujo trecho sumiu do texto atual sai do exit 2; o que ainda aparece segue bloqueando. Se sobrar só claim sumido (nenhum ainda presente), o `--check-blocking` sai com exit 1 + `FACT-CHECK DEFASADO (#11685)`, nunca exit 0 — "sumiu" também é o claim reescrito sem re-checagem; tratar como no exit 3 acima. Re-despachar o fact-checker antes de aprovar o gate.

**Comportamento em `auto_approve = true` (`--no-gates`):** executar normalmente (grava `_internal/fact-check.json`, roda `--check-blocking`), mas pular a apresentação no gate (que é pulado inteiramente). **O exit 2 (GATE-BLOCKING) ainda vale** — mesmo sem gate visual, o orchestrator não pode prosseguir para Etapa 5 com um claim NOT_FOUND_IN_SOURCE não resolvido; parar e renderizar halt banner (mesmo padrão do #738) explicando o motivo, já que não há editor no gate pra decidir aqui. **O exit 3 (DEFASADO) também vale aqui:** re-despachar o fact-checker e repetir o passo 2; se depois disso ainda sair exit 3 ou 2, parar com halt banner em vez de seguir para a Etapa 5 (sem editor, ninguém leria o aviso). O arquivo fica disponível para auditoria pós-edição em qualquer caso.

**4c.6b — Auto-fix de DIVERGENT determinístico (#2598, estendido a social em #3224):**

O composto do passo 2 (§4c.6) já aplicou as correções automáticas de claims `DIVERGENT` com `suggested_fix` (`apply-factcheck-autofix.ts --edition-dir {EDITION_DIR}/`, mesmo script, só que rodado por ele): o desfecho está em `autofix` do JSON e em `_internal/fact-check-autofix.json`. `autofix.code` = `1` com o composto em exit 0 → logar warn; seguir sem auto-fix (não bloqueia o gate).

**⚠️ Re-render obrigatório quando `applied > 0` (`rerender.newsletter`, #2617):** o pré-render de §4b gerou `newsletter-final.html` ANTES do autofix. Nesse caso, re-rodar render + substitute para garantir que o HTML reflita o texto corrigido, e republicar o preview:

```bash
# Re-render newsletter HTML com o 02-reviewed.md já corrigido
npx tsx scripts/render-newsletter-html.ts {EDITION_DIR}/ --format html --out {EDITION_DIR}/_internal/newsletter-draft.html
npx tsx scripts/substitute-image-urls.ts \
  --html {EDITION_DIR}/_internal/newsletter-draft.html \
  --out {EDITION_DIR}/_internal/newsletter-final.html \
  --images {EDITION_DIR}/06-public-images.json
```

Exit codes de `substitute-image-urls.ts` (#2316, #2335) — mesma tabela de §4b.

**Re-render também o preview de MEDIÇÃO do Kit (#6506)** — mesmo motivo do `newsletter-final.html` acima (`_internal/newsletter-final-kit.html`, §4b step 2a-kit, foi gerado ANTES do autofix): `npx tsx scripts/render-kit-html-preview.ts {EDITION_DIR}/`.

**⚠️ Atualizar `{newsletter_url}` após o re-render:** o conteúdo mudou → o preview local servido em §4b step 2b fica STALE. Re-servir ANTES de montar o gate (§4c.7) — senão o editor abre o preview antigo (texto PRÉ-correção) e aprova conteúdo que não revisou. **Re-servir localmente (#3546 — mesmo padrão do §4b step 2b: encerrar o servidor antigo, re-gerar a variante embedded, subir um novo):**
```bash
# Encerra o servidor de preview anterior (PID gravado em 04-newsletter-url.json).
OLD_PID=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('{EDITION_DIR}/_internal/04-newsletter-url.json','utf8')).newsletter_url_pid||'')}catch(e){}")
[ -n "$OLD_PID" ] && npx tsx scripts/serve-preview.ts --stop-pid "$OLD_PID"

npx tsx scripts/embed-images-base64.ts --require-all-embedded \
  --html {EDITION_DIR}/_internal/newsletter-final.html \
  --images {EDITION_DIR}/06-public-images.json \
  --edition-dir {EDITION_DIR}/ \
  --out {EDITION_DIR}/_internal/newsletter-final-embedded.html

npx tsx scripts/serve-preview.ts \
  --file {EDITION_DIR}/_internal/newsletter-final-embedded.html --port 0 --watch --edition {AAMMDD} \
  --persist-to {EDITION_DIR}/_internal/04-newsletter-url.json --field newsletter_url --detach
```
Rodar o `serve-preview.ts` final em foreground com `--detach` (nunca `run_in_background`/`&`, #9678 — mesmo motivo do §4b step 2b). Re-ler `newsletter_url` de `04-newsletter-url.json` e atualizar a variável `{newsletter_url}` do gate. **Re-publicar o Artifact também (#6003)** — mesmo `file_path` do step 2b (redeploy pra MESMA URL). Atualizar `{newsletter_artifact_url}` em `04-newsletter-url.json`; warning-only.

**⚠️ Re-render do social quando `social_modified === true` (#3224):** claims com `sources` incluindo `"social"` agora também são corrigidos em `03-social.md` (nos blocos `## dN`, LinkedIn e Facebook — ver "O que é auto-corrigido" abaixo). O script já regrava `_internal/.humanizer-social-done.json` internamente com `bypassReason` explícito (reusa `writeSentinel` de `check-humanizer-social.ts`, mesmo mecanismo do #2529) — **não é preciso rodar `check-humanizer-social.ts --write` manualmente**. **Resíduo (#9400):** se `summary.social_residual > 0`, o claim sobrou com outra redação nas seções listadas em `entries[].social_residual_sections` (ex: `Curto/d1`) — o script não reescreve paráfrase; listar essas seções no resumo do gate pro editor corrigir à mão. Mas o pré-render de §4b step 3 (`social-preview.html`) foi gerado ANTES do autofix, então se `_internal/fact-check-autofix.json` mostra `social_modified: true`, re-renderizar e republicar:

```bash
# Re-render social HTML com o 03-social.md já corrigido
npx tsx scripts/render-social-html.ts --md {EDITION_DIR}/03-social.md --out {EDITION_DIR}/_internal/social-preview.html --images {EDITION_DIR}/06-public-images.json

# Encerra o servidor de preview social anterior (PID gravado em 05-social-preview.json).
OLD_PID=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('{EDITION_DIR}/_internal/05-social-preview.json','utf8')).social_preview_url_pid||'')}catch(e){}")
[ -n "$OLD_PID" ] && npx tsx scripts/serve-preview.ts --stop-pid "$OLD_PID"

npx tsx scripts/embed-images-base64.ts --require-all-embedded \
  --html {EDITION_DIR}/_internal/social-preview.html \
  --images {EDITION_DIR}/06-public-images.json \
  --edition-dir {EDITION_DIR}/ \
  --out {EDITION_DIR}/_internal/social-preview-embedded.html

# Serve localmente (atualiza a URL/PID persistidos em 05-social-preview.json com o novo conteúdo)
npx tsx scripts/serve-preview.ts \
  --file {EDITION_DIR}/_internal/social-preview-embedded.html --port 0 --watch --edition {AAMMDD} \
  --persist-to {EDITION_DIR}/_internal/05-social-preview.json --field social_preview_url --detach
```
(#3546 — mesmo padrão stop-old → embed → serve-new de §4b step 3 / §4c.6b acima.) **Re-publicar o Artifact social também (#6003)** — mesmo `file_path` do step 3, redeploy pra mesma URL; atualizar `{social_artifact_url}` em `05-social-preview.json`, warning-only.

Confirmar que o sentinel bate com o social corrigido: o composto já rodou (`check-humanizer-social.ts --check`, item `humanizer-social-check` de `checks[]`; deve dar 0, o próprio autofix regravou). Se o código não for 0 ali (ex: `writeSentinel` falhou e o script apenas logou warn — ver stderr de `apply-factcheck-autofix.ts`), tratar como o exit 2 padrão de §4c.2b (re-humanizar e re-selar antes do gate).

**4c.6c — Re-validar lints estruturais pós-autofix (#3306):**

O autofix acima usa `replaceAll` no escopo do destaque/seção (#3274/#3275) — o `suggested_fix` é texto bruto do fact-checker LLM, sem consciência de markdown/estrutura. Uma correção pode reescrever mais do que o esperado e quebrar um invariante que os lints de §4c.2/§4c.2b passaram intactos ANTES do autofix rodar; este passo re-roda os lints estruturais que operam sobre texto de destaque.

O composto do passo 2 (§4c.6) roda SOMENTE os lints do arquivo que o autofix de fato tocou, e devolve cada um em `checks[]` (saída só dos que falharam):

- `summary.applied > 0` (newsletter): `lint-newsletter-md.ts --check callout-placement` em `02-reviewed.md` (mesma `lintCalloutPlacement` de #3282, já usada por `orphan-box-in-gap` em §4c.2 — só a estrutura do callout).
- `social_modified === true`: `lint-social-md.ts --check` `post_pixel-matches-d1`, `linkedin-page-link`, `platform-headers-unicos`, `no-antithesis-reveal` e `no-trailing-editorial-hook` em `03-social.md` (#4352 item 2 — os 2 últimos são os tic-lints GATE-BLOCKING de §4c.2b: o autofix mexe no social DEPOIS do humanizador e pode reintroduzir um tique tipo "não é X, é Y").

Exit code handling — **GATE-BLOCKING**, mesmo padrão do `check-humanizer-social.ts --check`: se falhar, tratar como o exit 2 padrão de §4c.2b (re-corrigir e re-selar antes do gate, nunca deixar a violação vazar pro resumo do editor). Para re-rodar um lint isolado: `npx tsx scripts/lint-social-md.ts --check {lint} --md {EDITION_DIR}/03-social.md` (ou `lint-newsletter-md.ts` no `02-reviewed.md`).
- composto com exit `0` → continuar.
- exit `5` (algum `checks[]` com `code ≠ 0`) → **GATE-BLOCKING.** O autofix quebrou um invariante estrutural que sobrevivia intacto antes da correção. NÃO montar o gate ainda. Ação:
  1. Ler o output do lint (linha + contexto da violação) e o `entry` correspondente em `_internal/fact-check-autofix.json` (mesmo `destaque`/`suggested_fix`) para identificar qual correção causou a quebra.
  2. Corrigir cirurgicamente (#495 — `Edit` com `old_string` mínimo, nunca substituir blocos grandes) o arquivo afetado, preservando o valor factual já corrigido mas restaurando a estrutura esperada pelo lint (callout isolado por `---`, ou bloco `post_pixel`/link do LinkedIn realinhado).
  3. Re-rodar o lint que falhou até sair `0`.
  4. Se a correção cirúrgica tocou `03-social.md`: re-humanizar + re-selar sentinel (mesmo fluxo do exit 2 de §4c.2b, incluindo os lints de qualidade social) antes de prosseguir.
  5. Re-renderizar o(s) arquivo(s) tocado(s) (newsletter e/ou social, §4b steps 2/3) e re-upload pro Worker Cloudflare (§4c.6b) antes de seguir pro gate — capturar a nova URL (content-hash muda a cada re-upload).

**Comportamento em `auto_approve = true` (`--no-gates`):** mesma execução e mesmo bloqueio — GATE-BLOCKING vale igual mesmo sem apresentação visual do gate; o orchestrator não pode prosseguir pra Etapa 5 com um invariante estrutural quebrado só porque o gate humano foi pulado.

**O que é auto-corrigido:**
- Apenas claims `DIVERGENT` com `suggested_fix` (valor correto determinístico extraído verbatim da fonte).
- `02-reviewed.md` (newsletter) e/ou `03-social.md` (social), conforme `entry.sources` do claim — `["newsletter"]`, `["social"]` ou `["newsletter","social"]` (#3224). Em social, a correção é scoped aos blocos `## dN` e aplicada em AMBOS os canais (LinkedIn + Facebook) quando o texto aparece nos dois — e, pra destaque 1, também em `## post_pixel` (post pessoal standalone do Pixel, sempre sobre D1, #3274), já que é seção IRMÃ de `## d1` sujeita à mesma claim. Sucesso parcial é possível e fica registrado em `files_modified` + `note` da entry (ex: achou na newsletter mas não em social).
- Nunca `claim_type: "superlative"` — ineditismo/tom é revisão editorial, não auto-fix.
- Nunca `NOT_FOUND_IN_SOURCE` — ausência de suporte não implica valor correto.
- Nunca o destaque do `intentional_error` declarado em `_internal/intentional-error.json` (#3222) — preserva o erro intencional proposital (vale para newsletter E social).
- Substituição scoped ao bloco do destaque correto — evita clobberar erros intencionais de outros destaques com mesmo texto.
- Correção em `03-social.md` regrava automaticamente o sentinel do humanizador com `bypassReason` (evita falso-alarme de "social editado sem re-humanizar" no próximo `check-humanizer-social.ts --check`).

**No gate:** apresentar como "já corrigido (diff X→Y) — confirme ou reverta". Se `fact-check-autofix.json` mostra `summary.applied > 0`, incluir bloco no gate (antes do `{fact_check_block}`):

```
━━━ FACT-CHECK AUTO-CORRIGIDO (#2598/#3224) ━━━━━
  ✅ {N} correção(ões) aplicada(s) automaticamente:
    D{N} [{tipo}] "{texto_original}" → "{suggested_fix}" ({arquivo(s)})
  Para reverter: editar o arquivo e usar a opção "ajustar" no gate.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Resíduo (#9400), independente de `applied`/`social_modified`:** se `summary.social_residual > 0`, mostrar no gate (mesmo sem nenhuma correção aplicada) a linha `⚠ Claim ainda presente com outra redação em 03-social.md: {seções} — corrigir à mão` para cada entry com `social_residual_sections`. Em `--no-gates`, registrar essas seções no relatório da edição.

`{arquivo(s)}` = `entry.files_modified.join(", ")` — `newsletter`, `social`, ou `newsletter, social`. Isso já deixa explícito no gate quando uma correção social foi aplicada, sem bloco separado — se `social_modified === true`, acrescentar uma linha informativa: `📱 Social também corrigido — preview social republicado.`

**Comportamento em `auto_approve = true` (`--no-gates`):** executar normalmente (aplica as correções, grava `_internal/fact-check-autofix.json`, re-renderiza/republica newsletter e social se aplicável); o gate é pulado.

**4c.6d — Critic pass social opcional (#4505 item 3):**

Passo OPCIONAL — só roda quando `platform.config.json` → `social_critic_pass.enabled === true` (default `false`). Fecha a lacuna que os tic-lints determinísticos de §4c.2b/§4c.6c não cobrem: eles pegam só 2 padrões via regex; este passo faz 1 leitura holística do catálogo inteiro de tiques da skill `humanizador` sobre o `03-social.md` JÁ FINAL (depois do autofix de §4c.6b/6c e de qualquer correção estrutural).

```bash
npx tsx scripts/run-social-critic.ts --edition-dir {EDITION_DIR}/
```
Exit code handling:
- `2` → desabilitado (default) — pular inteiramente, sem log de erro nem menção no gate.
- `1` → `03-social.md` ausente (não deveria acontecer nesta altura) — logar warn, pular.
- `0` → stdout traz `{edition, social_path, out_path}`. Dispatchar o subagente:
  ```
  Agent("social-critic", {
    social_path: "{EDITION_DIR}/03-social.md",
    edition: "{AAMMDD}",
    out_path: "{EDITION_DIR}/_internal/social-critic.json"
  })
  ```
  Após o subagente gravar o resultado, formatar e persistir:
  ```bash
  npx tsx scripts/run-social-critic.ts --edition-dir {EDITION_DIR}/ \
    --input-json <path-do-output-do-subagente>
  ```
  Capturar stdout (`━━━ CRITIC PASS SOCIAL`) → `{social_critic_block}`, incluído no gate logo após `{fact_check_block}` (§4d). **Sempre exit 0 — warning-only, nunca bloqueia** (mesmo racional do `image-crop-reviewer`, #3951): findings viram `⚠️` informativo, decisão de re-humanizar fica com o editor.

**Comportamento em `auto_approve = true` (`--no-gates`):** roda normalmente se habilitado (mesmo custo, sem apresentação visual); nunca bloqueia o fluxo — coerente com "opcional" da issue #4505.

**4c.7 — Boxes de divulgação: o que foi aplicado + ranking de apoio (#4354/#4626):**

**#4626 — a seleção dos slots 1/2/3 já ACONTECEU no Stage 2** (`resolveBoxesForEdition` dentro de `stitch-newsletter.ts`, automática por padrão — ver §2 de `orchestrator-stage-2.md`). Este passo só EXIBE o que foi decidido, não decide nada aqui. Ler `_internal/box-selection.json` (gravado pelo Stage 2; ausente em edições retomadas de um checkpoint anterior ao #4626 — nesse caso, pular esta exibição sem erro) e montar 1 linha por slot:

- `mode: "auto"` → `Slot N: {nome do snippet} — auto-selecionado (score {score}, {editionsAppeared} edições{, tendência de queda se trend.declining}).`
- `mode: "pinned"` → `Slot N: {file} — pinado manualmente (boxes_divulgacao_auto.pinned_slots).`
- `mode: "fallback-no-candidates"` → `Slot N: {file} — mantido (sem dado suficiente pra seleção automática ainda).` · `mode: "fallback-ineligible"` (#9155) → `Slot N: vazio — fallback {rejectedFile} recusado ({rejectReason}: audiencia = outro canal, evento/duplicado = repete outro slot).`
- `mode: "disabled"` com `file` preenchido → `Slot N: {file} — seleção automática desligada (boxes_divulgacao_auto.enabled=false).` · `mode: "disabled"` com `file: null` (#9195) → slot INATIVO nesta edição, não automação desligada: slot 2 → `Slot 2: inativo nesta edição (sem D3).` (edição de 2 destaques, #9175); slot 3 → `Slot 3: eliminado (#6748).` Nunca imprimir `null` nem "seleção automática desligada" nesse caso.

Rodar também `scripts/box-click-report.ts` — ranking bruto de cliques por box nas últimas edições (contexto adicional, mesmo sem decidir nada):

```bash
npx tsx scripts/box-click-report.ts --last 20
```

Capturar os dois e incluir na seção `━━━ BOXES DE DIVULGAÇÃO` do gate (§4d): primeiro o que foi aplicado (`box-selection.json`), depois o ranking (`box-click-report.ts`) como contexto. **Puramente informativo — nunca bloqueia o gate.** Se o editor discordar da seleção automática, o override é editar `02-reviewed.md` diretamente (trocar o texto do box na lacuna) — não há confirmação/reversão automatizada aqui (decisão do editor #4626: sem gate novo). Exit code de `box-click-report.ts` sempre **não-fatal**: `0` → capturar stdout (ranking vazio é resultado válido); qualquer falha (`1` = `data/editions` ausente, ou exception) → `⚠️ Recomendação de boxes indisponível: {motivo}.`, sem halt banner (não depende de MCP, diferente do #738). `box-selection.json` ausente/corrompido → mesma tolerância, pular a linha correspondente sem bloquear. Em `--no-gates`: rodar normalmente (barato, só leitura de disco), pular só a apresentação.

**4c.8 — REMOVIDO (#7402).** Nada a exibir aqui (histórico: `docs/orchestrator-stage-narrative-history.md#stage-4-4c8-rampa-gmail-removida`).

**4c.9 — Refresh tardio: o que saiu depois da pesquisa (#9370) — informativo, nunca bloqueia, nunca altera a edição.** Rodar por último em §4c (o mais perto possível do gate): `npx tsx scripts/late-refresh-candidates.ts --edition-dir {EDITION_DIR}/` — feeds oficiais de laboratório (Anthropic, OpenAI, Google/DeepMind, Microsoft AI, Mistral, Meta; xAI/DeepSeek/Qwen pelo GitHub oficial da org — repos novos + releases estáveis, #9424, `docs/late-refresh-github-feeds.md`) + newsletters chegadas depois da captura do Stage 0 (Gmail REST, diretório próprio, sem tocar o cursor), deduplicados contra a edição e as anteriores, cada um com sugestão de substituição. Stdout = `{late_refresh_block}`; relatório em `_internal/04-late-refresh.json`. Exit ≠ 0 ou erro = `⚠️ Refresh tardio indisponível`, seguir. Incluir algo é decisão do editor (`ajustar`, ou §4d.1b se for destaque). **4c.10 — Títulos do D1 no YouTube (#12552) — informativo, nunca bloqueia, nunca altera título.** Logo depois, `npx tsx scripts/youtube-title-research.ts --edition-dir {EDITION_DIR}/ --approved {EDITION_DIR}/_internal/01-approved.json --gate-block --refresh-if-stale`. Lê `_internal/youtube-title-research.json` (gravado no passo 0c do Stage 2) e refaz a busca quando o arquivo não existe ou é de outro D1 (troca/promoção de destaque no gate). Stdout = `{youtube_titles_block}`: os termos que mais se repetem nos títulos de maior audiência dos últimos 4 dias, os 3 títulos de topo com canal e views e o lembrete de que é só vocabulário (termo que a fonte não sustenta não entra, #4000, #9383). Sem credencial, sem cota ou sem resultado, o próprio stdout traz a linha de aviso; exit ≠ 0 ou erro = `⚠️ Pesquisa de títulos no YouTube indisponível`, seguir. Usar o vocabulário no título é decisão do editor (`ajustar`); re-rodar este passo depois de um `ajustar` que trocou o D1.

### 4d em diante — gate humano e sentinel (arquivo próprio, #14033)

O gate humano (§4d), o loop `ajustar` (§4d.1, §4d.1a, §4d.1b), o sentinel (§4e) e a fronteira de contexto pós-gate vivem em **`.claude/agents/orchestrator-stage-4-gate.md`**. Ao terminar o §4c, **ler esse arquivo inteiro antes de montar o resumo do gate**. Vale também em `auto_approve = true` (`--no-gates`): o gate não é apresentado, mas o §4e (teardown, contagem da intro, revalidação do erro intencional, sentinel, `done`, release da trava) e a mensagem da fronteira pós-gate estão lá e são obrigatórios.

Durante o loop do gate, para achar o comando de um pedido do editor (trocar link, cortar ou mover item, reordenar, trocar destaque, reescrever social, refazer fact-check), consultar o cartão **`context/stage-4-gate-receitas.md`** em vez de reler os playbooks. O cartão cita a seção do arquivo do gate onde está a regra completa; quando os dois divergirem, vale o playbook.
