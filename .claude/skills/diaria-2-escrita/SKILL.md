---
name: diaria-2-escrita
description: Roda a Etapa 2 (newsletter + social em paralelo, ambos a partir de `01-approved.json`). Uso — `/diaria-2-escrita AAMMDD [newsletter|social]`.
---

# /diaria-2-escrita

Executa a Etapa 2 da pipeline Diar.ia: dispara `writer` (newsletter) + `social-linkedin` + `social-facebook` **em paralelo**, ambos lendo diretamente de `_internal/01-approved.json` — sem dependência sequencial entre newsletter e social. Gate unificado ao final.

Self-contained — você (top-level Claude Code) executa todo o playbook aqui, sem delegar a um orchestrator subagente. (Workaround #207: runtime bloqueia `Agent` dentro de subagentes.)

## Argumentos

- `$1` = data da edição (`AAMMDD`, ex: `260423`). Se não passar, rodar `npx tsx scripts/lib/find-current-edition.ts --stage 2` e parsear `candidates[]` do JSON de saída (#583):
  - **Se `candidates.length === 1`**: assumir essa edição. Logar info: `Assumindo edição em curso: {AAMMDD}`. Editor pode interromper se errado.
  - **Se `candidates.length === 0`**: erro. `Nenhuma edição com Stage 1 aprovado e Stage 2 incompleto. Rode /diaria-1-pesquisa primeiro ou passe AAMMDD explicitamente.`
  - **Se `candidates.length >= 2`**: perguntar ao editor qual: `Múltiplas edições em curso: {lista}. Qual processar?`
- `$2` (opcional) = `newsletter` | `social` — re-roda só um dos dois. Sem este argumento, roda ambos em paralelo.

## Placeholders

Os blocos Bash/Agent abaixo usam placeholders. **O Claude executando este skill substitui pelos valores reais antes de invocar cada tool.**

- `$1` → AAMMDD recebido como argumento (ex: `260423`). Aparece em paths e prompts de Agent.
- `{YYMM}` → primeiros 4 chars de `$1` (ex: `2604`). Aparece no path do Drive e no gate output.

## Pré-requisitos

- `data/editions/$1/_internal/01-approved.json` deve existir com `highlights[]` (scorer já rodou na Etapa 1). Se não, avise: rode `/diaria-1-pesquisa` primeiro e aprove.

## Passo 0 — Task tracking setup (#904)

**Defensive cleanup primeiro:** varrer `TaskList()` e marcar como `completed` qualquer task `in_progress` de Stages anteriores (`Stage 0*`, `Stage 1*`). Cobre o caso de Stage 1 ter aprovado o gate sem fechar `Stage 1x` (bug histórico — issue #904).

**Em seguida**, criar tasks pra esta etapa via `TaskCreate` (uma por sub-stage):
- `Stage 2a — drive pull (input)`
- `Stage 2b — caps editoriais + dispatch paralelo (writer + social)`
- `Stage 2c — merge social + push intermediário`
- `Stage 2d — newsletter Clarice + humanize + lints`
- `Stage 2e — social Clarice + humanize`
- `Stage 2f — drive push final`
- `Stage 2g — gate humano`
- `Stage 2h — title-picker fallback (pós-gate)`

Cada task fica `pending` até o passo correspondente começar (`in_progress`) e `completed` quando o passo retornar. Tasks de gate (`Stage 2g`) fecham **imediatamente após o editor aprovar** — não esperar o title-picker. Detalhe completo em `.claude/agents/orchestrator.md` § "Task tracking — UI hygiene".

**No-op se TaskCreate/TaskUpdate não estiver disponível** (CLI puro fora do harness Claude Code).
- Se `$2 = social`: apenas o pré-requisito acima é necessário.
- Se `$2 = newsletter`: apenas o pré-requisito acima é necessário.

## Resume

Se `data/editions/$1/02-reviewed.md` já existir **e** `$2` não foi passado ou `$2 = newsletter`:

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

## Passo 1 — Drive sync pull (input)

Puxar versão mais recente de `01-approved.json` do Drive:

```bash
npx tsx scripts/drive-sync.ts --mode pull --edition-dir data/editions/$1/ --stage 2 --files _internal/01-approved.json
```

Falha de sync = warning, **nunca bloqueia**.

## Passo 1b — Aplicar caps editoriais Stage 2 (#358, #907)

Antes de passar o approved.json ao writer, truncar buckets aos limites de #358:

- Destaques: sem corte (sempre 3 após gate Stage 1)
- Lançamentos: ≤ 5
- Pesquisas: ≤ 3
- Outras Notícias: `max(2, 12 − destaques − lançamentos − pesquisas)`

```bash
npx tsx scripts/apply-stage2-caps.ts \
  --in data/editions/$1/_internal/01-approved.json \
  --out data/editions/$1/_internal/01-approved-capped.json
```

Writer (Passo 2) deve receber `01-approved-capped.json` em vez do raw. Falha do script (input ausente, etc.) = parar — sem caps o writer pode publicar 9 notícias quando cap esperado era 4 (caso real em 260507).

## Passo 2 — Dispatch paralelo

**Em uma única mensagem**, dispatchar os agents conforme `$2`:

### Se `$2` está ausente ou `$2 = all` (padrão — tudo em paralelo):

```
Agent({
  subagent_type: "writer",
  description: "Etapa 2 — newsletter writer",
  prompt: "Escreve a newsletter completa da edição $1 a partir de data/editions/$1/_internal/01-approved-capped.json (já com caps de #358 aplicados em Passo 1b). Seguir context/templates/newsletter.md e context/editorial-rules.md. Output: data/editions/$1/_internal/02-draft.md"
})

Agent({
  subagent_type: "social-linkedin",
  description: "Etapa 2 — LinkedIn writer",
  prompt: "Gera 3 posts de LinkedIn (um por destaque) a partir de data/editions/$1/_internal/01-approved.json. Output: data/editions/$1/_internal/03-linkedin.tmp.md com seções ## d1, ## d2, ## d3. Seguir context/templates/social-linkedin.md."
})

Agent({
  subagent_type: "social-facebook",
  description: "Etapa 2 — Facebook writer",
  prompt: "Gera 3 posts de Facebook (um por destaque) a partir de data/editions/$1/_internal/01-approved.json. Output: data/editions/$1/_internal/03-facebook.tmp.md com seções ## d1, ## d2, ## d3. Seguir context/templates/social-facebook.md."
})
```

### Se `$2 = newsletter`:

Dispatchar só `writer`. Pular steps de social abaixo.

### Se `$2 = social`:

Dispatchar `social-linkedin` + `social-facebook` em paralelo. Pular steps de newsletter abaixo.

Aguardar todos os Agents retornarem antes do passo seguinte.

## Passo 2b — Merge social + push intermediário ao Drive (antes de Clarice/Humanize)

Copiar draft da newsletter para raiz, mergear os tmp files de social em `03-social.md`, e fazer push para o editor poder revisar enquanto o processamento continua. Falha não bloqueia.

**Importante:** este passo executa o merge social que antes ficava em Passo 4a — sem isso, o push intermediário só pegaria a newsletter (os tmp files de social ainda não estão merged). Passo 4a é reduzido a cleanup dos tmp files.

```bash
cp data/editions/$1/_internal/02-draft.md data/editions/$1/02-reviewed.md

node -e "
  const fs=require('fs');
  const dir='data/editions/$1/';
  const li=fs.readFileSync(dir+'_internal/03-linkedin.tmp.md','utf8').trim();
  const fb=fs.readFileSync(dir+'_internal/03-facebook.tmp.md','utf8').trim();
  fs.writeFileSync(dir+'03-social.md','# LinkedIn\n\n'+li+'\n\n# Facebook\n\n'+fb+'\n');
"

npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/$1/ --stage 2 --files 02-reviewed.md,03-social.md
```

Se `$2 = newsletter`, pular o merge social (apenas cp + push de 02-reviewed.md).
Se `$2 = social`, pular o cp da newsletter (apenas merge + push de 03-social.md).

## Passo 3 — Processar newsletter (pular se `$2 = social`)

### 3a. Lint + normalize

```bash
npx tsx scripts/lint-newsletter-md.ts \
  --md data/editions/$1/_internal/02-draft.md \
  --approved data/editions/$1/_internal/01-approved-capped.json
npx tsx scripts/lint-newsletter-md.ts \
  --check title-length \
  --md data/editions/$1/_internal/02-draft.md
npx tsx scripts/lint-newsletter-md.ts \
  --check why-matters-format \
  --md data/editions/$1/_internal/02-draft.md
npx tsx scripts/lint-newsletter-md.ts \
  --check section-counts \
  --md data/editions/$1/_internal/02-draft.md \
  --approved data/editions/$1/_internal/01-approved-capped.json
npx tsx scripts/lint-newsletter-md.ts \
  --check destaque-min-chars \
  --md data/editions/$1/_internal/02-draft.md
npx tsx scripts/validate-domains.ts data/editions/$1/_internal/02-draft.md
npx tsx scripts/normalize-newsletter.ts \
  --in data/editions/$1/_internal/02-draft.md \
  --out data/editions/$1/_internal/02-draft.md
npx tsx scripts/lint-newsletter-md.ts \
  --check section-item-format \
  --md data/editions/$1/_internal/02-draft.md
```

`--check section-item-format` (#909) roda **depois** de normalize — se ainda houver item com título+descrição na mesma linha (caso heurístico do normalize não resolveu), exit 1 = re-disparar writer com instrução explícita de quebrar.

`--check section-counts` (#907) valida que LANÇAMENTOS, PESQUISAS, OUTRAS NOTÍCIAS no MD respeitam os caps de #358. Exit 1 = re-disparar writer com erro explicitado.

`--check destaque-min-chars` (#914) valida que cada destaque atinge o mínimo de chars (D1≥1000, D2/D3≥900). Exit 1 = re-disparar writer pra expandir.

### 3b. Clarice (inline)

**⚠️ Fail-fast obrigatório (#738):** Se qualquer `<system-reminder>` do runtime indicar que o MCP Clarice ficou offline, ou se a chamada `mcp__clarice__correct_text` retornar erro de disconnect/unavailable, **parar imediatamente** e reportar ao editor:
> `BLOQUEADO: MCP Clarice indisponível. Reconecte (verifique CLARICE_API_KEY e reinicie o MCP local) e responda "retry" para continuar, ou "skip" para pular Clarice nesta edição.`
Nunca aguardar passivamente. O MCP pode cair mid-session sem aviso do usuário — o `<system-reminder>` é o sinal de detecção. Tratar como mensagem de erro de alta prioridade.

Snapshot pré-Clarice (path canonical único — review #889 P3). `02-pre-clarice.md` serve simultaneamente como (a) sinal pra resume mid-Clarice (#874), (b) input do `clarice-diff.ts` (3d), (c) input do `verify-clarice-url-stability.ts` (#873). `clarice-diff.ts` aceita qualquer path posicional, então não precisa de alias.

```bash
cp data/editions/$1/_internal/02-draft.md data/editions/$1/_internal/02-pre-clarice.md
```

**Assertion obrigatória (review #889 P2).** Antes de chamar `mcp__clarice__correct_text`, verificar que o snapshot foi gravado. Se `_internal/02-pre-clarice.md` não existir nesse momento, **abortar** e logar erro:

```bash
test -f data/editions/$1/_internal/02-pre-clarice.md || {
  npx tsx scripts/log-event.ts --edition $1 --stage 2 --agent orchestrator --level error --message "pre-clarice snapshot missing — aborting before MCP Clarice call"
  echo "ERRO: snapshot pré-Clarice ausente — abortar antes de chamar MCP Clarice. Re-rodar /diaria-2-escrita $1 do zero." >&2
  exit 1
}
```

1. Ler `data/editions/$1/_internal/02-draft.md`.
2. Chamar `mcp__clarice__correct_text` passando o texto completo.
3. Salvar sugestões: `data/editions/$1/_internal/02-clarice-suggestions.json`.
4. Aplicar via helper:
   ```bash
   npx tsx scripts/clarice-apply.ts \
     --text-file data/editions/$1/_internal/02-draft.md \
     --suggestions data/editions/$1/_internal/02-clarice-suggestions.json \
     --out data/editions/$1/_internal/02-draft.md \
     --report data/editions/$1/_internal/02-clarice-report.json
   ```
5. Ler `_internal/02-clarice-report.json` para extrair contagens (`applied`, `skipped`).
6. Se `mcp__clarice__correct_text` falhar, **propagar o erro** — não silenciar.

### 3c. Humanize

Snapshot pré-Humanize antes de dispatchar o agent — usado para rollback se o agent falhar OU se o draft pós-humanize ficar corrompido (perda de seção, perda de URL, etc.):

```bash
cp data/editions/$1/_internal/02-draft.md data/editions/$1/_internal/02-draft.pre-humanize.md
```

```
Agent({
  description: "Humanizar newsletter $1",
  prompt: "Você é um editor especialista em remover marcas de IA em português brasileiro (humanizador v1.4.1).

Arquivo: data/editions/$1/_internal/02-draft.md

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

Regras de preservação: sem markdown (nada de **, #, - ), preservar template da newsletter (seções, estrutura, links, listas de notícias), não alterar URLs."
})
```

Se o Agent retornar erro OU se uma checagem rápida pós-humanize indicar corrupção (`02-draft.md` vazio, sem seção É IA?, sem alguma das URLs originais), restaurar o snapshot:

```bash
cp data/editions/$1/_internal/02-draft.pre-humanize.md data/editions/$1/_internal/02-draft.md
```

Falha **não bloqueia** — fallback restaura o snapshot pré-humanize.

### 3d. Validações finais

Copiar o draft final para a versão que o editor revisa **antes** de rodar verify/diff — assim a verificação de URLs e o diff são feitos contra o mesmo path que o orchestrator usa (review #889 P1 — consistência de paths):

```bash
cp data/editions/$1/_internal/02-draft.md data/editions/$1/02-reviewed.md
```

`clarice-diff.ts` lê argumentos posicionais. Diff é entre o pré-Clarice (snapshot canonical `02-pre-clarice.md`) e `02-reviewed.md`, mostrando o efeito líquido das passagens editoriais sobre o draft cru do writer:

```bash
npx tsx scripts/validate-lancamentos.ts data/editions/$1/02-reviewed.md
npx tsx scripts/clarice-diff.ts \
  data/editions/$1/_internal/02-pre-clarice.md \
  data/editions/$1/02-reviewed.md \
  data/editions/$1/_internal/02-clarice-diff.md
```

**Sync intro count (#743, #876, #906) — corrigir 'Selecionamos os N mais relevantes':**

```bash
npx tsx scripts/sync-intro-count.ts \
  --md data/editions/$1/02-reviewed.md \
  --lancamentos-removed data/editions/$1/_internal/02-lancamentos-removed.json
```

Após caps (#358) + lançamentos rejeitados, o número declarado na intro pode divergir do número real de artigos no body (writer copia `coverage.line` do approved.json bruto, que não reflete os caps). Script conta URLs editoriais reais e corrige cirurgicamente — só o número, sem mexer no resto. `--lancamentos-removed` é opcional; quando ausente, sync-intro-count ignora silenciosamente o ajuste de "X lançamentos".

**Render seção ERRO INTENCIONAL (#911) — revelar gabarito da edição anterior:**

```bash
npx tsx scripts/render-erro-intencional.ts \
  --edition $1 \
  --md data/editions/$1/02-reviewed.md
```

Lê `data/intentional-errors.jsonl`, encontra o erro intencional declarado da edição anterior mais recente (`is_feature: true` + `edition < $1`), compõe parágrafo de revelação com `detail` + `gabarito`, e insere/atualiza a seção `**ERRO INTENCIONAL**` no MD antes de ASSINE/encerramento. Idempotente: re-executar não duplica a seção. Sem erro anterior declarado, emite placeholder neutro ("não trazia erro intencional declarado") + convite à participação atual.

**Estabilidade de URLs em LANÇAMENTOS pós-Clarice (#873).** Clarice/humanizador podem "limpar" URLs (remover utm, normalizar path, trailing slash), o que quebra a regra "LANÇAMENTOS só com link oficial" (#160). Comparar pré-Clarice vs `02-reviewed.md` final (mesmo path usado pelo orchestrator — review #889 P1):

```bash
npx tsx scripts/verify-clarice-url-stability.ts \
  --pre data/editions/$1/_internal/02-pre-clarice.md \
  --post data/editions/$1/02-reviewed.md
```

Exit 0 = URLs em LANÇAMENTOS estáveis. Exit 1 = URL alterada — incluir output (com diff `antes/depois`) no prompt do gate humano. Não auto-restaurar — editor decide se aceita a versão pós-Clarice ou restaura manualmente em `02-reviewed.md`.

### 3e. Push incremental ao Drive (#903)

Newsletter pós-Clarice/humanize está estável. Subir pro Drive **agora** — não esperar o social terminar (passo 4). Editor pode revisar `02-reviewed.md` no celular enquanto a pipeline de social ainda processa em paralelo. Falha não bloqueia (passo 5 sobe novamente como fallback).

```bash
npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/$1/ --stage 2 --files 02-reviewed.md
```

Pular se `$2 = social` (newsletter não foi processada nessa run).

## Passo 4 — Processar social (pular se `$2 = newsletter`)

### 4a. Cleanup dos tmp files (merge já feito no Passo 2b)

```bash
node -e "
  const fs=require('fs');
  const dir='data/editions/$1/';
  if (fs.existsSync(dir+'_internal/03-linkedin.tmp.md')) fs.unlinkSync(dir+'_internal/03-linkedin.tmp.md');
  if (fs.existsSync(dir+'_internal/03-facebook.tmp.md')) fs.unlinkSync(dir+'_internal/03-facebook.tmp.md');
"
```

### 4b. Clarice

1. Ler `data/editions/$1/03-social.md`.
2. Chamar `mcp__clarice__correct_text` passando o texto completo.
3. Salvar sugestões: `data/editions/$1/_internal/03-clarice-suggestions.json`.
4. Aplicar via helper:
   ```bash
   npx tsx scripts/clarice-apply.ts \
     --text-file data/editions/$1/03-social.md \
     --suggestions data/editions/$1/_internal/03-clarice-suggestions.json \
     --out data/editions/$1/03-social.md \
     --report data/editions/$1/_internal/03-clarice-report.json
   ```
5. **Verificar integridade dos cabeçalhos**: as seções `# LinkedIn`, `# Facebook`, `## d1`, `## d2`, `## d3` ainda devem existir. Se algum sumiu, restaurar via `Edit` antes de continuar.
6. Se `mcp__clarice__correct_text` falhar, **propagar o erro**.

### 4c. Humanize

Snapshot pré-Humanize antes de dispatchar — usado para rollback se o agent falhar OU se as seções `# LinkedIn` / `# Facebook` / `## d1`-`d3` desaparecerem:

```bash
cp data/editions/$1/03-social.md data/editions/$1/_internal/03-social.pre-humanize.md
```

```
Agent({
  description: "Humanizar social $1",
  prompt: "Você é um editor especialista em remover marcas de IA em português brasileiro (humanizador v1.4.1).

Arquivo: data/editions/$1/03-social.md

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
cp data/editions/$1/_internal/03-social.pre-humanize.md data/editions/$1/03-social.md
```

Falha **não bloqueia**.

### 4d. Push incremental ao Drive (#903)

Social pós-Clarice/humanize está estável. Subir pro Drive **agora** — independente da newsletter (passo 3 pode já ter terminado e subido em 3e, ou ainda estar processando). Editor revisa cada arquivo assim que estabiliza, sem esperar a pipeline inteira. Falha não bloqueia (passo 5 sobe novamente como fallback).

```bash
npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/$1/ --stage 2 --files 03-social.md
```

Pular se `$2 = newsletter` (social não foi processado nessa run).

## Passo 5 — Drive sync push (final fallback)

Re-roda o push com **ambos** os arquivos. Garante que qualquer alteração pós-3e/4d (ex: editor mexendo no arquivo entre passos) seja capturada, e cobre o caso onde os pushes incrementais falharam silenciosamente. Pulado individualmente quando `$2` limita escopo.

```bash
npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/$1/ --stage 2 --files 02-reviewed.md,03-social.md
```

Anotar warnings pra mencionar no gate. Falha não bloqueia.

Após o push, limpar os snapshots intermediários (não precisam mais — rollback foi concluído ou não foi necessário). **Manter** `_internal/02-pre-clarice.md` até o gate humano fechar — ele é o sinal pra resume mid-Clarice (#874) e some só após o sentinel do Stage 2 ser escrito (Passo 7 ou Passo 6 com `--no-gate`):

```bash
for f in \
  data/editions/$1/_internal/02-draft.pre-humanize.md \
  data/editions/$1/_internal/03-social.pre-humanize.md; do
  [ -f "$f" ] && rm "$f"
done
```

## Passo 6 — Gate humano unificado

**Importante (#589, #159):** title-picker é **fallback pós-gate**, não pre-gate. Editor revisa newsletter com **3 opções de título por destaque** e poda manualmente o que quer manter. Se aprovar sem podar, title-picker (Opus) escolhe automaticamente como fallback no Passo 7.

**Se `--no-gate`:** pular este passo. Ir direto pro Passo 7 (title-picker fallback se necessário) e finalizar com `[AUTO] Etapa 2 auto-aprovada`.

**Caso contrário:** apresentar ao usuário (omitir seções não geradas se `$2` limitou o escopo):

```
Etapa 2 — Escrita pronta.

📁 Newsletter: data/editions/$1/02-reviewed.md
   ⚠️  Cada destaque tem 3 opções de título — apague 2 antes de aprovar,
       ou aprove direto pra deixar o title-picker (Opus) escolher.

📁 Social: data/editions/$1/03-social.md
📁 Drive: Work/Startups/diar.ia/edicoes/{YYMM}/$1/

Newsletter — Clarice: A aplicadas, B skipadas
Social — Clarice: C aplicadas, D skipadas

Posts gerados:
- LinkedIn d1 / d2 / d3
- Facebook d1 / d2 / d3

(pode editar diretamente no arquivo ou no Drive antes de aprovar)

Aprovar (sim) / pedir retry / editar manualmente?
```

Aguardar resposta. Se "sim", **continuar para Passo 7 (title-picker fallback)**. Se "retry", re-rodar Passo 2 em diante. Se "editar", instruir o usuário a editar o arquivo e retornar `sim`.

## Passo 7 — Title-picker fallback pós-aprovação (newsletter, se não pulado)

**Roda APÓS aprovação do gate** — só se o editor não podou os títulos manualmente. Per `.claude/agents/title-picker.md` #159: este agent é fallback pra quando o editor confia na decisão automática.

Se editor já editou diretamente no arquivo/Drive antes de aprovar, este passo é no-op (lint passa).

```bash
# Pull pós-aprovação (editor pode ter podado no Drive)
npx tsx scripts/drive-sync.ts --mode pull --edition-dir data/editions/$1/ --stage 2 --files 02-reviewed.md

# Verificar titles-per-highlight
npx tsx scripts/lint-newsletter-md.ts --check titles-per-highlight --md data/editions/$1/02-reviewed.md
```

Se lint retornar erro (>1 título por destaque), disparar title-picker:

```
Agent({
  subagent_type: "title-picker",
  description: "Escolher título final por destaque (fallback pós-gate)",
  prompt: "Editor aprovou Etapa 2 sem podar manualmente os 3 títulos por destaque. Leia data/editions/$1/02-reviewed.md e escolha 1 dos títulos por destaque, reescrevendo o arquivo. Preservar todo o resto. Justificar escolhas em data/editions/$1/_internal/02-title-picks.json."
})
```

Após title-picker, re-rodar lint:
```bash
npx tsx scripts/lint-newsletter-md.ts --check titles-per-highlight --md data/editions/$1/02-reviewed.md
```

## Passo 7b — Inserir TÍTULO/SUBTÍTULO no topo (#916)

Roda **depois** que cada destaque tem 1 só título (pós-poda manual do gate ou pós title-picker). Insere bloco `TÍTULO`/`SUBTÍTULO` no topo do `02-reviewed.md` que Stage 4 (publicação Beehiiv) usa pra preencher subject line + preview text. Sem isso, é trabalho manual do editor todo dia. Idempotente — re-rodar não duplica.

```bash
npx tsx scripts/insert-titulo-subtitulo.ts \
  --in data/editions/$1/02-reviewed.md
```

Falha = warning, **não bloqueia** (gate já aprovou). Se parse de DESTAQUEs quebrar, editor preenche manualmente como antes.

## Passo 7c — Push final ao Drive

```bash
npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/$1/ --stage 2 --files 02-reviewed.md
```

Erro do agent (Passo 7) reportado ao editor — sem fallback automático adicional.

**Cleanup do snapshot pré-Clarice (#874).** Após o gate fechar (com ou sem title-picker), o snapshot `_internal/02-pre-clarice.md` pode ser removido — não há mais resume mid-Clarice possível pra essa edição:

```bash
[ -f data/editions/$1/_internal/02-pre-clarice.md ] && rm data/editions/$1/_internal/02-pre-clarice.md
```

## Outputs

- `data/editions/$1/02-reviewed.md` — newsletter final
- `data/editions/$1/03-social.md` — posts LinkedIn + Facebook (seções `# LinkedIn`/`# Facebook`, cada uma com `## d1`/`## d2`/`## d3`)
- `data/editions/$1/_internal/02-clarice-diff.md` — diff da Clarice na newsletter
- `data/editions/$1/_internal/02-clarice-report.json` — relatório de sugestões newsletter
- `data/editions/$1/_internal/03-clarice-report.json` — relatório de sugestões social

**Outputs intermediários (mid-stage, removidos no fim):**
- `data/editions/$1/_internal/02-pre-clarice.md` — snapshot do input do Clarice (#874 — sinal pra resume mid-Clarice; #873 — input pro check de estabilidade de URLs). Removido após o gate fechar.

## Notas

- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
- Os agentes social leem diretamente de `_internal/01-approved.json` — não dependem de `02-reviewed.md`.
- Se o orchestrator subagent ainda existir em `.claude/agents/orchestrator.md`, ignorar — este skill não delega.
