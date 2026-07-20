---
name: diaria-2-escrita
description: Roda a Etapa 2 (newsletter + social em paralelo, ambos a partir de `01-approved.json`). Uso — `/diaria-2-escrita AAMMDD [newsletter|social]`.
---

# /diaria-2-escrita

Executa a Etapa 2 da pipeline Diar.ia: dispara `writer` (newsletter) + `social-linkedin` + `social-facebook` + `social-instagram` (#3486) **em paralelo**, todos lendo diretamente de `_internal/01-approved.json` — sem dependência sequencial entre newsletter e social. Gate unificado ao final.

Self-contained — você (top-level Claude Code) executa todo o playbook aqui, sem delegar a um orchestrator subagente. (Workaround #207: runtime bloqueia `Agent` dentro de subagentes.)

## Argumentos

- `$1` = data da edição (`AAMMDD`, ex: `260423`). Se não passar, rodar `npx tsx scripts/lib/find-current-edition.ts --stage 2` e parsear `candidates[]` do JSON de saída (#583):
  - **Se `candidates.length === 1`**: assumir essa edição. Logar info: `Assumindo edição em curso: {AAMMDD}`. Editor pode interromper se errado.
  - **Se `candidates.length === 0`**: erro. `Nenhuma edição com Stage 1 aprovado e Stage 2 incompleto. Rode /diaria-1-pesquisa primeiro ou passe AAMMDD explicitamente.`
  - **Se `candidates.length >= 2`**: perguntar ao editor qual: `Múltiplas edições em curso: {lista}. Qual processar?`
- `$2` (opcional) = `newsletter` | `social` — re-roda só um dos dois. Sem este argumento, roda ambos em paralelo.

## Placeholders

Os blocos Bash/Agent abaixo usam placeholders. **O Claude executando este skill substitui pelos valores reais antes de invocar cada tool.**

- `$1` → AAMMDD recebido como argumento (ex: `260423`). Aparece em prompts de Agent e em `--edition $1` (scripts que já resolvem o layout internamente).
- `{YYMM}` → primeiros 4 chars de `$1` (ex: `2604`). Usado na resolução do layout nested de edições.
- `{EDIR}` → diretório REAL da edição no disco (#2463/#3024). **Nunca** monta como `data/editions/$1` — a edição pode estar no layout flat legado OU no nested novo (`data/editions/{YYMM}/$1`), dependendo de quando foi criada. Resolver **uma vez**, no Passo 0b abaixo, e reusar em todos os paths deste skill:
  ```bash
  EDIR=$(npx tsx scripts/lib/find-current-edition.ts --resolve $1)
  ```

## Passo 0b — Resolver diretório real da edição (#3024)

Antes de qualquer leitura/escrita em arquivo da edição, resolver `{EDIR}` (ver Placeholders acima). Todo path abaixo escrito como `{EDIR}/...` deve usar esse valor resolvido, não uma construção manual `data/editions/$1/...`.

## Pré-requisitos

- `{EDIR}/_internal/01-approved.json` deve existir com `highlights[]` (scorer já rodou na Etapa 1). Se não, avise: rode `/diaria-1-pesquisa` primeiro e aprove.

## Passo 0 — Task tracking setup (#904)

**Defensive cleanup primeiro:** varrer `TaskList()` e marcar como `completed` qualquer task `in_progress` de Stages anteriores (`Stage 0*`, `Stage 1*`). Cobre o caso de Stage 1 ter aprovado o gate sem fechar `Stage 1x` (bug histórico — issue #904).

**Em seguida**, criar tasks pra esta etapa via `TaskCreate` (uma por sub-stage):
- `Stage 2a — validar input + caps editoriais`
- `Stage 2b — dispatch paralelo (writer + social)`
- `Stage 2c — merge social`
- `Stage 2d — newsletter Clarice + humanize + lints`
- `Stage 2e — social Clarice + humanize`
- `Stage 2f — validações finais`
- `Stage 2g — gate humano`
- `Stage 2h — title-picker fallback (pós-gate)`

Cada task fica `pending` até o passo correspondente começar (`in_progress`) e `completed` quando o passo retornar. Tasks de gate (`Stage 2g`) fecham **imediatamente após o editor aprovar** — não esperar o title-picker. Detalhe completo em `.claude/agents/orchestrator.md` § "Task tracking — UI hygiene".

**No-op se TaskCreate/TaskUpdate não estiver disponível** (CLI puro fora do harness Claude Code).
- Se `$2 = social`: apenas o pré-requisito acima é necessário.
- Se `$2 = newsletter`: apenas o pré-requisito acima é necessário.

## Resume

Se `{EDIR}/02-reviewed.md` já existir **e** `$2` não foi passado ou `$2 = newsletter`:

**Mid-Clarice resume (#874).** Se `_internal/02-pre-clarice.md` existir AND `_internal/02-clarice-suggestions.json` existir AND `02-reviewed.md` existir, é um sinal de que Clarice chegou a rodar pelo menos parcialmente. Re-aplicar Clarice em cima de `02-humanized.md` (que pode estar mid-state) ou em cima de `02-reviewed.md` (que pode já ter sugestões parcialmente aplicadas) corrompe o texto via double-application. Perguntar explicitamente:

```
Etapa 2 foi interrompida durante/depois da Clarice. Como continuar?

(1) Usar `02-reviewed.md` atual sem re-Clarice
(2) Re-aplicar Clarice em cima de `_internal/02-pre-clarice.md` (snapshot limpo)  [default]
(3) Regenerar tudo do zero (writer → humanize → Clarice)
```

**Detecção de mid-state (review #889 P3):** o default é definido pelo estado dos arquivos:
- Se `_internal/02-clarice-suggestions.json` existir → mid-Clarice provável → **default = (2)** (re-aplicar do snapshot limpo, evita double-apply).
- Se `_internal/02-clarice-suggestions.json` NÃO existir mas `02-reviewed.md` sim → Clarice nem chegou a rodar OU já fechou em ciclo anterior → **default = (1)** (usar atual).

Comportamentos por opção:
- Opção (1): pular regeneração e ir direto ao gate.
- Opção (2): copiar `_internal/02-pre-clarice.md` → `_internal/02-draft.md` (restaurar estado pré-Clarice limpo) e retomar do Passo 3b (Clarice). **Nunca** re-aplicar Clarice em cima do estado humanizado-pós-Clarice-parcial.
- Opção (3): apagar outputs e rodar Passo 1 em diante.

**Sem snapshot pré-Clarice** (resume "antigo" de antes do #874): preservar comportamento original. Sem `--no-gate`: perguntar `"02-reviewed.md já existe — regenerar (sim/não)?"`. Se "não", usar o arquivo existente e ir direto ao gate. Com `--no-gate`: assumir que está OK, pular regeneração.

Mesma lógica para `03-social.md` quando `$2 = social` (ou sem argumento) — sem o gancho mid-Clarice (social não tem snapshot pré-Clarice; double-apply em social é menos danoso porque seções são curtas).

## Passo 1b — Aplicar caps editoriais Stage 2 (#358, #907)

Antes de passar o approved.json ao writer, truncar buckets aos limites de #358:

- Destaques: sem corte (sempre 3 após gate Stage 1)
- Lançamentos: ≤ 5
- Pesquisas: ≤ 3
- Outras Notícias: `max(2, 12 − destaques − lançamentos − pesquisas)`

```bash
npx tsx scripts/apply-stage2-caps.ts \
  --in {EDIR}/_internal/01-approved.json \
  --out {EDIR}/_internal/01-approved-capped.json
```

Writer (Passo 2) deve receber `01-approved-capped.json` em vez do raw. Falha do script (input ausente, etc.) = parar — sem caps o writer pode publicar 9 notícias quando cap esperado era 4 (caso real em 260507).

**Passo 1b-bis — translate-summaries (#1572 + #1601 review fix):** depois dos caps, limpar/truncar summaries em inglês pra evitar `[TRADUZIR]` + summary cru vazando pra newsletter HTML (caso 260529):

```bash
npx tsx scripts/translate-summaries.ts \
  --in {EDIR}/_internal/01-approved-capped.json \
  --out {EDIR}/_internal/01-approved-capped.json
```

Idempotente (marca `summary_translated: true`). NÃO traduz via LLM — strip de prefixo arXiv + 1ª frase + truncate 150 chars. Stitch adiciona prefix `[TRADUZIR]` em items `summary_lang === "en"`; humanizer (ou editor no gate) remove o prefix downstream.

## Passo 2 — Dispatch paralelo (writer-destaque × N + social, #1451/#1463/#2343)

**INVARIANTE (#1451):** writer paralelo é default em todas as situações. Dispatch `writer-destaque` × N (N = highlights.length ∈ {2,3}) + social em paralelo, depois `scripts/stitch-newsletter.ts` une os outputs.

**Pré-dispatch — ler highlights inline (sem extract-destaques.ts — esse parsea MD, não JSON):**

```bash
node -e "
  const fs=require('fs');
  const j=JSON.parse(fs.readFileSync('{EDIR}/_internal/01-approved-capped.json','utf8'));
  const n=j.highlights?.length||0;
  if(!j.highlights||n<2||n>3){
    console.error('FALLBACK: highlights.length='+n+' — fora do range {2,3}, usar writer legacy');
    process.exit(1);
  }
  console.log(JSON.stringify(j.highlights.map((h,i)=>({n:i+1,article:h.article,bucket:h.bucket})),null,2));
"
```

Se `highlights.length < 2 || highlights.length > 3`: cair em writer único legacy (ver bloco "Fallback" abaixo). **#2343:** para 2 destaques, dispatch `writer-destaque` × 2 (D1 + D2 apenas — pular o D3 writer abaixo); para 3, × 3 (D1 + D2 + D3). O `stitch-newsletter.ts` detecta o `destaque_count` do `01-approved-capped.json` e omite o bloco D3 automaticamente quando são 2 destaques.

### Se `$2` está ausente ou `$2 = all` (padrão — tudo em paralelo):

```
Agent({
  subagent_type: "writer-destaque",
  description: "Etapa 2 — D1 writer",
  prompt: "Escreve DESTAQUE 1 da edição $1. destaque_n=1, article={highlights[0].article}, category_label={highlights[0].bucket → 'LANÇAMENTO'|'PESQUISA'|'MERCADO'|'BRASIL'|etc — SOMENTE o label textual, sem emoji; o agent escolhe o emoji do template canônico}, peer_titles=[highlights[1].article.title, highlights[2].article.title], edition_date=$1, out_path={EDIR}/_internal/02-d1-draft.md, image_prompt_out_path={EDIR}/_internal/02-d1-prompt.md. Seguir context/templates/newsletter.md."
})

Agent({
  subagent_type: "writer-destaque",
  description: "Etapa 2 — D2 writer",
  prompt: "Escreve DESTAQUE 2... [análogo, com highlights[1].article + peer_titles dos outros 2]"
})

Agent({
  subagent_type: "writer-destaque",
  description: "Etapa 2 — D3 writer",
  prompt: "Escreve DESTAQUE 3... [análogo, com highlights[2].article + peer_titles dos outros 2]"
})
// #2343: dispatchar este D3 writer SOMENTE quando highlights.length === 3.
// Em edições de 2 destaques, pular este Agent (stitch omite o bloco D3).

Agent({
  subagent_type: "social-linkedin",
  description: "Etapa 2 — LinkedIn writer",
  prompt: "Gera 3 posts de LinkedIn (um por destaque) a partir de {EDIR}/_internal/01-approved.json. Output: {EDIR}/_internal/03-linkedin.tmp.md com seções ## d1, ## d2, ## d3. Seguir context/templates/social-linkedin.md."
})

Agent({
  subagent_type: "social-facebook",
  description: "Etapa 2 — Facebook writer",
  prompt: "Gera 3 posts de Facebook (um por destaque) a partir de {EDIR}/_internal/01-approved.json. Output: {EDIR}/_internal/03-facebook.tmp.md com seções ## d1, ## d2, ## d3. Seguir context/templates/social-facebook.md."
})

Agent({
  subagent_type: "social-instagram",
  description: "Etapa 2 — Instagram writer",
  prompt: "Gera 3 captions de Instagram (uma por destaque) a partir de {EDIR}/_internal/01-approved.json. Output: {EDIR}/_internal/03-instagram.tmp.md com seções ## d1, ## d2, ## d3. Seguir context/templates/social-instagram.md. CTA nativo de social ('link na bio' + follow) — SEM CTA de e-mail (#3486, #2486)."
})
```

**Após os 3 writer-destaques retornarem, rodar stitch:**

```bash
npx tsx scripts/stitch-newsletter.ts --edition-dir {EDIR}/
```

Output: `{EDIR}/_internal/02-draft.md` unificado (coverage + 3 destaques + É IA? + seções secundárias + ERRO INTENCIONAL + SORTEIO + PARA ENCERRAR).

### Fallback (writer único legacy)

Quando `highlights.length !== 3` ou falha de dispatch parallel:

```
Agent({
  subagent_type: "writer",
  description: "Etapa 2 — newsletter writer (fallback legacy)",
  prompt: "Escreve a newsletter completa da edição $1 a partir de {EDIR}/_internal/01-approved-capped.json (já com caps de #358 aplicados em Passo 1b). Seguir context/templates/newsletter.md e context/editorial-rules.md. Output: {EDIR}/_internal/02-draft.md"
})

Agent({
  subagent_type: "social-linkedin",
  description: "Etapa 2 — LinkedIn writer",
  prompt: "Gera 3 posts de LinkedIn (um por destaque) a partir de {EDIR}/_internal/01-approved.json. Output: {EDIR}/_internal/03-linkedin.tmp.md com seções ## d1, ## d2, ## d3. Seguir context/templates/social-linkedin.md."
})

Agent({
  subagent_type: "social-facebook",
  description: "Etapa 2 — Facebook writer",
  prompt: "Gera 3 posts de Facebook (um por destaque) a partir de {EDIR}/_internal/01-approved.json. Output: {EDIR}/_internal/03-facebook.tmp.md com seções ## d1, ## d2, ## d3. Seguir context/templates/social-facebook.md."
})

Agent({
  subagent_type: "social-instagram",
  description: "Etapa 2 — Instagram writer",
  prompt: "Gera 3 captions de Instagram (uma por destaque) a partir de {EDIR}/_internal/01-approved.json. Output: {EDIR}/_internal/03-instagram.tmp.md com seções ## d1, ## d2, ## d3. Seguir context/templates/social-instagram.md. CTA nativo de social ('link na bio' + follow) — SEM CTA de e-mail (#3486, #2486)."
})
```

### Se `$2 = newsletter`:

Dispatchar só `writer`. Pular steps de social abaixo.

### Se `$2 = social`:

Dispatchar `social-linkedin` + `social-facebook` + `social-instagram` (#3486) em paralelo. Pular steps de newsletter abaixo.

## Passo 2b — Merge dos outputs

### 2b-news — assim que `writer` retornar

```bash
cp {EDIR}/_internal/02-draft.md {EDIR}/02-reviewed.md
```

### 2b-soc — assim que `social-linkedin`, `social-facebook` E `social-instagram` retornarem

**#3486:** usar `merge-social-md.ts` (não montar `03-social.md` manualmente) — o script valida os tmps obrigatórios (LinkedIn/Facebook), faz strip de comentários HTML e dedupe de header (#3424/#3388), e mescla `# Instagram` quando `_internal/03-instagram.tmp.md` existir (tmp OPCIONAL — ausência não falha o merge, só omite a seção e mantém o fallback `# Instagram` → `# Facebook`, #2486):

```bash
npx tsx scripts/merge-social-md.ts --edition-dir {EDIR}/
```

Se `$2 = newsletter`, só roda 2b-news (pula 2b-soc).
Se `$2 = social`, só roda 2b-soc (pula 2b-news).

Após ambos terminarem, prosseguir para Passo 3 (lint + Clarice/humanize na newsletter).

## Passo 3 — Processar newsletter (pular se `$2 = social`)

### 3a. Lint + normalize

```bash
npx tsx scripts/lint-newsletter-md.ts \
  --md {EDIR}/_internal/02-draft.md \
  --approved {EDIR}/_internal/01-approved-capped.json
npx tsx scripts/lint-newsletter-md.ts \
  --check title-length \
  --md {EDIR}/_internal/02-draft.md
npx tsx scripts/lint-newsletter-md.ts \
  --check why-matters-format \
  --md {EDIR}/_internal/02-draft.md
npx tsx scripts/lint-newsletter-md.ts \
  --check section-counts \
  --md {EDIR}/_internal/02-draft.md \
  --approved {EDIR}/_internal/01-approved-capped.json
npx tsx scripts/lint-newsletter-md.ts \
  --check destaque-min-chars \
  --md {EDIR}/_internal/02-draft.md
npx tsx scripts/validate-domains.ts {EDIR}/_internal/02-draft.md
npx tsx scripts/normalize-newsletter.ts \
  --in {EDIR}/_internal/02-draft.md \
  --out {EDIR}/_internal/02-draft.md
npx tsx scripts/lint-newsletter-md.ts \
  --check section-item-format \
  --md {EDIR}/_internal/02-draft.md
```

`--check section-item-format` (#909) roda **depois** de normalize — se ainda houver item com título+descrição na mesma linha (caso heurístico do normalize não resolveu), exit 1 = re-disparar writer com instrução explícita de quebrar.

`--check section-counts` (#907) valida que LANÇAMENTOS, PESQUISAS, OUTRAS NOTÍCIAS no MD respeitam os caps de #358. Exit 1 = re-disparar writer com erro explicitado.

`--check destaque-min-chars` (#914) valida que cada destaque atinge o mínimo de chars (D1≥1000, D2/D3≥900). Exit 1 = re-disparar writer pra expandir.

### 3b. Clarice (inline)

**⚠️ Fallback REST automático (#1329, substitui fail-fast de #738; chunking #2626):** Se `<system-reminder>` indicar que o MCP Clarice ficou offline OU a chamada `mcp__clarice__correct_text` falhar com disconnect/unavailable, **não fazer halt** — cair direto no fallback REST. **Sempre passar `--corrected-out` e `--retry`** (#2626): o script chunka textos > 9k e aplica as sugestões chunk-localmente via `mergeChunkSuggestions`, gravando o texto corrigido nesse arquivo:
```bash
npx tsx scripts/clarice-correct.ts \
  --in {EDIR}/_internal/02-draft.md \
  --out {EDIR}/_internal/02-clarice-suggestions.json \
  --corrected-out {EDIR}/_internal/02-clarice-corrected.md \
  --retry
```
(Substitua `02-draft.md` pelo arquivo resolvido em §3b, normalmente o que sai do humanizador.)
Exit 0 = sucesso. **Em sucesso, NÃO rodar o passo 4 (`clarice-apply.ts`)** — o texto corrigido já está pronto em `02-clarice-corrected.md` (chunk-applied). **Re-aplicar `02-clarice-suggestions.json` ao texto inteiro via `clarice-apply.ts` sub-corrige textos multi-chunk** (âncora única dentro de um chunk pode aparecer 2+× no texto inteiro → pulada como ambígua). Copiar o corrigido diretamente para o working draft:
```bash
cp {EDIR}/_internal/02-clarice-corrected.md {EDIR}/_internal/02-draft.md
```
Exit 3 = HTTP non-2xx (token revogado, endpoint down) = **halt** + halt banner pro editor. Exit 2 = `CLARICE_API_KEY` ausente = halt.
Sempre logar warn no run-log quando cair no fallback (não silenciar — o editor precisa saber que o caminho normal falhou, mesmo que o fallback tenha funcionado).

Snapshot pré-Clarice (path canonical único — review #889 P3). `02-pre-clarice.md` serve simultaneamente como (a) sinal pra resume mid-Clarice (#874), (b) input do `clarice-diff.ts` (3d), (c) input do `verify-clarice-url-stability.ts` (#873). `clarice-diff.ts` aceita qualquer path posicional, então não precisa de alias.

```bash
cp {EDIR}/_internal/02-draft.md {EDIR}/_internal/02-pre-clarice.md
```

**Assertion obrigatória (review #889 P2).** Antes de chamar `mcp__clarice__correct_text`, verificar que o snapshot foi gravado. Se `_internal/02-pre-clarice.md` não existir nesse momento, **abortar** e logar erro:

```bash
test -f {EDIR}/_internal/02-pre-clarice.md || {
  npx tsx scripts/log-event.ts --edition $1 --stage 2 --agent orchestrator --level error --message "pre-clarice snapshot missing — aborting before MCP Clarice call"
  echo "ERRO: snapshot pré-Clarice ausente — abortar antes de chamar MCP Clarice. Re-rodar /diaria-2-escrita $1 do zero." >&2
  exit 1
}
```

1. Ler `{EDIR}/_internal/02-draft.md`.
2. Chamar `mcp__clarice__correct_text` passando o texto completo.
3. Salvar sugestões: `{EDIR}/_internal/02-clarice-suggestions.json`.
4. Aplicar via helper:
   ```bash
   npx tsx scripts/clarice-apply.ts \
     --text-file {EDIR}/_internal/02-draft.md \
     --suggestions {EDIR}/_internal/02-clarice-suggestions.json \
     --out {EDIR}/_internal/02-draft.md \
     --report {EDIR}/_internal/02-clarice-report.json
   ```
5. Ler `_internal/02-clarice-report.json` para extrair contagens (`applied`, `skipped`).
6. Se `mcp__clarice__correct_text` falhar, **propagar o erro** — não silenciar.

### 3c. Humanize

Snapshot pré-Humanize antes de dispatchar o agent — usado para rollback se o agent falhar OU se o draft pós-humanize ficar corrompido (perda de seção, perda de URL, etc.):

```bash
cp {EDIR}/_internal/02-draft.md {EDIR}/_internal/02-draft.pre-humanize.md
```

```
Agent({
  description: "Humanizar newsletter $1",
  prompt: "Você é um editor especialista em remover marcas de IA em português brasileiro (humanizador v1.4.1).

Arquivo: {EDIR}/_internal/02-draft.md

OBRIGATÓRIO — execute em ordem:

ETAPA 0 — TRADUÇÃO (#1525, #1697):
- Itens de seções secundárias (LANÇAMENTOS/RADAR/USE MELHOR) com a DESCRIÇÃO marcada [TRADUZIR] estão com a descrição em inglês. Traduza APENAS a descrição (2ª linha) para PT-BR natural e remova o prefixo [TRADUZIR].
- O TÍTULO/link do item NUNCA é traduzido (#1634) — preserve o nome original do recurso (PT ou EN). Mesmo que o título esteja em inglês, mantenha-o no idioma original; só a descrição vai pra PT.
- Se um item não tiver [TRADUZIR] mas a descrição estiver em inglês, traduza a descrição também (mantendo o título original).

ETAPA 1 — RASCUNHO:
- Leia o arquivo, identifique padrões de IA (travessão excessivo >1/5 parágrafos, gerúndio em cascata, inflação de importância, fechamentos genéricos, negação paralela, conectores repetitivos, verbos pomposos, anglicismos desnecessários)
- Reescreva os trechos problemáticos
- Salve com Write
- Escreva: '### Rascunho salvo. O que ainda soa de IA?'
- Liste os resquícios (bullets curtos, seja crítico)

ETAPA 2 — VERSÃO FINAL:
- Reescreva os resquícios listados
- Salve a versão final com Write
- Escreva: '### Versão final salva.'

ETAPA 3 — RESUMO:
- Liste as principais mudanças (incluindo traduções feitas na Etapa 0)

Regras de preservação: sem markdown (nada de **, #, - ), preservar template da newsletter (seções, estrutura, links, listas de notícias), não alterar URLs."
})
```

Se o Agent retornar erro OU se uma checagem rápida pós-humanize indicar corrupção (`02-draft.md` vazio, sem seção É IA?, sem alguma das URLs originais), restaurar o snapshot:

```bash
cp {EDIR}/_internal/02-draft.pre-humanize.md {EDIR}/_internal/02-draft.md
```

Falha **não bloqueia** — fallback restaura o snapshot pré-humanize.

### 3d. Validações finais

Copiar o draft final para a versão que o editor revisa **antes** de rodar verify/diff — assim a verificação de URLs e o diff são feitos contra o mesmo path que o orchestrator usa (review #889 P1 — consistência de paths):

```bash
cp {EDIR}/_internal/02-draft.md {EDIR}/02-reviewed.md
```

`clarice-diff.ts` lê argumentos posicionais. Diff é entre o pré-Clarice (snapshot canonical `02-pre-clarice.md`) e `02-reviewed.md`, mostrando o efeito líquido das passagens editoriais sobre o draft cru do writer:

```bash
npx tsx scripts/validate-lancamentos.ts {EDIR}/02-reviewed.md
npx tsx scripts/clarice-diff.ts \
  {EDIR}/_internal/02-pre-clarice.md \
  {EDIR}/02-reviewed.md \
  {EDIR}/_internal/02-clarice-diff.md
```

**Sync intro count (#743, #876, #906) — corrigir 'Selecionamos os N mais relevantes':**

```bash
npx tsx scripts/sync-intro-count.ts \
  --md {EDIR}/02-reviewed.md \
  --lancamentos-removed {EDIR}/_internal/02-lancamentos-removed.json
```

Após caps (#358) + lançamentos rejeitados, o número declarado na intro pode divergir do número real de artigos no body (writer copia `coverage.line` do approved.json bruto, que não reflete os caps). Script conta URLs editoriais reais e corrige cirurgicamente — só o número, sem mexer no resto. `--lancamentos-removed` é opcional; quando ausente, sync-intro-count ignora silenciosamente o ajuste de "X lançamentos".

**Render seção ERRO INTENCIONAL (#911) — revelar gabarito da edição anterior:**

```bash
npx tsx scripts/render-erro-intencional.ts \
  --edition $1 \
  --md {EDIR}/02-reviewed.md
```

Lê `data/intentional-errors.jsonl` (fallback pra `_internal/intentional-error.json` da edição anterior, #3222), encontra o erro intencional declarado da edição anterior mais recente (`is_feature: true` + `edition < $1`), compõe parágrafo de revelação com `reveal`/`detail` + `gabarito`, e insere/atualiza a seção `**ERRO INTENCIONAL**` no MD antes de ASSINE/encerramento. Idempotente: re-executar não duplica a seção. Sem erro anterior declarado, emite placeholder neutro ("não trazia erro intencional declarado") + convite à participação atual. Também garante que `_internal/intentional-error.json` da edição CORRENTE existe (placeholder `{PREENCHER}` se ausente) — arquivo local-only, nunca sincroniza com o Drive (#3222).

**Estabilidade de URLs em LANÇAMENTOS pós-Clarice (#873).** Clarice/humanizador podem "limpar" URLs (remover utm, normalizar path, trailing slash), o que quebra a regra "LANÇAMENTOS só com link oficial" (#160). Comparar pré-Clarice vs `02-reviewed.md` final (mesmo path usado pelo orchestrator — review #889 P1):

```bash
npx tsx scripts/verify-clarice-url-stability.ts \
  --pre {EDIR}/_internal/02-pre-clarice.md \
  --post {EDIR}/02-reviewed.md
```

Exit 0 = URLs em LANÇAMENTOS estáveis. Exit 1 = URL alterada — incluir output (com diff `antes/depois`) no prompt do gate humano. Não auto-restaurar — editor decide se aceita a versão pós-Clarice ou restaura manualmente em `02-reviewed.md`.

## Passo 4 — Processar social (pular se `$2 = newsletter`)

### 4a. Cleanup dos tmp files (merge já feito no Passo 2b)

```bash
node -e "
  const fs=require('fs');
  const dir='{EDIR}/';
  if (fs.existsSync(dir+'_internal/03-linkedin.tmp.md')) fs.unlinkSync(dir+'_internal/03-linkedin.tmp.md');
  if (fs.existsSync(dir+'_internal/03-facebook.tmp.md')) fs.unlinkSync(dir+'_internal/03-facebook.tmp.md');
"
```

### 4b. Clarice

1. Ler `{EDIR}/03-social.md`.
2. Chamar `mcp__clarice__correct_text` passando o texto completo.
3. Salvar sugestões: `{EDIR}/_internal/03-clarice-suggestions.json`.
4. Aplicar via helper:
   ```bash
   npx tsx scripts/clarice-apply.ts \
     --text-file {EDIR}/03-social.md \
     --suggestions {EDIR}/_internal/03-clarice-suggestions.json \
     --out {EDIR}/03-social.md \
     --report {EDIR}/_internal/03-clarice-report.json
   ```
5. **Verificar integridade dos cabeçalhos**: as seções `# LinkedIn`, `# Facebook`, `## d1`, `## d2`, `## d3` ainda devem existir. Se algum sumiu, restaurar via `Edit` antes de continuar.
6. Se `mcp__clarice__correct_text` falhar, **propagar o erro**.

### 4c. Humanize

Snapshot pré-Humanize antes de dispatchar — usado para rollback se o agent falhar OU se as seções `# LinkedIn` / `# Facebook` / `## d1`-`d3` desaparecerem:

```bash
cp {EDIR}/03-social.md {EDIR}/_internal/03-social.pre-humanize.md
```

```
Agent({
  description: "Humanizar social $1",
  prompt: "Você é um editor especialista em remover marcas de IA em português brasileiro (humanizador v1.4.1).

Arquivo: {EDIR}/03-social.md

OBRIGATÓRIO — execute em ordem:

ETAPA 1 — RASCUNHO:
- Leia o arquivo, identifique padrões de IA (travessão excessivo >1/5 parágrafos, gerúndio em cascata, inflação de importância, fechamentos genéricos, negação paralela, conectores repetitivos, verbos pomposos, anglicismos desnecessários)
- Reescreva os trechos problemáticos
- Salve com Write
- Escreva: '### Rascunho salvo. O que ainda soa de IA?'
- Liste os resquícios (bullets curtos, seja crítico)

ETAPA 2 — VERSÃO FINAL:
- Reescreva os resquícios listados
- Salve a versão final com Write
- Escreva: '### Versão final salva.'

ETAPA 3 — RESUMO:
- Liste as principais mudanças

Regras de preservação: preservar hashtags, emojis, estrutura de seções (# LinkedIn, # Facebook, ## d1, ## d2, ## d3), não alterar URLs."
})
```

Se o Agent retornar erro OU se a integridade dos cabeçalhos quebrar, restaurar o snapshot:

```bash
cp {EDIR}/_internal/03-social.pre-humanize.md {EDIR}/03-social.md
```

Falha **não bloqueia**.

## Passo 5 — Cleanup dos snapshots intermediários

Limpar os snapshots intermediários (não precisam mais — rollback foi concluído ou não foi necessário). **Manter** `_internal/02-pre-clarice.md` até o gate humano fechar — ele é o sinal pra resume mid-Clarice (#874) e some só após o sentinel do Stage 2 ser escrito (Passo 7 ou Passo 6 com `--no-gate`):

```bash
for f in \
  {EDIR}/_internal/02-draft.pre-humanize.md \
  {EDIR}/_internal/03-social.pre-humanize.md; do
  [ -f "$f" ] && rm "$f"
done
```

## Passo 6 — Gate humano unificado

**Importante (#589, #159):** title-picker é **fallback pós-gate**, não pre-gate. Editor revisa newsletter com **3 opções de título por destaque** e poda manualmente o que quer manter. Se aprovar sem podar, title-picker (Sonnet, #2772) escolhe automaticamente como fallback no Passo 7.

**Se `--no-gate`:** pular este passo. Ir direto pro Passo 7 (title-picker fallback se necessário) e finalizar com `[AUTO] Etapa 2 auto-aprovada`.

**Caso contrário:** apresentar ao usuário (omitir seções não geradas se `$2` limitou o escopo):

```
Etapa 2 — Escrita pronta.

📁 Newsletter: {EDIR}/02-reviewed.md
   ⚠️  Cada destaque tem 3 opções de título — apague 2 antes de aprovar,
       ou aprove direto pra deixar o title-picker (Sonnet) escolher.

📁 Social: {EDIR}/03-social.md

Newsletter — Clarice: A aplicadas, B skipadas
Social — Clarice: C aplicadas, D skipadas

Posts gerados:
- LinkedIn d1 / d2 / d3
- Facebook d1 / d2 / d3

(pode editar diretamente no arquivo, local ou via Studio, antes de aprovar)

Aprovar (sim) / pedir retry / editar manualmente?
```

Aguardar resposta. Se "sim", **continuar para Passo 7 (title-picker fallback)**. Se "retry", re-rodar Passo 2 em diante. Se "editar", instruir o usuário a editar o arquivo e retornar `sim`.

## Passo 7 — Title-picker fallback pós-aprovação (newsletter, se não pulado)

**Roda APÓS aprovação do gate** — só se o editor não podou os títulos manualmente. Per `.claude/agents/title-picker.md` #159: este agent é fallback pra quando o editor confia na decisão automática.

Se editor já editou diretamente no arquivo antes de aprovar, este passo é no-op (lint passa).

```bash
npx tsx scripts/lint-newsletter-md.ts --check titles-per-highlight --md {EDIR}/02-reviewed.md
```

Se lint retornar erro (>1 título por destaque), disparar title-picker:

```
Agent({
  subagent_type: "title-picker",
  description: "Escolher título final por destaque (fallback pós-gate)",
  prompt: "Editor aprovou Etapa 2 sem podar manualmente os 3 títulos por destaque. Leia {EDIR}/02-reviewed.md e escolha 1 dos títulos por destaque, reescrevendo o arquivo. Preservar todo o resto. Justificar escolhas em {EDIR}/_internal/02-title-picks.json."
})
```

Após title-picker, re-rodar lint:
```bash
npx tsx scripts/lint-newsletter-md.ts --check titles-per-highlight --md {EDIR}/02-reviewed.md
```

## Passo 7b — Inserir TÍTULO/SUBTÍTULO no topo (#916)

Roda **depois** que cada destaque tem 1 só título (pós-poda manual do gate ou pós title-picker). Insere bloco `TÍTULO`/`SUBTÍTULO` no topo do `02-reviewed.md` que Stage 4 (publicação Beehiiv) usa pra preencher subject line + preview text. Sem isso, é trabalho manual do editor todo dia. Idempotente — re-rodar não duplica.

```bash
npx tsx scripts/insert-titulo-subtitulo.ts \
  --in {EDIR}/02-reviewed.md
```

Falha = warning, **não bloqueia** (gate já aprovou). Se parse de DESTAQUEs quebrar, editor preenche manualmente como antes.

Erro do agent (Passo 7) reportado ao editor — sem fallback automático adicional.

**Cleanup do snapshot pré-Clarice (#874).** Após o gate fechar (com ou sem title-picker), o snapshot `_internal/02-pre-clarice.md` pode ser removido — não há mais resume mid-Clarice possível pra essa edição:

```bash
[ -f {EDIR}/_internal/02-pre-clarice.md ] && rm {EDIR}/_internal/02-pre-clarice.md
```

## Outputs

- `{EDIR}/02-reviewed.md` — newsletter final
- `{EDIR}/03-social.md` — posts LinkedIn + Facebook (seções `# LinkedIn`/`# Facebook`, cada uma com `## d1`/`## d2`/`## d3`)
- `{EDIR}/_internal/02-clarice-diff.md` — diff da Clarice na newsletter
- `{EDIR}/_internal/02-clarice-report.json` — relatório de sugestões newsletter
- `{EDIR}/_internal/03-clarice-report.json` — relatório de sugestões social

**Outputs intermediários (mid-stage, removidos no fim):**
- `{EDIR}/_internal/02-pre-clarice.md` — snapshot do input do Clarice (#874 — sinal pra resume mid-Clarice; #873 — input pro check de estabilidade de URLs). Removido após o gate fechar.

## Notas

- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
- Os agentes social leem diretamente de `_internal/01-approved.json` — não dependem de `02-reviewed.md`.
- Se o orchestrator subagent ainda existir em `.claude/agents/orchestrator.md`, ignorar — este skill não delega.
