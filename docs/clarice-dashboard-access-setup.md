# Clarice Dashboard — Cloudflare Access + Tab de Cupons

Este documento cobre:
1. Configurar Cloudflare Access (OTP por e-mail) para proteger o dashboard antes de habilitar a tab de cupons.
2. A **ordem obrigatória de deploy** para garantir que PII (emails de clientes Stripe) nunca seja exposto sem autenticação.

---

## Cloudflare Access — OTP por e-mail

### Pré-requisitos

- Conta Cloudflare com o Worker `clarice-dashboard` implantado.
- Acesso ao painel [dash.cloudflare.com](https://dash.cloudflare.com) → **Zero Trust**.

### Passo a passo

1. Abra **Zero Trust → Access → Applications → Add an application**.
2. Tipo: **Self-hosted**.
3. **Application name**: `Clarice Dashboard`
4. **Application domain**: `clarice-dashboard.diaria.workers.dev` (ajuste para o domínio real se usar custom domain).
5. Em **Identity providers**, selecione **One-time PIN** (OTP por e-mail — nenhum IdP externo necessário).
6. Em **Policies**, crie uma policy:
   - **Policy name**: `editor-access`
   - **Action**: Allow
   - **Include → Emails**: `vjpixel@gmail.com`, `felipe@clarice.ai`
7. Salve. O Cloudflare agora exige OTP por e-mail antes de servir qualquer rota do dashboard.
8. **Confirme**: abra `https://clarice-dashboard.diaria.workers.dev/` num browser sem sessão ativa — deve aparecer a tela de OTP do Cloudflare Access.

---

## Ordem obrigatória de deploy para a tab de cupons

> **CRÍTICO**: a tab de cupons exibe e-mails de clientes (PII). Habilitar antes de
> restringir o acesso expõe dados pessoais publicamente. Siga EXATAMENTE esta ordem.

### Passo 1 — Ativar Cloudflare Access (primeiro)

Execute os passos acima e **confirme** que o dashboard exige login antes de continuar.

Não prossiga para o passo 2 sem verificar isso.

### Passo 2 — Configurar o secret STRIPE_API_KEY

A chave Stripe deve ser **restrita** (read-only): permissões necessárias:
- Coupons → Read
- Customers → Read
- Invoices → Read
- Subscriptions → Read
- Charges → Read

Crie a chave em [dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys) → **Create restricted key**.

Configure como secret do Worker (nunca commitada):

```bash
wrangler secret put STRIPE_API_KEY
# cole a chave quando solicitado
```

### Passo 3 — Deploy

```bash
cd workers/brevo-dashboard
npx wrangler deploy
```

Neste ponto, a tab de cupons ainda está **OFF** (`COUPONS_TAB_ENABLED = "false"` no `wrangler.toml`). O deploy é seguro.

### Passo 4 — Habilitar a tab de cupons

Somente após confirmar que o Access está ativo (passo 1), a chave Stripe está configurada (passo 2) e o deploy foi feito (passo 3):

**Opção A** — via `wrangler.toml` + novo deploy:
```toml
[vars]
COUPONS_TAB_ENABLED = "true"
```
```bash
npx wrangler deploy
```

**Opção B** — via Cloudflare Dashboard (sem novo deploy):
Workers & Pages → `clarice-dashboard` → Settings → Variables → adicionar `COUPONS_TAB_ENABLED = true`.

Após o passo 4, a tab "Cupons" aparece no dashboard e o endpoint `/api/coupons` retorna dados.

---

## Por que essa ordem importa

A tab de cupons exibe e-mails de clientes (PII). O Worker implementa um guard duplo:
- `COUPONS_TAB_ENABLED !== "true"` → tab invisível, `/api/coupons` retorna 404.
- `STRIPE_API_KEY` ausente → idem.

Mas esse guard só funciona **em conjunto** com o Cloudflare Access. Se a tab for habilitada antes do Access estar ativo, qualquer visitante anônimo veria os e-mails. Por isso o Access deve ser o **primeiro passo**, não o último.

---

## Desabilitando a tab de cupons (rollback)

Se precisar desabilitar a tab após tê-la ativado:

1. Defina `COUPONS_TAB_ENABLED = "false"` (via `wrangler.toml` + deploy, ou via dashboard).
2. **Purgue o cache KV** — o Worker persiste o último HTML renderizado em `LASTGOOD_KEY` (`dash:lastgood:html`) com TTL de 1h para degradação graciosa em caso de rate-limit da Brevo. Esse snapshot pode conter a tab de cupons com e-mails. Sem a purga, um request com rate-limit nos próximos 60 minutos serviria o HTML antigo.

```bash
# Listar namespaces para encontrar o ID correto:
npx wrangler kv namespace list

# Deletar as chaves de last-good e coupon cache:
npx wrangler kv key delete --namespace-id <STATS_CACHE_NAMESPACE_ID> "dash:lastgood:html"
npx wrangler kv key delete --namespace-id <STATS_CACHE_NAMESPACE_ID> "dash:lastgood:hash"
npx wrangler kv key delete --namespace-id <STATS_CACHE_NAMESPACE_ID> "coupons:usage"
```

Após a purga, novos renders não incluirão a tab de cupons. O LASTGOOD_KEY será sobrescrito com HTML sem a tab no primeiro request bem-sucedido.
