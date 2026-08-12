# diaria-dashboard — access setup (#5133)

Até 12/08/2026 o Worker `diaria-dashboard` era servido **sem nenhuma
autenticação** — `X-Robots-Tag: noindex` + `Disallow: /` (#5097) impedem
INDEXAÇÃO por buscador, não impedem ACESSO: quem tivesse a URL lia o HTML
completo (histórico de rodadas, e-mails do editor no HTML — corrigido à
parte, #5133 item 2) e o JSON agregado inteiro em `/api/data`.

Este documento cobre o gate de token compartilhado adicionado em resposta —
mesmo padrão espiritual já em produção em `workers/brevo-dashboard`
(#2748/#3081), com uma via extra pensada pra automação: header
`X-Dashboard-Token` OU cookie de sessão. Nenhuma zona Cloudflare Access é
necessária.

---

## Como o editor acessa o dashboard depois desta mudança

**Resumo rápido:** abra a URL do Worker no browser, cole o token na tela de
login que aparece, pronto — a sessão fica válida por 30 dias (cookie).

1. **Gerar um token forte** (uma vez, se ainda não existir):
   ```bash
   openssl rand -hex 32
   ```
   Guarde a saída (ex: em 1Password) — este é o `AUTH_TOKEN`.

2. **Configurar o secret no Worker:**
   ```bash
   cd workers/diaria-dashboard
   wrangler secret put AUTH_TOKEN
   # cole o token quando solicitado
   ```

3. **Deploy:**
   ```bash
   wrangler deploy
   ```

4. **Acessar:** abra `https://diaria-dashboard.diaria.workers.dev/` (ou o
   host de produção configurado). Sem cookie/header válido, TODA rota
   protegida devolve a mesma tela de login (status 401) — cole o token no
   campo "Token de acesso" e envie. O Worker seta um cookie de sessão
   (`diaria-dash-auth`, `HttpOnly; Secure; SameSite=Strict`, 30 dias) e
   redireciona de volta pra `/`. Nenhum token aparece na URL/histórico do
   browser — o form usa `POST` (body), não querystring.

5. **Sessão expira em 30 dias** — repita o passo 4 quando isso acontecer
   (a tela de login reaparece sozinha).

### Acesso programático (scripts/automação, sem browser)

Envie o token no header `X-Dashboard-Token` em vez de depender do cookie:

```bash
curl -H "X-Dashboard-Token: $AUTH_TOKEN" https://diaria-dashboard.diaria.workers.dev/api/data
```

Nenhum consumidor de automação interna do repo depende hoje de acesso sem
token a este Worker (diferente de `workers/brevo-dashboard`, cujo
`/api/campaigns` é deliberadamente público pra automação — ver comentário
em `workers/brevo-dashboard/src/index.ts`); o header acima é o caminho
oficial se isso mudar no futuro.

---

## Rotas fora do gate (públicas, por design)

| Rota | Motivo |
|---|---|
| `GET /healthz` | liveness probe, sem dado sensível |
| `GET /robots.txt` | diretiva pública padrão de crawler |
| `GET /login`, `POST /login` | ponto de entrada de login — não pode exigir o que ele mesmo concede |

Toda rota fora dessa lista (`/`, `/index.html`, `/api/data`, `/studio`,
`/studio/`, `/api/studio-snapshot`, e qualquer path desconhecido) exige
autenticação. Um path que não existe e um path protegido devolvem a MESMA
resposta (401 + tela de login) quando não autenticado — a ausência de token
nunca revela se o recurso pedido é real.

---

## Fail-CLOSED, não fail-open

Se `AUTH_TOKEN` nunca foi configurado (`wrangler secret put` nunca rodou),
o Worker nega acesso a **todo mundo**, sempre — não existe modo "dev sem
secret = aberto". Um secret esquecido no deploy não pode virar leak
silencioso. Isso é deliberadamente mais restritivo que o comportamento
documentado (mas incorreto — a implementação já mudou desde #2748 e não
seguiu fail-open) em `docs/clarice-dashboard-access-setup.md` para o
`brevo-dashboard`; se notar essa mesma inconsistência lá, é doc desatualizada,
não comportamento real — vale corrigir à parte.

---

## Revogar acesso

Gerar um novo token e sobrescrever o secret:

```bash
openssl rand -hex 32
cd workers/diaria-dashboard
wrangler secret put AUTH_TOKEN   # cole o novo token
wrangler deploy
```

O cookie antigo (e qualquer header antigo em uso por automação) fica
inválido instantaneamente — todas as sessões são deslogadas automaticamente.

---

## Verificar

Numa janela anônima, abra a URL do Worker — a tela de login deve aparecer
(401). Cole o token → deve redirecionar pro dashboard (200). `curl -I` sem
header/cookie contra `/` ou `/api/data` deve devolver `401`; com
`-H "X-Dashboard-Token: $AUTH_TOKEN"`, `200`/`404` conforme o KV estiver
populado.
