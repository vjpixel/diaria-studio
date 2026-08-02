# reativar Worker (#4476 item 3)

Link de confirmação PERSONALIZADO pro segmento Pending do canal Brevo próprio
do editor (`context/snippets/brevo-diaria-pending-intro.md`) — 1 clique em
vez do formulário genérico de cadastro da Beehiiv (2 etapas).

URL: `https://reativar.diaria.workers.dev/?email={{ contact.EMAIL }}`

## Por que existe

Merge tag da Brevo (`{{ contact.EMAIL }}`) já entrega o e-mail — não faz
sentido pedir pra pessoa digitar de novo. `GET /?email=X` chama
`POST /publications/{id}/subscriptions` da Beehiiv com
`reactivate_existing: true`, mesmo padrão de `promoteBeehiivSubscription`
(`scripts/evaluate-brevo-diaria.ts`), mas acionado por clique explícito, não
por inferência de score.

Sem assinatura HMAC (mesmo padrão do link de voto "É IA?" desde a decisão
#1186) — ver rationale de risco aceito no header de `src/index.ts`.

## Rotas

- `GET /?email=X` → confirma a assinatura na Beehiiv, retorna página HTML de
  sucesso/erro.
- `OPTIONS /` → preflight CORS.

## Deploy (one-time setup)

```bash
cd workers/reativar

# 1. Secrets (opcionais — sem eles, 503 amigável "not_configured")
npx wrangler secret put BEEHIIV_API_KEY
# → mesmo valor de BEEHIIV_API_KEY já usado pelos scripts do repo
npx wrangler secret put BEEHIIV_PUBLICATION_ID
# → mesmo valor de platform.config.json → beehiiv.publicationId

# 2. Deploy
npx wrangler deploy
# → confirma URL no output: https://reativar.diaria.workers.dev
```

Sem KV namespace — o Worker não guarda estado (cada request é uma chamada
stateless à API da Beehiiv).

## Tests

```bash
node --import tsx --test test/reativar-worker-4476.test.ts
```

Cobre parse/validação do `?email=`, a chamada de ativação (fetch mockado —
nunca rede real), e as páginas HTML de sucesso/erro.

## Verificação ao vivo (#4476 item 3)

Testado contra a API real da Beehiiv com 1 e-mail sintético de teste antes
do 1º uso em produção — request/response exatos documentados no PR do
#4476 (não neste README, pra não desatualizar aqui a cada reteste).
