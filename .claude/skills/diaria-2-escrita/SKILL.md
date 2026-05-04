---
name: diaria-2-escrita
description: Roda a Etapa 2 (newsletter + social em paralelo, ambos a partir de `01-approved.json`). Uso — `/diaria-2-escrita AAMMDD [newsletter|social]`.
---

# /diaria-2-escrita

Executa a Etapa 2 da pipeline Diar.ia: dispara `writer` (newsletter) + `social-linkedin` + `social-facebook` **em paralelo**, ambos lendo diretamente de `_internal/01-approved.json` — sem dependência sequencial entre newsletter e social. Gate unificado ao final.

Self-contained — você (top-level Claude Code) executa todo o playbook aqui, sem delegar a um orchestrator subagente. (Workaround #207: runtime bloqueia `Agent` dentro de subagentes.)

## Argumentos

- `$1` = data da edição (`AAMMDD`, ex: `260423`). **Se não passar, perguntar explicitamente** ao usuário antes de prosseguir — nunca inferir a partir de `today()`. Sugerir hoje/ontem como atalhos mas exigir confirmação.
- `$2` (opcional) = `newsletter` | `social` — re-roda só um dos dois. Sem este argumento, roda ambos em paralelo.

## Placeholders

Os blocos Bash/Agent abaixo usam placeholders. **O Claude executando este skill substitui pelos valores reais antes de invocar cada tool.**

- `$1` → AAMMDD recebido como argumento (ex: `260423`). Aparece em paths e prompts de Agent.
- `{YYMM}` → primeiros 4 chars de `$1` (ex: `2604`). Aparece no path do Drive e no gate output.

## Pré-requisitos

- `data/editions/$1/_internal/01-approved.json` deve existir com `highlights[]` (scorer já rodou na Etapa 1). Se não, avise: rode `/diaria-1-pesquisa` primeiro e aprove.
- Se `$2 = social`: apenas o pré-requisito acima é necessário.
- Se `$2 = newsletter`: apenas o pré-requisito acima é necessário.

## Resume

Se `data/editions/$1/02-reviewed.md` já existir **e** `$2` não foi passado ou `$2 = newsletter`:
- Sem `--no-gate`: perguntar `"02-reviewed.md já existe — regenerar (sim/não)?"`. Se "não", usar o arquivo existente e ir direto ao gate.
- Com `--no-gate`: assumir que está OK, pular regeneração.

Mesma lógica para `03-social.md` quando `$2 = social` (ou sem argumento).

## Passo 1 — Drive sync pull (input)

Puxar versão mais recente de `01-approved.json` do Drive:

```bash
npx tsx scripts/drive-sync.ts --mode pull --edition-dir data/editions/$1/ --stage 2 --files _internal/01-approved.json
```

Falha de sync = warning, **nunca bloqueia**.

## Passo 2 — Dispatch paralelo

**Em uma única mensagem**, dispatchar os agents conforme `$2`:

### Se `$2` está ausente ou `$2 = all` (padrão — tudo em paralelo):

```
Agent({
  subagent_type: "writer",
  description: "Etapa 2 — newsletter writer",
  prompt: "Escreve a newsletter completa da edição $1 a partir de data/editions/$1/_internal/01-approved.json. Seguir context/templates/newsletter.md e context/editorial-rules.md. Output: data/editions/$1/_internal/02-draft.md"
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

## Passo 2b — Push intermediário ao Drive (antes de Clarice/Humanize)

Copiar draft para raiz e fazer push para o editor poder revisar enquanto o processamento continua. Falha não bloqueia.

```bash
cp data/editions/$1/_internal/02-draft.md data/editions/$1/02-reviewed.md
npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/$1/ --stage 2 --files 02-reviewed.md,03-social.md
```

## Passo 3 — Processar newsletter (pular se `$2 = social`)

### 3a. Lint + normalize

```bash
npx tsx scripts/lint-newsletter-md.ts data/editions/$1/_internal/02-draft.md
npx tsx scripts/normalize-newsletter.ts data/editions/$1/_internal/02-draft.md data/editions/$1/_internal/02-draft.md
```

### 3b. Clarice (inline)

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

Falha **não bloqueia** — fallback usa o arquivo original.

### 3d. Validações finais

```bash
npx tsx scripts/validate-lancamentos.ts data/editions/$1/_internal/02-draft.md
npx tsx scripts/clarice-diff.ts \
  --original data/editions/$1/_internal/02-draft.md \
  --corrected data/editions/$1/_internal/02-draft.md \
  --out data/editions/$1/_internal/02-clarice-diff.md
```

Copiar draft final para `data/editions/$1/02-reviewed.md`.

## Passo 4 — Processar social (pular se `$2 = newsletter`)

### 4a. Merge tmp files em 03-social.md

```bash
node -e "
  const fs=require('fs');
  const dir='data/editions/$1/';
  const li=fs.readFileSync(dir+'_internal/03-linkedin.tmp.md','utf8').trim();
  const fb=fs.readFileSync(dir+'_internal/03-facebook.tmp.md','utf8').trim();
  fs.writeFileSync(dir+'03-social.md','# LinkedIn\n\n'+li+'\n\n# Facebook\n\n'+fb+'\n');
  fs.unlinkSync(dir+'_internal/03-linkedin.tmp.md');
  fs.unlinkSync(dir+'_internal/03-facebook.tmp.md');
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

Falha **não bloqueia**.

## Passo 5 — Drive sync push (outputs)

```bash
npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/$1/ --stage 2 --files 02-reviewed.md,03-social.md
```

Anotar warnings pra mencionar no gate. Falha não bloqueia.

## Passo 6 — Title-picker (newsletter, se não pulado)

Após push, verificar títulos:

```bash
npx tsx scripts/lint-newsletter-md.ts --check titles-per-highlight data/editions/$1/02-reviewed.md
```

Se lint retornar erro (mais de 1 título por destaque), disparar title-picker:

```
Agent({
  subagent_type: "title-picker",
  description: "Escolher título final por destaque",
  prompt: "Leia data/editions/$1/02-reviewed.md e escolha 1 dos títulos por destaque, reescrevendo o arquivo. Preservar todo o resto."
})
```

Erro do agent deve ser reportado ao editor antes de prosseguir — não há fallback automático.

Após title-picker, re-rodar lint:
```bash
npx tsx scripts/lint-newsletter-md.ts --check titles-per-highlight data/editions/$1/02-reviewed.md
```

## Passo 7 — Gate humano unificado

**Se `--no-gate`:** pular este passo. Emitir `[AUTO] Etapa 2 auto-aprovada` e finalizar.

**Caso contrário:** apresentar ao usuário (omitir seções não geradas se `$2` limitou o escopo):

```
Etapa 2 — Escrita pronta.

📁 Newsletter: data/editions/$1/02-reviewed.md
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

Aguardar resposta. Se "sim", finalizar com sucesso. Se "retry", re-rodar Passo 2 em diante. Se "editar", instruir o usuário a editar o arquivo e retornar `sim`.

## Outputs

- `data/editions/$1/02-reviewed.md` — newsletter final
- `data/editions/$1/03-social.md` — posts LinkedIn + Facebook (seções `# LinkedIn`/`# Facebook`, cada uma com `## d1`/`## d2`/`## d3`)
- `data/editions/$1/_internal/02-clarice-diff.md` — diff da Clarice na newsletter
- `data/editions/$1/_internal/02-clarice-report.json` — relatório de sugestões newsletter
- `data/editions/$1/_internal/03-clarice-report.json` — relatório de sugestões social

## Notas

- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
- Os agentes social leem diretamente de `_internal/01-approved.json` — não dependem de `02-reviewed.md`.
- Se o orchestrator subagent ainda existir em `.claude/agents/orchestrator.md`, ignorar — este skill não delega.
