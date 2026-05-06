---
name: diaria-mensal
description: Gera o digest mensal da Diar.ia agrupando os destaques publicados nas edições do mês em 3 narrativas temáticas (com Brasil garantido) + 10 Outras Notícias. Uso — `/diaria-mensal YYMM [--no-gate]`. 4 etapas com gate ao final de cada uma; publicação Beehiiv é follow-up (#188).
---

# /diaria-mensal

Produz uma edição **mensal** da Diar.ia consolidando os destaques publicados nas edições diárias do mês escolhido.

## Argumentos

- `$1` = mês no formato `YYMM` (ex: `2604` = abril 2026). **Se não passar, perguntar explicitamente** — nunca inferir a partir de `today()`. Sugerir mês atual / mês anterior como atalhos mas exigir confirmação:

  > "Você não passou o mês da edição mensal. Qual mês quer processar? mês atual ({YYMM_atual}) / mês anterior ({YYMM_anterior}) / outro (informe YYMM)"

- `--no-gate` (opcional) = pular todos os gates humanos. Auto-aprova cada etapa e prossegue direto ao final.

## Pré-requisitos

- Beehiiv MCP funcional (conector nativo do Claude Code).
- `platform.config.json → beehiiv.publicationId` populado.
- `context/audience-profile.md`, `context/editorial-rules.md`, `context/templates/newsletter-monthly.md` existem e não são placeholders.

**Não há dependência de `data/editions/{AAMMDD}/` local.** O digest puxa direto do Beehiiv, funcionando em qualquer máquina.

## Resume check global

Antes de iniciar, verificar o estado do disco (de baixo para cima):

- `01-eia.md` + `04-d1-2x1.jpg` existem → Etapa 3 completa. Pular para Etapa 4.
- `draft.md` existe → Etapa 2 completa. Pular para Etapa 3.
- `prioritized.md` existe → Etapa 1 completa. Pular para Etapa 2.
- Caso contrário → começar pela Etapa 1.

---

## Etapa 1 — Coleta e Análise

### 1a. Coleta via Beehiiv MCP

**Resume check (#400):**
```bash
RAW_POSTS=$(ls data/monthly/$1/raw-posts/*.txt 2>/dev/null | wc -l)
RAW_DESTAQUES=$(test -f data/monthly/$1/_internal/raw-destaques.json && echo "yes" || echo "no")
```
- `RAW_POSTS > 0` e `RAW_DESTAQUES = yes` → pular 1a e 1b.
- `RAW_POSTS > 0` e `RAW_DESTAQUES = no` → pular 1a, executar 1b.
- `RAW_POSTS = 0` → executar 1a e 1b (mesmo que `_internal/raw-destaques.json` exista — pode ser de run anterior via fallback local, #400).

**Coleta (inline — não via subagente, #403):** Chamar os MCPs Beehiiv **diretamente** neste contexto:
1. `mcp__ed929847-ab29-43d9-a6ba-60b687b65702__list_posts` — `publication_id`, `status="confirmed"`, `per_page=50`. Paginar e filtrar client-side pela janela do mês `[$1]`.
2. Para cada post: derivar `AAMMDD` do `published_at`, `id_prefix` (8 chars sem `post_`). Path: `data/monthly/$1/raw-posts/post_{id_prefix}_{AAMMDD}.txt`. Pular se já existe (resume). Caso contrário: `mcp__ed929847-ab29-43d9-a6ba-60b687b65702__get_post_content` → gravar `markdown` (preferido) ou `html` (fallback).

Se `posts_found = 0`, abortar.

**Parse:**
```bash
npx tsx scripts/collect-monthly.ts $1
```
Se `destaques_count < 3`, abortar.

### 1b. Scoring mensal

**Resume check:** verificar se todos os destaques em `_internal/raw-destaques.json` já têm o campo `score` não-nulo. Se sim, pular.

```bash
node -e "const d=JSON.parse(require('fs').readFileSync('data/monthly/$1/_internal/raw-destaques.json','utf8')); const missing=d.destaques.filter(x=>x.score==null).length; console.log(missing===0?'scored':'missing:'+missing)"
```

Se `missing > 0`, disparar `scorer-monthly` via `Agent`:
- `raw_path = data/monthly/$1/_internal/raw-destaques.json`
- `out_path = data/monthly/$1/_internal/raw-destaques.json`

O scorer sobrescreve o arquivo adicionando `score` a cada destaque.

### 1c. Análise temática

Disparar `analyst-monthly` via `Agent`:
- `raw_path = data/monthly/$1/_internal/raw-destaques.json`
- `out_path = data/monthly/$1/prioritized.md`
- `yymm = $1`

### Gate Etapa 1 (pulado com `--no-gate`)

Drive sync push: `npx tsx scripts/drive-sync.ts --mode push --edition-dir data/monthly/$1/ --stage 1 --files prioritized.md` (warning se falhar, nunca bloqueia).

Apresentar ao editor:
```
D1: {tema} ({N} artigos)
D2: {tema} ({N} artigos)
D3: {tema} ({N} artigos)
Outras Notícias: {N} itens

Aprovar? sim / editar / retry
```
- `editar` → editor edita `prioritized.md` local/Drive; re-rodar analista após confirmação.
- `retry` → re-disparar `analyst-monthly`.

---

## Etapa 2 — Escrita

Disparar `writer-monthly` via `Agent`:
- `prioritized_path = data/monthly/$1/prioritized.md`
- `raw_path = data/monthly/$1/_internal/raw-destaques.json`
- `out_path = data/monthly/$1/draft.md`
- `yymm = $1`

O agente escreve `draft.md` + gera `_internal/02-d1-prompt.md` (prompt Van Gogh impasto do D1 para Etapa 3).

### 2b. Lint de chars

```bash
npx tsx scripts/lint-monthly-draft.ts $1
```

Emite warnings (não bloqueia) se D1 > 1.500 ou D2/D3 > 1.200 chars.

### 2c. Humanizador

Invocar skill humanizador in-place no `draft.md`:

```
Skill("humanizador", "Leia data/monthly/$1/draft.md, humanize o texto removendo marcas de IA em português, calibrando a voz com context/past-editions.md como referência, e salve o resultado no mesmo arquivo.")
```

Se falhar: warning, seguir com o arquivo original (não bloqueia).

### 2d. Clarice

1. Ler `data/monthly/$1/draft.md`.
2. Chamar `mcp__clarice__correct_text` passando o texto completo.
3. Salvar sugestões: `data/monthly/$1/_internal/02-clarice-suggestions.json`.
4. Aplicar:
```bash
npx tsx scripts/clarice-apply.ts \
  --text-file data/monthly/$1/draft.md \
  --suggestions data/monthly/$1/_internal/02-clarice-suggestions.json \
  --out data/monthly/$1/draft.md \
  --report data/monthly/$1/_internal/02-clarice-report.json
```

Se `clarice-apply.ts` falhar: warning, seguir com o arquivo original (não bloqueia).

### Gate Etapa 2 (pulado com `--no-gate`)

Drive sync push: `npx tsx scripts/drive-sync.ts --mode push --edition-dir data/monthly/$1/ --stage 2 --files draft.md,_internal/02-d1-prompt.md,_internal/02-chosen-subject.txt` — **warning se falhar, nunca bloqueia**. (`02-chosen-subject.txt` só existe se o editor tiver escolhido o subject no gate; `02-d1-prompt.md` só existe se o writer tiver gerado o prompt de imagem.)

Drive sync pull antes de apresentar ao editor (ele pode ter editado no Drive após o push): `--mode pull --files draft.md` — idem, warning se falhar.

Apresentar:
```
📄 draft.md gerado.
Opções de subject:
  1. {opção 1}
  2. {opção 2}
  3. {opção 3}

Aprovar? sim [+ número do subject escolhido] / editar / retry
```

**Após aprovação (#421):** se o editor informar o número do subject escolhido (ex: "2"), extrair a linha completa do draft e salvar em `data/monthly/$1/_internal/02-chosen-subject.txt`:
```bash
CHOICE=2  # número informado pelo editor
node -e "
  const t = require('fs').readFileSync('data/monthly/$1/draft.md','utf8');
  const m = t.match(/^ASSUNTO[\s\S]*?\n${CHOICE}\. (.+)/m);
  if (m) require('fs').writeFileSync('data/monthly/$1/_internal/02-chosen-subject.txt', m[1].trim());
"
```
Isso salva o texto completo (ex: `Diar.ia | Abril 2026 — 30 milhões de empregos em risco`), não só o número. Qualquer reescrita posterior restaura exatamente essa linha no ASSUNTO.

**Invariante do ASSUNTO:** qualquer passo posterior que modifique `draft.md` (humanizador, Clarice, ajustes de formato) deve usar `Edit` (substituição pontual), nunca `Write` (overwrite completo). Se `Write` for inevitável, ler `02-chosen-subject.txt` antes e restaurar o ASSUNTO correto imediatamente após. O ASSUNTO escolhido pelo editor nunca pode ser sobrescrito silenciosamente.

---

## Etapa 3 — Imagens

**Resume check:** `04-d1-2x1.jpg` e `01-eia.md` existem → pular Etapa 3, ir para Etapa 4.

Disparar **em paralelo** (mesma mensagem):

**D1:**
```bash
npx tsx scripts/image-generate.ts \
  --editorial data/monthly/$1/_internal/02-d1-prompt.md \
  --out-dir data/monthly/$1/ \
  --destaque d1
```
Se `_internal/02-d1-prompt.md` não existir, emitir aviso e pular (não bloquear).

**É IA? mensal (novo):**
```bash
EAI_EDITION=$(node -e "
  const y='$1', yr=2000+parseInt(y.slice(0,2)), mo=parseInt(y.slice(2,4));
  const last=new Date(Date.UTC(yr,mo,0)).getUTCDate();
  process.stdout.write(String(yr).slice(2)+String(mo).padStart(2,'0')+String(last).padStart(2,'0'));
")
npx tsx scripts/eia-compose.ts --edition $EAI_EDITION --out-dir data/monthly/$1/
```
Se falhar (sem imagem elegível), registrar warn e seguir — É IA? é opcional.

### Gate Etapa 3 (pulado com `--no-gate`)

Drive sync push: `04-d1-2x1.jpg,04-d1-1x1.jpg,01-eia-A.jpg,01-eia-B.jpg`.

Apresentar:
```
📸 D1: data/monthly/$1/04-d1-2x1.jpg
🤔 É IA? A: data/monthly/$1/01-eia-A.jpg
🤔 É IA? B: data/monthly/$1/01-eia-B.jpg

Aprovar? sim / regenerar-d1 / regenerar-eia
```

---

## Etapa 4 — Publicação Brevo

**Resume check:** `_internal/05-published.json` existe com `status: "test_sent"` → pular para o gate.

### 4a. Drive sync pull

Pull do `draft.md` antes de converter (editor pode ter editado no Drive após Etapa 2):

```bash
npx tsx scripts/drive-sync.ts --mode pull --edition-dir data/monthly/$1/ --stage 4 --files draft.md
```

Warning se falhar, nunca bloqueia.

### 4b. Verificar pré-requisitos do Brevo

Antes de rodar o script, verificar se `brevo_monthly.list_id` e `brevo_monthly.sender_email` estão preenchidos:

```bash
node -e "
  const c = JSON.parse(require('fs').readFileSync('platform.config.json','utf8')).brevo_monthly;
  const missing = [];
  if (!c.list_id) missing.push('list_id');
  if (!c.sender_email) missing.push('sender_email');
  if (missing.length) {
    console.error('ERRO: campos não configurados em platform.config.json → brevo_monthly:', missing.join(', '));
    console.error('Completar checklist de #653 antes de prosseguir.');
    process.exit(1);
  }
  console.log('ok');
"
```

Se falhar com `ERRO: campos não configurados`, apresentar ao editor:

```
⛔ Publicação Brevo bloqueada: {campos} não configurados em platform.config.json.

Para desbloquear, complete a configuração da conta Brevo (#653):
  1. Criar lista de contatos no painel Brevo → copiar o ID numérico
  2. Verificar o email remetente no painel Brevo
  3. Preencher em platform.config.json → brevo_monthly: { list_id: <ID>, sender_email: "<email>" }
  4. Garantir que BREVO_CLARICE_API_KEY está definido no .env

Alternativa manual: abrir https://app.brevo.com e criar a campanha manualmente colando draft.md.
```

Encerrar Etapa 4 (não é bloqueio de pipeline — editor pode publicar manualmente).

### 4c. Criar campanha e enviar email de teste

```bash
npx tsx scripts/publish-monthly.ts --yymm $1 --send-test
```

O script:
- Converte `draft.md` para HTML de email
- Usa o subject de `_internal/02-chosen-subject.txt` (se existir) ou a opção 1 do ASSUNTO
- Cria campanha Brevo como rascunho
- Envia email de teste para `platform.config.json → brevo_monthly.test_email`
- Salva `_internal/05-published.json`

Se o script falhar com erro de API:
- Verificar que `BREVO_CLARICE_API_KEY` está definido e é válido
- Se `list_id` ou `sender_email` ainda nulos: ver mensagem de bloqueio acima
- Se erro HTTP 4xx da API Brevo: exibir mensagem completa ao editor e encerrar (não retry)

### 4d. Revisar email de teste

Disparar `review-test-email` via `Agent`:

```
Agent({
  subagent_type: "review-test-email",
  prompt: "
    test_email: {brevo_monthly.test_email de platform.config.json}
    edition_title: {subject de _internal/05-published.json}
    edition_dir: data/monthly/$1/
    attempt: 1
    platform: brevo
  "
})
```

O agente busca o email de teste via Gmail MCP (from:brevo.com) e verifica a estrutura mensal.

Se `review-test-email` retornar `issues` não-vazias, exibir ao editor junto com o gate.

### Gate Etapa 4 (pulado com `--no-gate`)

Ler `_internal/05-published.json` e apresentar:

```
📧 Campanha Brevo criada e email de teste enviado.

Assunto: {subject}
Preview: {preview_text}
Dashboard: {brevo_dashboard_url}
Teste enviado para: {test_email}

{se issues do review-test-email → listar aqui}

Próximos passos manuais (Etapa Clarice):
  1. Abrir o dashboard Brevo acima
  2. Preencher as seções CLARICE — DIVULGAÇÃO e CLARICE — TUTORIAL (marcadas com borda tracejada)
  3. Adicionar imagem D1 (data/monthly/$1/04-d1-2x1.jpg) no topo da campanha
  4. Revisar e enviar para a lista de contatos da Clarice

Aprovado? sim / retry (regenerar campanha)
```

- `retry` → re-rodar 4c com nova campanha (o script sempre cria uma campanha nova; a anterior fica como rascunho no Brevo e pode ser deletada manualmente)
- `sim` → encerrar pipeline mensal

---

## Outputs

Todos em `data/monthly/{YYMM}/`:

- `_internal/raw-destaques.json` — coleta bruta (Etapa 1)
- `prioritized.md` — destaques aprovados (Etapa 1)
- `draft.md` — texto final (Etapa 2)
- `_internal/02-d1-prompt.md` — prompt imagem D1 (Etapa 2)
- `04-d1-2x1.jpg` + `04-d1-1x1.jpg` — imagem D1 (Etapa 3)
- `01-eia.md` + `01-eia-A.jpg` + `01-eia-B.jpg` — É IA? novo (Etapa 3)
- `_internal/05-published.json` — campanha Brevo criada (Etapa 4)

## Notas

- **Apenas manual** — sem agendamento automático.
- **Publicação final é responsabilidade da Clarice** — o pipeline cria o rascunho, eles preenchem as seções de divulgação e enviam para a lista deles.
- **Brevo list_id e sender_email** precisam estar configurados em `platform.config.json → brevo_monthly` (#653). Se nulos, Etapa 4 exibe instruções e encerra sem bloquear.
