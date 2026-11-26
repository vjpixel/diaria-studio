# Pré-render da newsletter diária (Stage 4)

Passos de pré-render que o Stage 4 roda antes do gate (`.claude/agents/orchestrator-stage-4.md` §4b, passo 2) e que o `prep-manual-publish.ts` reaproveita. Saíram do playbook da Beehiiv no #14048: o playbook virou arquivo histórico no #11225 (hoje em `docs/archive/beehiiv-playbook.md`), mas estes passos continuam vivos. A numeração (§0, §0.1, §1.1 a §1.4) é a mesma do playbook, para as citações antigas continuarem fazendo sentido.

Nada aqui abre navegador nem envia e-mail: é render local, upload de imagem para o Worker KV e gabarito do É IA?.

### 0. Lint pre-flight — intentional_error (#754, migrado pra JSON #3222)

Antes de qualquer pré-render, validar que o editor forneceu o erro
intencional do mês em `_internal/intentional-error.json` (sibling de
`02-reviewed.md`). Convenção editorial: cada edição tem 1 erro proposital
pros assinantes (concurso mensal). Sem declaração, lints downstream não
distinguem erro intencional de erro real, e o concurso mensal precisa
garimpo manual.

**#3222 (260710):** os campos estruturados (description/location/category/
correct_value/reveal) migraram do frontmatter YAML de `02-reviewed.md` pra
`_internal/intentional-error.json` — esse arquivo nunca sincroniza com o
Drive (convenção `_internal/*`, #959), eliminando a corrupção recorrente do
round-trip via Google Docs (#3205). O editor agora fornece os campos via
chat, não mais editando o Doc.

```bash
npx tsx scripts/lint-newsletter-md.ts --check intentional-error-flagged \
  --md {edition_dir}/02-reviewed.md
```

(deriva `_internal/intentional-error.json` como sibling de `--md`.) **Edição rodou (ou está rodando) com `--no-gates` (#8897, 28/09/2026)?** Acrescentar `--headless true` — sem gate humano pra ler o warn de categoria de risco (numeric/factual/data, #2149), a checagem escala pra `exit 1` em vez de só logar, barrando a publicação de uma estatística plantada sem revisão.

Exit codes:
- `0`: declarado e válido — prosseguir.
- `1`: declaração ausente ou incompleta — **abortar** com:
    ```json
    { "error": "intentional_error_missing", "details": "Editor não forneceu intentional_error em _internal/intentional-error.json. Peça os campos ao editor via chat e grave o arquivo conforme exemplo no stderr do lint." }
    ```
    Editor fornece os campos (via chat) e o orchestrator grava `_internal/intentional-error.json`; re-rodar o stage.
- `2`: erro de uso (path inválido) — abortar com `{ "error": "lint_cli_failed" }`.

Esse lint roda antes da publicação pra garantir que erros intencionais
ficam registrados — mantém a auditoria do concurso possível.

#### 0.1 Sync intentional-error.json → intentional-errors.jsonl

Após o lint passar, sincronizar os campos estruturados pra `data/intentional-errors.jsonl`
(usado pelo `lint-test-email.ts` no `review-test-email`). Idempotente — só
adiciona entry se a edição ainda não tem source `frontmatter_02_reviewed`
(nome de source preservado por compat — a fonte real hoje é `_internal/intentional-error.json`, #3222).
O `close-poll.ts` (§1.4) também faz esse sync por dentro (#3210).

```bash
npx tsx scripts/sync-intentional-error.ts \
  --md {edition_dir}/02-reviewed.md \
  --edition {AAMMDD} \
  --jsonl data/intentional-errors.jsonl
```

Stdout: `{ "added": true|false, "edition": "{AAMMDD}" }`. Falha (`exit != 0`)
não bloqueia — o lint do passo 0 já garantiu `_internal/intentional-error.json`;
falha aqui é issue de I/O. Logar warning e prosseguir.

### 1. Pré-render

Gera HTML completo + sobe imagens pro Cloudflare Worker KV.

> **#1119 (2026-05-11)**: Imagens pra newsletter daily vão pro Cloudflare Worker KV (`/img/{key}`), não pro Drive. Razão: Drive `uc?id=...` retorna HTML wrapper na 1ª request + throttle agressivo + sem Cache-Control. Cloudflare entrega JPEG direto, com `Cache-Control: public, max-age=31536000, immutable`. Desde #2147 o modo `social` (LinkedIn/Facebook) também vai pro KV, e o ramo Drive foi removido do script no #11414.

#### 1.1 Extrair metadata

```bash
# Título, subtítulo, destaques (JSON — usado pro header do post)
npx tsx scripts/extract-destaques.ts {edition_dir}/02-reviewed.md
```

Gravar output: `title`, `subtitle`.

#### 1.2 Upload imagens pro Cloudflare Worker KV (mode newsletter)

```bash
npx tsx scripts/upload-images-public.ts --edition-dir {edition_dir} --mode newsletter
```

Faz upload de 5 imagens pro Worker KV (default `--target cloudflare` quando `--mode newsletter`):
- `04-d1-2x1.jpg` (cover, também usada inline no D1)
- `04-d2-2x1.jpg` (inline D2); `04-d3-2x1.jpg` (inline D3, somente em edições 3-destaque — #2352). O 1:1 deixou de ser gerado no #12226.
- `01-eia-A.jpg`, `01-eia-B.jpg` (É IA? — random A/B; mapping em `01-eia.md` frontmatter; edições antigas usam `01-eia-real.jpg`/`01-eia-ia.jpg`, detectadas em runtime)

KV keys: `img-{AAMMDD}-{filename}` (ex: `img-260512-04-d1-2x1.jpg`). URLs servidas por `https://eia.diar.ia.br/img/{key}` (#3904 — domínio de marca; `poll.diaria.workers.dev` segue ativo só por compat de links já enviados) com `Content-Type: image/jpeg` + `Cache-Control: public, max-age=31536000, immutable`.

Output: `{edition_dir}/06-public-images.json` com mapping `{ cover, d2, d3, eia_a, eia_b: { url, file_id, filename, target: "cloudflare" } }` (edições antigas: `eia_real`/`eia_ia` no lugar de `eia_a`/`eia_b`).

Resume-aware: re-execução pula imagens já no cache, **respeitando target**. Entry legada `target=drive` (ou sem `target`) de edição antiga é re-uploadada pro KV.

**Sem escape hatch pro Drive**: `--target drive` foi removido no #11414 (o script sai com erro); o único destino é `cloudflare`.

**Credenciais Cloudflare**: `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_WORKERS_TOKEN` no `.env`. Namespace ID lido de `platform.config.json → poll.kv_namespace_id`.

#### 1.3 Render HTML + substituir URLs

**Modo single-file:** a newsletter inteira sai num único HTML. Merge tags `{{poll_a_url}}/{{poll_b_url}}` são preservadas (raw HTML — o render não normaliza hrefs). O mesmo arquivo serve o preview do gate e o paste manual via `prep-manual-publish.ts`:

```bash
npx tsx scripts/render-newsletter-html.ts {edition_dir} --format html --out {edition_dir}/_internal/newsletter-draft.html
npx tsx scripts/substitute-image-urls.ts \
  --html {edition_dir}/_internal/newsletter-draft.html \
  --images {edition_dir}/06-public-images.json \
  --out {edition_dir}/_internal/newsletter-final.html \
  --reviewed-md {edition_dir}/02-reviewed.md
```

**Exit codes de `substitute-image-urls.ts` (#2316):**

| Exit | Significado | Ação |
|------|-------------|------|
| `0` | Sucesso — todas as placeholders substituídas | Continuar |
| `1` | Erro de args (uso incorreto da CLI) | Verificar comando; abortar |
| `2` | Placeholders não resolvidas — `unresolved[]` não vazio | Abortar — verificar `06-public-images.json` e fluxo de upload |
| `3` | **HTML stale** — `newsletter-draft.html` mais antigo que `02-reviewed.md` | **Não é fatal.** Re-rodar `render-newsletter-html.ts` (passo acima) e então re-rodar `substitute-image-urls.ts` |
| `4` | Merge tag de ESP específico (Kit/Brevo) no caminho neutro `newsletter-final.html` (#13568) — nada é gravado, o arquivo anterior fica intacto | Abortar — o HTML neutro vira a página do site e só aceita `{{email}}`; conferir de onde veio a merge tag antes de re-rodar |

> **Exit 3 (#2316, #2335):** o `render-newsletter-html.ts` não rodou (ou falhou silenciosamente) após a última edição de `02-reviewed.md`. O stderr já inclui o comando exato de re-render. Mensagem: `[substitute-image-urls] ERRO: HTML de input está desatualizado — mtime(...)`. Ação: re-renderizar e re-substituir. **Nunca tratar exit 3 como erro fatal irrecuperável** — é uma instrução de re-render, não uma falha de pipeline.

Se substituição reportar `unresolved: []` não vazio (exit 2), abortar — uma imagem não tem placeholder correspondente (verificar 06-public-images.json e fluxo de upload).

**Modo `--split` (legacy, NÃO usar)**: o renderer ainda suporta `--split`, que gera `newsletter-body.html` + `newsletter-eia.html` separados. Servia ao paste no Beehiiv e fica só pra eventual debug.

#### 1.4 Setar gabarito É IA? no Worker (#1526)

Garantir que o poll Worker já sabe a resposta correta **antes** do e-mail de teste — o editor testa o É IA? assim que recebe o teste. Sem isso, `correct:{edition}` fica vazio e o Worker não mostra resultado, ou pior, um valor stale de uma run anterior causa inversão.

`close-poll.ts` é idempotente — re-rodar após publicação só atualiza scores de votos novos.

```bash
npx tsx scripts/close-poll.ts --edition {AAMMDD}
```

Falha (exit != 0) = **warning, não bloqueia**. Poll sem gabarito ainda aceita votos; scores são reconciliados quando `close-poll` rodar pós-publicação. Mas logar warn explícito pro editor saber que o teste do É IA? não vai mostrar resultado.
