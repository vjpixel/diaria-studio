---
name: diaria-remover-votos-pixel
description: Remove os votos do editor (pixel@memelab.com.br + vjpixel@gmail.com) do leaderboard do "É IA?". Os votos de teste/curadoria do próprio editor não devem competir no ranking público. Usa `scripts/purge-leaderboard.ts` (dry-run primeiro, `--execute` só após confirmação). Uso — `/diaria-remover-votos-pixel`.
---

# /diaria-remover-votos-pixel

Remove do leaderboard do "É IA?" os votos das contas do **editor**, que vota durante a curadoria/teste e não deve aparecer competindo no ranking público:

- `pixel@memelab.com.br`
- `vjpixel@gmail.com`

Reusa `scripts/purge-leaderboard.ts` (#1802), que apaga tudo relacionado a um email no KV do Worker `poll`: `score:{email}`, `score-by-month:*:{email}`, `vote:{edition}:{email}`, decrementa os `stats:{edition}` afetados e invalida os `leaderboard-snapshot:{slug}`.

## Pré-requisito (env)

O script precisa do token Cloudflare no ambiente:

```
CLOUDFLARE_API_TOKEN=...        # mesmo token do wrangler
CLOUDFLARE_ACCOUNT_ID=5d15d8303325211d6976d73051f4b002
```

Se ausentes, o script aborta com erro — exporte antes (ou rode na máquina com o `.wrangler` logado).

## Execução

**1) Dry-run dos 2 emails (default — só mostra o que seria apagado, NÃO apaga):**

```bash
npx tsx scripts/purge-leaderboard.ts --email pixel@memelab.com.br
npx tsx scripts/purge-leaderboard.ts --email vjpixel@gmail.com
```

Apresente ao editor o resumo de cada um (quantos `vote:`, `score:`, meses afetados).

**2) GATE:** confirme com o editor antes de apagar. **Em `--no-gates`/auto, NÃO execute o purge destrutivo sem confirmação** — apagar votos é irreversível; o dry-run é seguro, o `--execute` não.

**3) Execução real (só após "sim" explícito):**

```bash
npx tsx scripts/purge-leaderboard.ts --email pixel@memelab.com.br --execute
npx tsx scripts/purge-leaderboard.ts --email vjpixel@gmail.com --execute
```

Ao final, confirme ao editor que as 2 contas saíram do leaderboard. Se quiser conferir, o `/leaderboard` do Worker (`poll.diaria.workers.dev/leaderboard`) reflete a remoção (snapshots foram invalidados).

## Notas

- **Não-bloqueante / idempotente:** rodar de novo num email já limpo é no-op (não acha keys).
- **Só as 2 contas do editor** — esta skill é deliberadamente hardcoded pra esses emails. Pra remover outra conta (ex: um "Teste" rogue), use `purge-leaderboard.ts --nickname` ou `--email` direto, fora desta skill.
