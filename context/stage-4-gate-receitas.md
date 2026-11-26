# Cartão de receitas do gate da Etapa 4 (#14033)

Consulta rápida para o loop do gate (§4d em diante). Uma receita por tipo de
pedido do editor, com o comando e as flags exatos. **Não substitui o
playbook:** a regra completa (exit codes, exceções, o que é GATE-BLOCKING)
está em `.claude/agents/orchestrator-stage-4-gate.md`, na seção citada em
cada receita, e o playbook vence o cartão quando os dois divergirem. Ler o
playbook do gate inteiro uma vez ao chegar no §4d; depois, voltar a ele só
na seção que a receita cita.

Placeholders: `{EDITION_DIR}` (de `scripts/lib/find-current-edition.ts --resolve`),
`{AAMMDD}`, `d{N}` (destaque afetado). Todo `npx tsx` abaixo roda com cwd na
raiz do repo.

---

## A. Antes de cada apresentação do gate (§4d)

Repetir a cada volta ao gate, inclusive depois de cada `ajustar`:

```bash
npx tsx scripts/edition-lock.ts acquire --edition-dir {EDITION_DIR} --stage 4   # standalone; exit 3 = outra sessão viva (§4a)
npx tsx scripts/serve-preview.ts --ensure --file {EDITION_DIR}/_internal/newsletter-final-embedded.html --port 0 --watch --edition {AAMMDD} --persist-to {EDITION_DIR}/_internal/04-newsletter-url.json --field newsletter_url
npx tsx scripts/serve-preview.ts --ensure --file {EDITION_DIR}/_internal/social-preview-embedded.html --port 0 --watch --edition {AAMMDD} --persist-to {EDITION_DIR}/_internal/05-social-preview.json --field social_preview_url
npx tsx scripts/stage4-docs-sync.ts status --edition-dir {EDITION_DIR}            # só com doc_url em _internal/04-docs-gate.json
npx tsx scripts/d1-video-invite-status.ts --edition-dir {EDITION_DIR}             # {d1_video_invite_line}
npx tsx scripts/select-use-melhor-post.ts --edition-dir {EDITION_DIR}/ --status   # {use_melhor_post_block}
npx tsx scripts/generic-study-gate-feedback.ts --edition-dir {EDITION_DIR} --questions
npx tsx scripts/editorial-domain-cuts.ts --questions --edition {AAMMDD}
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator --level info --message "gate revisao: apresentado"
npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 4 --status running --gate-at "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
```

Artifact ausente em `04-newsletter-url.json`/`05-social-preview.json`:
publicar antes de apresentar (§4b step 2b/3). Depois do `ajustar`, se o D1
mudou, re-rodar também `youtube-title-research.ts` (§4c.10).

## B. Todo `ajustar` (§4d.1, fluxo base)

1. Capturar `{requested_at}` ao receber o pedido.
2. `Edit` cirúrgico em `02-reviewed.md` (ou `03-social.md`), `old_string`
   mínimo (#495). Responder ao editor só "aplicado" + antes/depois.
3. GATE-BLOCKING logo depois da edição:
   ```bash
   npx tsx scripts/lint-newsletter-md.ts --check no-xml-artifacts --md {EDITION_DIR}/02-reviewed.md
   ```
4. Varredura em background (só se o `--check-lock` sair 0):
   ```bash
   npx tsx scripts/stage4-post-edit-checks.ts --edition-dir {EDITION_DIR}/ --check-lock
   npx tsx scripts/stage4-post-edit-checks.ts --edition-dir {EDITION_DIR}/   # run_in_background: true
   ```
5. Re-render e re-serve do preview afetado (receita M).
6. Log + timing, no mesmo passo:
   ```bash
   npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator --level info --message "gate revisao: ajustar inline aplicado ({descrição curta})"
   npx tsx scripts/log-stage4-adjust-timing.ts --edition {AAMMDD} --requested-at {requested_at} --edited-at {edited_at} --preview-served-at {preview_served_at} --calls {tool_calls} --description "{descrição curta}"
   ```
7. Se `03-social.md` mudou: receita K (re-humanização scoped).
8. Contagem de itens visíveis mudou: `npx tsx scripts/sync-coverage-line.ts --edition-dir {EDITION_DIR}/`.
9. Critic pass ligado e social tocado: re-rodar §4c.6d. Voltar à receita A.

## C. Trocar palavra, frase ou link no corpo (sem trocar título)

Receita B. Não abre cascata. Exceção: reescrita do LEAD/ângulo de um
destaque cascateia o social mesmo sem trocar título (receita E com
`--pieces social,carousel`). Na dúvida, `social-not-behind-reviewed` decide
(§4d.1 passo 3).

## D. Trocar o LINK/fonte de um destaque (§4d.1 passo 4)

```bash
npx tsx scripts/swap-destaque-link.ts --edition {AAMMDD} --edition-dir {EDITION_DIR} --destaque d{N} --url {url nova}
```

Nunca editar só o link em `02-reviewed.md`. O `fact-check.json` fica
defasado: refazer o fact-check (receita L).

## E. Trocar o TÍTULO de um destaque, ou reescrever o lead (§4d.1 passo 3, §4d.1a)

Cascata com preview progressivo, passos a-f:

```bash
npx tsx scripts/stage4-cascade-status.ts --edition-dir {EDITION_DIR}/ --start --highlight d{N} --pieces image,carousel,social --reason "{motivo}"
# re-render do texto (receita M), depois o badge:
npx tsx scripts/stage4-cascade-status.ts --edition-dir {EDITION_DIR}/ --apply-badge --html {EDITION_DIR}/_internal/newsletter-final-embedded.html
# background (run_in_background: true):
npx tsx scripts/image-generate.ts --editorial {EDITION_DIR}/_internal/02-d{N}-prompt.md --out-dir {EDITION_DIR}/ --destaque d{N}
npx tsx scripts/image-generate.ts --editorial {EDITION_DIR}/_internal/02-d{N}-prompt.md --out-dir {EDITION_DIR}/ --destaque d{N} --ratio 4x5 --force
npx tsx scripts/gen-social-card-4x5.ts --edition-dir {EDITION_DIR}/ --destaque d{N}
npx tsx scripts/gen-carousel-cards.ts --edition-dir {EDITION_DIR}/          # só com "carousel" na cascata
# ao terminar cada peça:
npx tsx scripts/stage4-cascade-status.ts --edition-dir {EDITION_DIR}/ --mark --highlight d{N} --piece image --state done
# fim:
npx tsx scripts/stage4-cascade-status.ts --edition-dir {EDITION_DIR}/ --clear
```

Lead reescrito sem título novo: `--pieces social,carousel` (inclui o `# Curto`).
Social na cascata: receita J. Imagem nova: revisão de crop e plano de Noite
Estrelada (§4d.1a passo d, `run-image-crop-reviewer.ts ... --estilo-regen-plan`).
Card 4:5 recomposto com `crop_review_rerun` no JSON: rodar o
`discover_command`, o `image-crop-reviewer` e o `persist_command` que o JSON
traz (§4d.1a passo d, #12109).

Manter a arte do carrossel por pedido explícito do editor: chave
`"d{N}": "{motivo}"` em `_internal/carousel-keep-art.json` (§4d.1 passo 3,
#11210).

## F. Cortar ou mover item do POOL (§4d.1 passo 2)

```bash
npx tsx scripts/remove-pool-item.ts --edition-dir {EDITION_DIR} --url {url}                                            # corte
npx tsx scripts/move-pool-item.ts --edition-dir {EDITION_DIR} --url {url} --to {lancamento|radar|use_melhor|video} [--tempo N]   # mudança de seção
```

Nunca `Edit` à mão no `02-reviewed.md` para isso. Indo para USE MELHOR sem
"(N min)", `--tempo` com os minutos que o editor informar. Seguir o
`next_steps` do JSON. Depois, receita B a partir do passo 3.

Moveu, adicionou ou alterou tempo no USE MELHOR:
`npx tsx scripts/refresh-use-melhor-tempo.ts --edition-dir {EDITION_DIR}/ --write`.

Item que ENTROU no pool (pesquisa nova, refresh tardio, destaque rebaixado,
link colado), já integrado em `01-approved.json`:
`npx tsx scripts/refresh-destaque-sources.ts --edition-dir {EDITION_DIR}/ --pool-sources`.

## G. Trocar o item do 4º post (`## um`, USE MELHOR)

```bash
npx tsx scripts/refresh-use-melhor-post.ts --edition-dir {EDITION_DIR}/ --url {url do item}
# seguir o plano impresso, na ordem; no fim:
npx tsx scripts/refresh-use-melhor-post.ts --edition-dir {EDITION_DIR}/ --done
```

URL fora do USE MELHOR sai exit 2 (mover o item antes, receita F). Item
escolhido que saiu da edição: `refresh-use-melhor-post.ts --edition-dir
{EDITION_DIR}/` re-seleciona (#10469). Nunca escrever `use-melhor-post.json`
à mão. Re-disparo do `## um`: receita J.

## H. Reordenar destaques, ou trocar quem ocupa o D1 (§4d.1 passo 4)

```bash
npx tsx scripts/reorder-destaques.ts --edition {AAMMDD} --new-order {permutação} [--dry-run]
```

Único caminho: nunca renomear `04-d{N}-*` à mão em `data/` (#8679). Edição
antiga com `## post_pixel` em `03-social.md`:
`npx tsx scripts/lint-social-md.ts --check post_pixel-matches-d1 --md {EDITION_DIR}/03-social.md`
e reescrita manual do bloco até exit 0. Destaque que mudou de slot D1 precisa
de imagem no ratio novo: cascata (receita E) com `--pieces image[,carousel]`,
sem `social` se o texto não mudou.

## I. Trocar ou promover destaque (§4d.1 passo 4, §4d.1b)

| Pedido | Comando |
|---|---|
| Edição com 2 destaques, promover item do pool | `npx tsx scripts/promote-to-destaque.ts --edition-dir {EDITION_DIR} --url {url do item} --position {1\|2\|3}` |
| Edição com 3, item DO POOL substitui D{N} | `npx tsx scripts/swap-destaque.ts --edition {AAMMDD} --edition-dir {EDITION_DIR} --promote {bucket}:{idx} --demote d{N} [--demote-to {bucket}] [--drop]` |
| URL NOVA, fora de qualquer bucket, vira D{N} | `npx tsx scripts/swap-destaques.ts --edition {AAMMDD} --edition-dir {EDITION_DIR} --d{N}-url {url} --d{N}-title "{título}" [--demote-to {bucket}] [--drop]` |
| Trouxe o rebaixado de volta | 2º swap + `npx tsx scripts/swap-destaque.ts --restore d{N} --edition-dir {EDITION_DIR}` |

Promover com 3 destaques é SUBSTITUIR, nunca somar um D4 (#3369). Seguir o
`next_steps`/`rerenders_needed` do JSON NA ORDEM:

1. `npx tsx scripts/refresh-destaque-sources.ts --edition-dir {EDITION_DIR}/ --pool-sources` (uma vez, depois de todas as trocas da rodada).
2. `writer-destaque` do D{N} com `source_text_path` e os 4 arquivos de contexto no prompt. Conferir o Write antes de integrar:
   ```bash
   npx tsx scripts/verify-agent-outputs.ts --now      # {DISPATCH_AT}, antes do dispatch
   npx tsx scripts/verify-agent-outputs.ts --agent writer-destaque --since {DISPATCH_AT} --paths {EDITION_DIR}/_internal/02-d{N}-draft.md,{EDITION_DIR}/_internal/02-d{N}-prompt.md
   ```
   Integrar o bloco cirurgicamente e podar para 1 título (#13887).
3. `npx tsx scripts/swap-destaque.ts --finalize-titulo --edition-dir {EDITION_DIR}` (título provisório da fonte sai do TÍTULO/SUBTÍTULO).
4. Rebaixado na seção de destino + `sync-intro-count.ts`.
5. Social do D{N} (receita J), e só depois do splice `refresh-social-hash.ts`.
6. Imagem: cascata (receita E), 2 slots trocados = 2 cascatas (`--highlight` cada).
7. Fact-check (receita L) e invariantes.

D1 trocado em edição sem vídeo: rodar o `set-d1-no-video.ts` do
`next_steps` logo antes do upload, no gate (#12946).

## J. Reescrever o social de um destaque (§4d.1a passo e)

1. Dispatch de `social-writer` (e `social-curto`, se o `## d{N}` de `# Curto`
   também muda) restrito ao destaque, com `source_text_paths`
   (`_internal/fact-check-sources/d{N}.txt`) e
   `newsletter_md_path = {EDITION_DIR}/02-reviewed.md`, o mesmo nos dois
   agents. O prompt manda ler `context/editorial-rules.md` e gravar em
   `_internal/03-social.tmp.md` / `_internal/03-curto.tmp.md`. Re-disparo do
   `## um`: `use_melhor_post_path` + `source_text_paths = {"um": ...}`.
2. Splice, nunca colar à mão (recusa legenda sem `-cards`):
   ```bash
   npx tsx scripts/splice-social-sections.ts --edition-dir {EDITION_DIR} --destaque d{N}   # 2 slots: --destaque d1,d3
   ```
3. `npx tsx scripts/stage4-cascade-status.ts --edition-dir {EDITION_DIR}/ --mark --highlight d{N} --piece social --state done`
4. Receita K (re-humanização scoped de `main_d{N}` e `main_d{N}-cards`), depois re-render do social (receita M).

Linha em branco entre 2 itens do MESMO card do `## um`: linha só com
`{quebra}` (#9866).

## K. Re-humanização scoped depois de mexer em `03-social.md` (§4d.1 passo 6)

```bash
npx tsx scripts/check-humanizer-social.ts --check --edition-dir {EDITION_DIR}/   # exit 2 esperado; ler { legacy, changed_sections }
cp {EDITION_DIR}/03-social.md {EDITION_DIR}/_internal/.stage4-pre-scoped-humanize.md
# Skill humanizador SÓ nas changed_sections (regra da 1ª frase, #13427), depois:
npx tsx scripts/lint-social-md.ts --check no-unanchored-opening --md {EDITION_DIR}/03-social.md
cp {EDITION_DIR}/03-social.md {EDITION_DIR}/_internal/03-social-post-humanizador.md
npx tsx scripts/check-humanizer-social.ts --record-run --step humanizador --pre {EDITION_DIR}/_internal/.stage4-pre-scoped-humanize.md --post {EDITION_DIR}/_internal/03-social-post-humanizador.md --sections {seções} --edition-dir {EDITION_DIR}/
# Clarice por seção, filtrada, aplicar só o filtrado:
npx tsx scripts/clarice-filter.ts --edition-dir {EDITION_DIR} --suggestions {EDITION_DIR}/_internal/clarice-stage4-{seção}.json --out {EDITION_DIR}/_internal/clarice-stage4-{seção}-filtrado.json
npx tsx scripts/check-humanizer-social.ts --record-run --step clarice --pre {EDITION_DIR}/_internal/03-social-post-humanizador.md --post {EDITION_DIR}/03-social.md --edition-dir {EDITION_DIR}/
npx tsx scripts/verify-scoped-humanization.ts --pre {EDITION_DIR}/_internal/.stage4-pre-scoped-humanize.md --post {EDITION_DIR}/_internal/03-social-post-humanizador.md --sections {seções}
npx tsx scripts/check-humanizer-social.ts --write --bypass-reason "humanizador re-rodou ({scoped: seções | full-file}) após ajuste {descrição} no Stage 4" --edition-dir {EDITION_DIR}/
# lints síncronos do passo 6.7 (no-xml-artifacts, no-antithesis-reveal e no-trailing-editorial-hook são GATE-BLOCKING), depois:
npx tsx scripts/check-humanizer-social.ts --check --edition-dir {EDITION_DIR}/
```

`legacy: true` cai no fluxo FULL-FILE (6.2'). Clarice sem sugestões: repetir
o `--record-run --step clarice` com `--note "Clarice sem sugestões"`. Clarice
fora do ar: `--record-clarice-pending --reason clarice_unavailable --detail
"..." --sections {seções}`, nunca `--unproven-ok`. Exit 4/5 do `--write` e os
casos de `--unproven-ok`: §4d.1 passo 6.6. Os 7 `lint-social-md.ts --check`
do passo 6.7 (`humanizer-section-coverage` contra o snapshot
pós-humanizador) estão no playbook.

## L. Refazer o fact-check (§4c.6 do pré-gate)

```bash
npx tsx scripts/run-fact-checker.ts --edition-dir {EDITION_DIR}/
# Agent("fact-checker", { newsletter_path, social_path, approved_json_path, out_path: {EDITION_DIR}/_internal/fact-check.json })
npx tsx scripts/run-fact-checker.ts --edition-dir {EDITION_DIR}/ --input-json {EDITION_DIR}/_internal/fact-check.json --check-blocking
npx tsx scripts/apply-factcheck-autofix.ts --edition-dir {EDITION_DIR}/
```

Exit 2 = claim `NOT_FOUND_IN_SOURCE` bloqueia; fonte adicional da mesma
história via `npx tsx scripts/add-destaque-source.ts --edition-dir
{EDITION_DIR}/ --destaque N --url {URL}`, nunca editar `d{N}.txt` à mão.
Exit 1 com `FACT-CHECK DEFASADO`: re-despachar uma única vez. Autofix com
`applied > 0` ou `social_modified: true`: re-render (receita M). Antes de
redespachar depois de troca de destaque:
`refresh-destaque-sources.ts --check` (exit 3 = URL defasada, rodar sem
`--check`).

## M. Re-render e re-serve dos previews (§4c.6b do pré-gate)

Newsletter:
```bash
npx tsx scripts/render-newsletter-html.ts {EDITION_DIR}/ --format html --out {EDITION_DIR}/_internal/newsletter-draft.html
npx tsx scripts/substitute-image-urls.ts --html {EDITION_DIR}/_internal/newsletter-draft.html --out {EDITION_DIR}/_internal/newsletter-final.html --images {EDITION_DIR}/06-public-images.json
npx tsx scripts/render-kit-html-preview.ts {EDITION_DIR}/
npx tsx scripts/embed-images-base64.ts --require-all-embedded --html {EDITION_DIR}/_internal/newsletter-final.html --images {EDITION_DIR}/06-public-images.json --edition-dir {EDITION_DIR}/ --out {EDITION_DIR}/_internal/newsletter-final-embedded.html
```

Social:
```bash
npx tsx scripts/render-social-html.ts --md {EDITION_DIR}/03-social.md --out {EDITION_DIR}/_internal/social-preview.html --images {EDITION_DIR}/06-public-images.json
npx tsx scripts/embed-images-base64.ts --require-all-embedded --html {EDITION_DIR}/_internal/social-preview.html --images {EDITION_DIR}/06-public-images.json --edition-dir {EDITION_DIR}/ --out {EDITION_DIR}/_internal/social-preview-embedded.html
```

Com o servidor `--watch` vivo, reescrever o arquivo servido basta; sem ele, o
`--ensure` da receita A sobe outro. Re-publicar o Artifact correspondente
(mesmo `file_path`), warning-only (#6003).

## N. Outros pedidos

- **Pesquisa nova** ("busca mais 2 tutoriais"): `npx tsx scripts/check-pending-research.ts --write --edition-dir {EDITION_DIR}/ --bucket {use_melhor|radar|lancamento|video} --request "{pedido}"`, sempre, mesmo com a busca bem-sucedida. Desistiu: `--resolve --reason "{motivo}"` (§4d.1 passo 0).
- **Sem vídeo hoje**: rodar os `no_video_steps` de `npx tsx scripts/d1-video-invite-status.ts --edition-dir {EDITION_DIR} --json` e re-apresentar; não é aprovação (§4d, regras de apresentação).
- **Resposta 🔎** ("1 sim", "2 não"): `npx tsx scripts/generic-study-gate-feedback.ts --edition-dir {EDITION_DIR} --record --answers "N=sim"`, assim que chega. O `sim` do gate nunca vira `--answers`.
- **Domínio** (`dominio=retirar`/`manter`): `npx tsx scripts/editorial-domain-cuts.ts --record --edition {AAMMDD} --answers "dominio=retirar" --open-apply-issue`. Nunca `--apply-to-code` no checkout compartilhado.
- **Puxar doc**: export do conector para `_internal/04-docs-gate-export.md` e `npx tsx scripts/stage4-docs-sync.ts apply --edition-dir {EDITION_DIR} --doc-export {EDITION_DIR}/_internal/04-docs-gate-export.md`, sem `--final`; `pulled[]` = tratar como `ajustar` aplicado. Conflito: `apply --resolve "{file}=arquivo@{resolve_token}"` ou `=doc@{resolve_token}` (§4d, "Doc editável").
- **Atualizar doc**: export, `apply`, `stage4-docs-sync.ts render ... --doc-version {doc_version}`, substituir com `container.version`, `confirm` (§4d).
- **Erro intencional sumiu**: `npx tsx scripts/replant-intentional-error.ts --edition-dir {EDITION_DIR}/ [--entity X] [--section Y] [--dry-run]`, ou `{"no_error": true}`; re-render antes do sentinel (§4e).

## O. Respostas terminais

**`sim`** (§4d e §4e), nesta ordem:
1. `npx tsx scripts/stage4-cascade-status.ts --edition-dir {EDITION_DIR}/ --status`: exit 1 = esperar a cascata.
2. Relatório de `stage4-post-edit-checks.ts` com `inputs_hash` igual ao atual; senão rodar de novo, síncrono. `gate_blocking: true` = voltar ao loop.
3. Doc editável: atalho `read` com `sinceRev` e `apply --no-edits --doc-version {rev} --final`, senão export e `apply --final`. Conflito, exit 2/3 ou conector fora BLOQUEIAM.
4. Teardown (abas `about:blank` + `tabs_close_mcp`, exceto porta 4174; `serve-preview.ts --stop-pid`).
5. §4e: `sync-intro-count.ts --md`, `check-invariants.ts --stage 4 --rule intentional-error-present-in-final`, `generic-study-gate-feedback.ts --record`, `audit-newsletter-intake.ts`, handoff, `pipeline-sentinel.ts write --step 4`, `update-stage-status --status done`, `edition-lock.ts release --complete-stage 4`, `derive-editor-requests.ts derive-stage4`, `capture-stage-usage.ts`, mensagem da fronteira pós-gate. Nunca ler `orchestrator-stage-5.md` nesta sessão.

**`editar`**: teardown, `update-stage-status --stage 4 --status pending`, `edition-lock.ts release`, halt banner, sem sentinel.

**`abortar`**: teardown, log warn `gate_revisao_abortado`, `edition-lock.ts release`, sem sentinel.

Qualquer outra resposta: repetir o prompt (fail-closed).
