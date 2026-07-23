# workers/artigo-mensal

Hosting do artigo mensal público da Diar.ia em `https://artigo.diar.ia.br/{ciclo}`,
com paywall dinâmico restrito a apoiadores de R$10/mês ou mais (#3940).

Diferente de `workers/artigos` (#3961, static-only): este worker **tem
script** — o gate de apoiador é decidido em request-time contra um KV
(allowlist), não em build-time.

## Arquitetura

```
Node-side (local, fora deste worker):
  data/monthly/{cycle}/draft.md
    → scripts/build-article-page.ts --cycle {cycle} --push
      (reusa draftToEmail de scripts/lib/mensal/monthly-render.ts)
    → KV ARTICLES["article:{cycle}"] = HTML completo

  data/apoia-se/contacts.jsonl + checkBacker (Apoia.se)
    → scripts/build-apoiador-allowlist.ts --push
    → KV ALLOWLIST["emails"] = ["fulano@x.com", ...]  (JSON array)

Worker (este diretório):
  GET /{cycle}              → sem ?email=: form de e-mail (src/render.ts)
  GET /{cycle}?email=X      → X ∈ allowlist:     serve KV ARTICLES["article:{cycle}"]
                               X ∉ allowlist:     paywall (CTA apoia.se/diaria)
  GET /                     → 400 (ciclo obrigatório)
```

Lógica do gate é 100% pura e testada em `src/gate.ts` (ver
`test/worker-artigo-mensal-gate-3940.test.ts`) — fail-closed: qualquer
ambiguidade (KV indisponível, JSON corrompido, e-mail ausente) nunca serve o
artigo.

## Deploy (PRÓXIMOS PASSOS MANUAIS — fora do escopo do PR #3940)

Esta unidade implementou só código + testes. Nada abaixo foi executado:

1. Criar os 2 namespaces KV e colar os IDs retornados em `wrangler.toml`:
   ```
   cd workers/artigo-mensal
   npx wrangler kv namespace create ARTICLES --remote
   npx wrangler kv namespace create ALLOWLIST --remote
   ```
2. Deploy:
   ```
   npx wrangler deploy
   ```
3. Popular o artigo do ciclo (ex: julho, ciclo `2607-08` — confirmar o ciclo
   exato com `.claude/skills/diaria-mensal/SKILL.md`):
   ```
   npx tsx scripts/build-article-page.ts --cycle 2607-08 --push
   ```
4. Popular a allowlist de apoiadores (requer sessão local — `data/` junction +
   credenciais Apoia.se):
   ```
   npx tsx scripts/build-apoiador-allowlist.ts --push
   ```
   Sem `--push`, ambos os scripts rodam em modo dry-run (imprimem o
   resultado, não gravam no KV) — usar pra conferir antes do push real.
5. Configurar a rota `artigo.diar.ia.br` no Cloudflare (Custom Domain), como
   já feito para `cursos`/`livros`/`eia`/`artigos`.

## Notas

- Sem Durable Objects (diferente de `poll`) — a allowlist e o artigo são
  lidos, nunca incrementados/serializados; KV eventual-consistent é
  suficiente aqui.
- Cores/tipografia do gate (`src/render.ts`) espelham
  `scripts/lib/shared/design-tokens.ts` inline — mesma convenção de
  `workers/artigos` (sem import cruzado pro lado Node do repo).
- Retroatividade para artigos mensais anteriores a julho está
  explicitamente fora de escopo (#3940).
