---
name: diaria-remover-votos-pixel
description: Remove os votos do editor (pixel@memelab.com.br + vjpixel@gmail.com) do leaderboard do "É IA?". Os votos de teste/curadoria do próprio editor não devem competir no ranking público. Usa `scripts/purge-leaderboard.ts` (imprime o plano via dry-run e executa direto — a invocação explícita é a confirmação, #1890). Uso — `/diaria-remover-votos-pixel`.
---

# /diaria-remover-votos-pixel

Remove do leaderboard do "É IA?" os votos das contas do **editor**, que vota durante a curadoria/teste e não deve aparecer competindo no ranking público:

- `pixel@memelab.com.br`
- `vjpixel@gmail.com`

Reusa `scripts/purge-leaderboard.ts` (#1802), que apaga tudo relacionado a um email no KV do Worker `poll`: `score:{email}`, `score-by-month:*:{email}`, `vote:{edition}:{email}`, decrementa os `stats:{edition}` afetados e invalida os `leaderboard-snapshot:{slug}`.

## Pré-requisito (auth)

O script usa o **wrangler** (auth global do CLI) pra acessar o KV — **não** precisa mais de `CLOUDFLARE_API_TOKEN`/`ACCOUNT_ID` no env (#2265: o token avulso dava 401 sem permissão de KV). Basta o `wrangler` estar logado:

```
npx wrangler whoami   # deve listar a conta, sem erro
```

> ⚠️ Se houver um `CLOUDFLARE_API_TOKEN` no `.env`/shell, o script o **ignora** de propósito (removido do env do wrangler filho) pra forçar a auth OAuth.

Votos da Clarice News (mensal) exigem `--brand clarice` (votos diaria são o default).

## Execução

> **Sem gate de confirmação (#1890).** A invocação explícita desta skill pelo editor JÁ é a confirmação — não pare pra perguntar "confirma apagar?". A skill imprime o plano (dry-run) por transparência e **em seguida executa direto**.

**1) Dry-run dos 2 emails (imprime o plano — o que será apagado):**

```bash
npx tsx scripts/purge-leaderboard.ts --email pixel@memelab.com.br
npx tsx scripts/purge-leaderboard.ts --email vjpixel@gmail.com
```

Mostre ao editor o resumo de cada um (quantos `vote:`, `score:`, meses afetados) — para **auditoria**, não pra aguardar "sim".

**2) Execução real (direto, sem aguardar resposta):**

```bash
npx tsx scripts/purge-leaderboard.ts --email pixel@memelab.com.br --execute
npx tsx scripts/purge-leaderboard.ts --email vjpixel@gmail.com --execute
```

Por que é seguro pular o gate **nesta** skill: a ação é determinística e **hardcoded** (só os 2 emails do editor → blast radius baixo), **idempotente** (re-rodar é no-op), e o dry-run acima já deixou o plano visível. Exceção: se a chamada vier de contexto NÃO-interativo (outra automação, não o editor digitando `/`), aí confirme antes — mas o uso normal desta skill é manual.

Ao final, confirme ao editor que as 2 contas saíram do leaderboard. Se quiser conferir, o `/leaderboard` do Worker (`poll.diaria.workers.dev/leaderboard`) reflete a remoção (snapshots foram invalidados).

## Notas

- **Não-bloqueante / idempotente:** rodar de novo num email já limpo é no-op (não acha keys).
- **Só as 2 contas do editor** — esta skill é deliberadamente hardcoded pra esses emails. Pra remover outra conta (ex: um "Teste" rogue), use `purge-leaderboard.ts --nickname` ou `--email` direto, fora desta skill.
