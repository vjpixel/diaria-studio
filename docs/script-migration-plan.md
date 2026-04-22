# Plano de migração: agentes LLM → scripts determinísticos

Vários subagentes na pipeline Diar.ia são invocados via `Task` (spawn de contexto + LLM) mas executam lógica que não precisa de IA: IO de arquivo, HTTP, comparação de strings, chamadas de API estruturadas. Cada `Task` custa latência (~2-5s de cold start) e tokens de contexto. Migrar para scripts TypeScript chamados diretamente via `Bash` pelo orchestrator elimina esse overhead sem perder funcionalidade.

**Princípio:** se o "raciocínio" do agente pode ser reduzido a um conjunto de regras codificáveis, é script.

---

## Resumo por prioridade

| # | Agente atual | Tipo | Esforço | Impacto/edição | Status |
|---|---|---|---|---|---|
| 1 | `deduplicator` | Script puro | Baixo | −1 Task, ~50 comparações URL | ✅ feito (`scripts/dedup.ts`) |
| 2 | `link-verifier` | Script puro | Médio | −3 a 5 Tasks (chunks), ~50 URLs | ⬜ pendente |
| 3 | `drive-syncer` | Script puro | Médio | −5 Tasks (1 por stage) | ⬜ pendente |
| 4 | `refresh-dedup-runner` | Script puro | Baixo | −1 Task por edição (já tem backing script) | ⏸ bloqueado (usa Beehiiv MCP — orchestrator não tem acesso direto) |
| 5 | `inbox-drainer` | Script puro | Baixo | −1 Task por edição | ⬜ pendente |
| 6 | `clarice-runner` | Script puro | Baixo | −1 a 2 Tasks por edição | ✅ feito (inline no orchestrator + `scripts/clarice-diff.ts`) |
| 7 | `categorizer` | Híbrido | Médio | LLM só para ~5% ambíguos | ⬜ pendente |
| 8 | `source-researcher` | Híbrido | Alto | LLM só para fontes sem RSS | ⬜ pendente |
| 9 | `image-prompter` | Script puro | Médio | −1 Task (prompt já pronto) | ✅ feito (`scripts/image-generate.ts`) |
| 10 | `eai-composer` | Híbrido | Médio | Separa POTD fetch vs texto | ⬜ pendente |
| 11 | `discovery-searcher` | Híbrido | Alto | Queries templated, LLM só no filtro | ⬜ pendente |

---

## Detalhamento

### 1. `deduplicator` → `scripts/dedup.ts`

**O que faz hoje:** recebe lista de artigos, lê `context/past-editions.md`, remove artigos que já apareceram nas últimas 3 edições.

**Por que não precisa de LLM:** a lógica é:
1. Normalizar URL (sem `www`, sem trailing `/`, sem parâmetros UTM)
2. Match exato de URL normalizada
3. Levenshtein de título < threshold (ex: 0.85 similaridade) para pegar variações do mesmo artigo com URL diferente

**Interface proposta:**
```bash
npx tsx scripts/dedup.ts \
  --articles-json '[...]' \
  --past-editions context/past-editions.md \
  --window 3
# stdout: JSON com artigos filtrados + { removed: N, reasons: [...] }
```

**Orchestrator:** substituir `Task("deduplicator", ...)` por `Bash("npx tsx scripts/dedup.ts ...")`.

---

### 2. `link-verifier` → `scripts/link-verifier.ts`

**O que faz hoje:** recebe chunks de URLs, retorna verdict `ok`/`paywall`/`aggregator`/`blocked` para cada uma.

**Por que não precisa de LLM:**
- `aggregator`: domínio em blocklist hardcoded (flipboard.com, feedly.com, alltop.com etc.)
- `paywall`: HTTP 402/403 + regex em HTML (`class="paywall"`, `<meta name="robots" content="noindex">`, cookie-wall patterns)
- `blocked`: HTTP 4xx/5xx persistente
- `ok`: tudo que não se encaixar acima

**Interface proposta:**
```bash
npx tsx scripts/link-verifier.ts \
  --urls '["https://...","https://..."]'
# stdout: JSON com verdict por URL + tempo de resposta
```

**Nota:** rodar em paralelo nativo com `Promise.all` dentro do script — elimina o overhead de múltiplos Tasks. Todo o chunking que o orchestrator faz hoje some.

---

### 3. `drive-syncer` → `scripts/drive-sync.ts`

**O que faz hoje:** push de arquivos locais para Drive e pull de versões editadas no Drive para local. Usa MCP `08ef30f2-*`.

**Por que não precisa de LLM:** é IO puro:
- Push: lê `data/drive-cache.json` → `create_file` ou nova versão → atualiza cache
- Pull: `get_file_metadata(fileId)` → compara `modifiedTime` → `download_file_content` se Drive > local

**Desafio:** o script precisaria chamar MCPs — que hoje só são acessíveis dentro de agentes. Opções:
- (a) Manter como agente Haiku mas sem os `Task` extras — chamar `drive-syncer` diretamente como ferramenta inline do orchestrator (sem spawn Task)
- (b) Expor MCP via HTTP local e o script faz fetch (mais complexo)
- **(c) Recomendado:** script TypeScript usando o SDK do Google Drive direto (googleapis npm) com token OAuth salvo — sem depender do MCP

**Bloqueio:** requer credenciais OAuth de serviço ou token salvo. Documentar setup em `docs/google-drive-sdk-setup.md`.

---

### 4. `refresh-dedup-runner` → chamada direta de script

**O que faz hoje:** detecta bootstrap vs incremental, chama `scripts/refresh-past-editions.ts`, retorna JSON de resultado.

**Por que não precisa de LLM:** já é um wrapper. O agente existe só para dar interface de Task ao script.

**Mudança mínima:** orchestrator chama `Bash("npx tsx scripts/refresh-past-editions.ts --edition {YYMMDD}")` diretamente e lê o JSON de stdout. Remove o agente inteiro.

---

### 5. `inbox-drainer` → `scripts/inbox-drain.ts`

**O que faz hoje:** busca emails com label `diaria-inbox` no Gmail MCP, extrai URLs e tópicos, appenda em `data/inbox.md`.

**Por que não precisa de LLM:** `search_threads` + regex para extração de URL do corpo (primeira `https?://` por email). Tópico = assunto do email ou fallback para domínio da URL.

**Mesmo bloqueio do drive-syncer:** acesso ao Gmail MCP hoje é só dentro de agentes. Opção mais limpa: Gmail API direta com token OAuth (mesmo fluxo do item 3).

**Alternativa de curto prazo:** manter como agente Haiku mas chamado inline pelo orchestrator (sem Task overhead) — possível se o orchestrator tiver o tool `gmail` no seu próprio toolset.

---

### 6. `clarice-runner` → `scripts/clarice-run.ts`

**O que faz hoje:** recebe `in_path`, chama `mcp__clarice__correct_text`, salva resultado em `out_reviewed_path`, gera diff em `out_diff_path`.

**Por que não precisa de LLM:** o raciocínio de correção está na Clarice (MCP externo), não no agente. O agente só empacota a chamada.

**Mudança:** o orchestrator pode chamar `mcp__clarice__correct_text` diretamente (já tem `mcp__clarice__correct_text` no toolset do orchestrator.md) + gerar diff com `Bash("diff original.md reviewed.md > diff.md")`. Remove o agente.

**Mais simples ainda:** adicionar `mcp__clarice__correct_text` ao toolset do orchestrator e chamar inline. Zero código novo.

---

### 7. `categorizer` → híbrido (regras + LLM fallback)

**O que faz hoje:** classifica cada artigo em `lancamento` / `pesquisa` / `noticias`.

**Regras que cobrem ~95%:**
- `lancamento`: domínio do artigo ∈ lista de sites oficiais de produtos/empresas (openai.com, anthropic.com, google.com/blog, github.blog etc.) OU URL contém `/changelog`, `/release`, `/launch`, `/announcement`
- `pesquisa`: domínio ∈ `{arxiv.org, openreview.net, nature.com, *.edu, research.*.com}`
- `noticias`: tudo mais

**Implementação:** `scripts/categorize.ts` com listas de domínios + regex. Artigos que não casam com nenhuma regra clara (score de confiança < threshold) vão para uma lista de "ambíguos" que o LLM resolve em um único batch — em vez de processar todos.

---

### 8. `source-researcher` → híbrido (RSS-first + LLM fallback)

**O que faz hoje:** para cada fonte, busca artigos recentes e extrai title/summary/url/date.

**Oportunidade:** ~80% das fontes em `seed/sources.csv` têm RSS/Atom feed. Um script `fetchRSS(url)` extrai tudo sem LLM. LLM só entra quando:
- A fonte não tem RSS (scraping de HTML genérico)
- O feed retorna apenas título sem summary útil

**Esforço alto** porque requer mapear qual fonte tem RSS e qual não tem. Recomendo fazer depois dos items 1–6.

---

### 9. `image-prompter` → `scripts/image-prompter.ts`

**O que faz hoje:** lê os prompts `02-d{N}-prompt.md`, chama ComfyUI API, salva JPGs.

**Por que não precisa de LLM:** o prompt já está escrito pelo `writer`. O agente só faz POST → polling → download. ComfyUI tem API REST documentada.

**Interface:**
```bash
npx tsx scripts/image-prompter.ts \
  --prompts '["02-d1-prompt.md","02-d2-prompt.md","02-d3-prompt.md"]' \
  --out-dir data/editions/260418/
```

**Bloqueio parcial:** ComfyUI precisa estar rodando localmente (o agente atual já verifica isso via curl — o script faz o mesmo).

---

### 10. `eai-composer` → híbrido (POTD script + LLM para texto)

**O que faz hoje:** busca foto do dia da Wikimedia, verifica se é vertical/repetida, gera texto criativo, salva `04-eai.md` + `04-eai.jpg`.

**Separação natural:**
- `scripts/wikimedia-potd.ts`: fetch POTD API, download da imagem, verificações (vertical, já usada) — sem LLM
- LLM (inline no orchestrator ou agente mínimo): recebe metadados da foto e gera 2-3 linhas de texto

**Vantagem:** retry fica mais barato — se o texto não agrada, regenera só o texto sem refazer o fetch da imagem.

---

### 11. `discovery-searcher` → híbrido (queries templated + LLM no filtro)

**O que faz hoje:** cria queries temáticas a partir de `audience-profile.md`, busca na web, filtra por relevância.

**Oportunidade menor:** a composição de queries pode ser templated (temas de alta tração extraídos do audience-profile com regex), mas o filtro de relevância dos resultados depende de julgamento contextual. Provavelmente o ganho aqui não justifica o esforço vs os itens anteriores.

**Recomendo deixar para o final.**

---

## Ordem recomendada de execução

```
Fase A — Sem bloqueio externo (pode fazer agora):
  1. deduplicator         ← mais simples, maior impacto por artigo
  4. refresh-dedup-runner ← troca 5 linhas no orchestrator
  6. clarice-runner       ← mover tool call para inline no orchestrator
  9. image-prompter       ← ComfyUI API bem documentada

Fase B — Requer OAuth/API direta (setup único):
  5. inbox-drainer        ← Gmail API
  3. drive-syncer         ← Google Drive SDK

Fase C — Mais trabalhoso, ganho menor:
  2. link-verifier        ← HTTP + blocklist
  7. categorizer          ← regras de domínio
  8. source-researcher    ← RSS mapping por fonte
 10. eai-composer         ← separar fetch de texto
 11. discovery-searcher   ← menor ganho relativo
```

---

## Convenções dos scripts

- Todos em `scripts/` como TypeScript (`.ts`), rodando via `npx tsx`
- Input via flags CLI (`--flag value`) ou `--json-input` para payloads grandes
- Output sempre em `stdout` como JSON; erros em `stderr` + exit code 1
- Sem side effects além do que a flag `--out-*` indica — orchestrator decide onde salvar
