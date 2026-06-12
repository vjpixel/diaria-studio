# Runbook: POLL_SECRET rotation

**Issue tracker**: [#1082](https://github.com/vjpixel/diaria-studio/issues/1082)

> **#1186 (2026-06-12):** O diário migrou para **modo merge-tag** — a URL de voto usa `{{email}}` sem `&sig=`. `inject-poll-sig.ts` foi removido.
>
> **Este runbook ainda é necessário para o ADMIN_SECRET** (usado por `close-poll.ts` via `/admin/correct`). A seção de `inject-poll-sig` (Steps 4 e pós-rotação) ficou histórica. `POLL_SECRET` ainda existe no Worker (o caminho assinado está dormiente), então a rotação periódica é prudente para o Worker, mas `inject-poll-sig.ts` não precisa mais ser rodado.

## Quando rodar

- **ADMIN_SECRET:** sempre que houver suspeita de vazamento.
- **POLL_SECRET (Worker):** semestral (prudência, path dormiente). Não precisa re-rodar `inject-poll-sig.ts` após a rotação — o diário usa merge-tag.
- **Janela ideal:** fim de mês quando a edição é leve. Evitar primeiro dia útil.

## Por que rotar

`POLL_SECRET` assina `HMAC(secret, email)` no Worker (path dormiente no diário desde #1186). Se vazar, o impacto é limitado (1 voto por edição por subscriber, sem prêmio real).

`ADMIN_SECRET` autentica `close-poll.ts` (`/admin/correct`) — mais crítico para a integridade do gabarito.

## Pré-requisitos

- Editor (Pixel) logado no terminal local com `wrangler` configurado
- `.env` local com:
  - `BEEHIIV_API_KEY`
  - `BEEHIIV_PUBLICATION_ID`
  - `CLOUDFLARE_ACCOUNT_ID=5d15d8303325211d6976d73051f4b002`
- Acesso ao bash + curl

## Procedimento

### 1. Gerar novo secret

```bash
NEW_SECRET=$(openssl rand -hex 32)
echo "$NEW_SECRET" | head -c 8
# (mostra primeiros 8 chars pra confirmar geração, NÃO loga full)
```

Persistir local pra Step 4:
```bash
export POLL_SECRET_NEW="$NEW_SECRET"
```

### 2. Update Worker secret

```bash
cd workers/poll
echo "$POLL_SECRET_NEW" | npx wrangler secret put POLL_SECRET --remote
```

Confirmação: `wrangler` mostra `Success! Uploaded secret POLL_SECRET`.

### 3. Re-deploy Worker

```bash
CLOUDFLARE_ACCOUNT_ID=5d15d8303325211d6976d73051f4b002 npx wrangler deploy
```

A partir deste momento URLs assinadas com o secret antigo vão falhar com 403 "Link inválido ou expirado". Subscribers com `poll_sig` populado no Beehiiv (gerado pelo secret antigo) precisam ser re-patchados no Step 4.

### 4. Re-rodar inject-poll-sig

Na raiz do repo:
```bash
cd ../../  # voltar pra raiz se estiver em workers/poll
BEEHIIV_API_KEY=... \
BEEHIIV_PUBLICATION_ID=... \
POLL_SECRET="$POLL_SECRET_NEW" \
  npx tsx scripts/inject-poll-sig.ts --force
```

`--force` faz patch em todos os subscribers (não só novos das últimas 96h). Importante: o script faz uma chamada Beehiiv API por subscriber. Em produção com ~500 subscribers, leva ~1-2min.

Output esperado:
```
[inject-poll-sig] patched 487/487 subscribers
```

### 5. Update `.env` local

```bash
# Editar .env e substituir POLL_SECRET pelo novo valor
nano .env  # ou seu editor preferido
```

Necessário pra runs futuras de `inject-poll-sig.ts` (Stage 0 §0d.ter) usarem o secret novo.

### 6. Smoke test

```bash
# URL antiga (gerada com secret antigo) — deve falhar
OLD_URL="..."  # qualquer URL de email pré-rotação, copiar de email recente
curl -sI "$OLD_URL" | head -3
# Esperado: HTTP/2 403 ou HTML "Link inválido ou expirado"

# URL nova — gerar manualmente e verificar OK
EMAIL="seu@email.com"
NEW_SIG=$(node -e "
  const crypto = require('crypto');
  const sig = crypto.createHmac('sha256', '$POLL_SECRET_NEW').update('$EMAIL').digest('hex');
  console.log(sig);
")
curl -sI "https://poll.diaria.workers.dev/vote?email=$EMAIL&edition=260518&choice=A&sig=$NEW_SIG&test=1" | head -3
# Esperado: HTTP/2 200 (test mode = sem KV write, válido só pra confirmar sig OK)
```

### 7. Logar rotação

Append entry em `data/secret-rotations.jsonl` (gitignored — não commitado):
```bash
mkdir -p data
echo "{\"secret\":\"POLL_SECRET\",\"rotated_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"prev_hash_prefix\":\"$(echo -n $POLL_SECRET_OLD | sha256sum | head -c 8)\",\"by\":\"Pixel\"}" >> data/secret-rotations.jsonl
```

(Hash do secret antigo só pra correlação em caso de investigação futura — nunca o secret cru.)

### 8. Limpar variáveis locais

```bash
unset POLL_SECRET_NEW POLL_SECRET_OLD
```

## Pós-rotação

- Editores que tinham `inject-poll-sig.ts` rodando manualmente precisam pegar o secret novo do `.env`.
- Stage 0 §0d.ter da pipeline (`/diaria-edicao`) usa env local — `.env` atualizado no Step 5 cobre isso automaticamente.
- Subscribers que clicaram URL antiga nas primeiras horas pós-rotação verão 403 — comportamento esperado. Se quiser ser educado, abrir nota na edição da semana avisando "links de edições passadas foram desativados por manutenção de segurança".

## Rollback

**Se algo der errado entre Step 3 (deploy) e Step 4 (inject):** voto novo falha pra todos, mas vote dedup ainda funciona. Não há corrupção de dados.

**Rollback completo:** repetir Steps 2-4 com o secret antigo (precisa ter guardado em algum lugar — manter o velho em backup encriptado, NUNCA em git, durante ~24h após rotação pra emergência).

## Próxima rotação

Calendarize 6 meses à frente. Se Pixel quiser, adicionar lembrete via `cron` local ou um GitHub Action que abra uma issue auto-gerada `chore: POLL_SECRET rotation due` a cada 6 meses.

## Related

- #1083 (closed) — implementação do `poll_sig` permanente que motivou a necessidade de rotação
- #1077 (open) — reset mensal do leaderboard (independente desta rotação, mas evita corruption se feita junto)
