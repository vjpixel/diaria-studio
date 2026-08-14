# reativar Worker (#4476 item 3)

Link de confirmação PERSONALIZADO pro segmento Pending do canal Brevo próprio
do editor (`data/snippets/brevo-diaria-pending-intro.md`) — 1 clique em
vez do formulário genérico de cadastro da Beehiiv (2 etapas).

URL: `https://reativar.diaria.workers.dev/?email={{ contact.EMAIL }}`

## Por que existe

Merge tag da Brevo (`{{ contact.EMAIL }}`) já entrega o e-mail — não faz
sentido pedir pra pessoa digitar de novo. `GET /?email=X` busca a
subscription existente (`GET .../subscriptions/by_email`), deleta o
registro Pending travado se houver, e cria uma subscription nova do zero
(`POST .../subscriptions`, SEM `reactivate_existing` — ver "Verificação ao
vivo" abaixo, por que esse mecanismo foi abandonado) — mesmo padrão de
`promoteBeehiivSubscription` (`scripts/evaluate-brevo-diaria.ts`), mas
acionado por clique explícito, não por inferência de score.

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

# 1b. Secret opcional (#4538 item B) — guard de descadastro nativo pendente.
# Sem ela, o guard é pulado (fail-open, mesmo comportamento pré-#4538).
npx wrangler secret put BREVO_DIARIA_API_KEY
# → mesmo valor do env var apontado por platform.config.json →
#   brevo_diaria.api_key_env (BREVO_DIARIA_API_KEY)

# 2. Deploy
npx wrangler deploy
# → confirma URL no output: https://reativar.diaria.workers.dev
```

Sem KV namespace — o Worker não guarda estado (cada request é uma chamada
stateless à API da Beehiiv/Brevo).

## Guard de descadastro nativo pendente (#4538 item B)

Antes do DELETE+CREATE, o Worker consulta `GET /v3/contacts/{email}` na
Brevo — se a pessoa já se descadastrou nativamente do canal Brevo próprio
(`emailBlacklisted: true`, o mesmo sinal que
`scripts/evaluate-brevo-diaria.ts` passo 0 detecta e propaga pra Beehiiv,
issue #4538), o clique NÃO reativa automaticamente: renderiza uma página
explicando a situação e apontando pro cadastro normal (opt-in explícito) em
`diar.ia.br`. Fecha o cenário "clique tardio numa edição antiga reativa
quem já disse não, em silêncio".

Fail-open sem `BREVO_DIARIA_API_KEY` configurada, ou em qualquer erro de
rede/HTTP da Brevo — nunca trava o fluxo de confirmação inteiro por causa
de uma checagem que cobre um edge case raro (população cap 300).

## Tests

```bash
node --import tsx --test test/reativar-worker-4476.test.ts
```

Cobre parse/validação do `?email=`, a chamada de ativação (fetch mockado —
nunca rede real), e as páginas HTML de sucesso/erro.

## Verificação ao vivo (#4476/#4488) — CONFIRMADA em 260802

Dois testes ao vivo contra a API real da Beehiiv — request/response exatos
documentados nos PRs #4480 e #4488 (não neste README, pra não desatualizar
aqui a cada reteste):

1. **2 e-mails sintéticos** (`@example.com`/`@mailinator.com`) — ambos
   caíram em `status:"invalid"` (domínio disposable) antes de chegar em
   `pending`, então não exercitaram a transição real. Inconclusivo.
2. **1 contato Pending REAL** (voluntário, revertido/descadastrado logo
   depois) — fechou a lacuna: `reactivate_existing:true` **não ativou**
   (status ficou `pending`, sem mudança). Deletar o registro e criar do
   zero **ativou direto** (`validating` → `active` em segundos). É essa a
   mecânica que o Worker usa hoje — `reactivate_existing` foi removido, não
   é mais usado em lugar nenhum.
