# Runbook: POLL_SECRET rotation

**Issue tracker**: [#1082](https://github.com/vjpixel/diaria-studio/issues/1082)

## Quando rodar

- **Cadência sugerida:** semestral (junho + dezembro).
- **Trigger emergencial:** se houver indício de vazamento (sig HMAC em screenshot público, log compartilhado, etc).
- **Janela ideal:** fim de mês quando a edição é leve. Evitar primeiro dia útil — leitores podem clicar links antigos da edição anterior nas primeiras horas pós-rotação.

## Por que rotar

`POLL_SECRET` assina `HMAC(secret, email)` que vira o `poll_sig` permanente do subscriber (#1083). Se vazar, atacante consegue votar como o subscriber em **qualquer edição futura** até o secret ser trocado.

Mitigação imediata: server enforça 1 vote per `(email, edition)` via `vote:{edition}:{email}` em KV, então blast radius máximo é 1 voto por edição por subscriber comprometido. Aceitável pra concurso editorial sem prêmio sério, mas o risco cresce com o tempo.

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
