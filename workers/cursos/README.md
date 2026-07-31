# workers/cursos (#1745, gate #4052/#4305)

Hosting da página **Cursos sobre IA** da Diar.ia, servida em
`https://cursos.diar.ia.br/` (domínio de marca, #3698) — também acessível via
`https://cursos.diaria.workers.dev/` (mantido por compat de links já enviados
em edições passadas). Gêmea da `workers/livros` (#1744) no padrão visual, mas
**não** no mecanismo: `livros` é static-assets puro, `cursos` ganhou um
gate parcial com script próprio no #4052.

## O que este worker é hoje

Desde o #4052 este é um Worker com **script** (`main = src/index.ts`), não
static-assets-only — a linha antiga deste README dizia o contrário e ficou
errada a partir dali. `env.ASSETS` continua servindo o HTML estático
(`public/index.html`) como fallback, mas o script intercepta as rotas do gate
ANTES do asset (`run_worker_first`, ver `wrangler.toml`) pra decidir teaser ×
conteúdo completo.

**Gate PARCIAL** (decisão do editor, #4052/#4305): os cursos ABERTOS são
`floor(20% × total)` do catálogo — os marcados `preferOpen: true` no seed
ocupam essas vagas primeiro (`selectOpenCourses`,
`scripts/build-cursos-page.ts`). Ficam completos e indexáveis no HTML público.
Os demais NÃO são renderizados de forma alguma — nem título, nem plataforma,
nem tema/contagem nos filtros — até o leitor verificar assinatura ativa OU se
cadastrar; só a contagem agregada aparece no banner de gate. A CTA é um
convite, nunca uma parede (nunca 403).

Dois caminhos de entrada:

- **A. `?email=`** na URL (merge-tag da newsletter, `{{email}}`/
  `{{ contact.EMAIL }}` já resolvida pelo Beehiiv/Brevo antes de chegar aqui
  como query param) — verifica, seta cookie, serve o conteúdo completo direto,
  sem nunca mostrar a tela de gate.
- **B. Sem `?email=` e sem cookie válido** — serve o teaser normal (estático);
  o leitor clica no banner/CTA → `GET /gate` → `POST /gate/verify` (já
  assinante) ou `POST /gate/subscribe` (cadastro inline, honeypot + rate-limit
  + double opt-in via Beehiiv, mesmo padrão de `workers/poll` #3580).

### Rotas

| Rota | Método | O que faz |
|---|---|---|
| `/`, `/index.html` | GET | teaser (asset estático) OU full (dinâmico, se `?email=` válido ou cookie válido) |
| `/gate` | GET | tela de gate (`gate-page.ts`) |
| `/gate/verify` | POST | `{ email }` → verifica assinante ativo, seta cookie |
| `/gate/subscribe` | POST | cadastro inline (honeypot + opt-in) |
| `/gate/logout` | POST | limpa o cookie de sessão |
| qualquer outra | * | fallback pro asset estático (`env.ASSETS`) |

### Sessão e verificação

- **Cookie de sessão** (`cookie.ts`): HMAC-assinado, ~30 dias
  (`diaria_cursos_session`). Desde o #4323 distingue dois estados —
  `confirmed` (verificação real: KV/`by_email` ativo, ou cadastro cuja própria
  resposta da Beehiiv já veio `status: "active"`) e `pending` (cadastro feito,
  mas a Beehiiv ainda não confirmou o double opt-in nesta resposta). Sessão
  `pending` NÃO libera o conteúdo completo — só é promovida a `confirmed`
  numa visita seguinte em que `checkGateSubscriber` já confirme `active`
  (`handleIndex`) ou via `/gate/verify`.
- **Verificação de assinante** (`gate.ts`): PRIMÁRIO é o KV
  `CURSOS_SUBSCRIBERS` (populado por `scripts/sync-cursos-subscribers-kv.ts`,
  chave `subscriber:{sha256(email)}`); SECUNDÁRIO é `by_email` direto na API
  da Beehiiv, usado só quando o KV não tem a chave e os secrets Beehiiv estão
  configurados (endpoint confirmado ao vivo no #4305).
- **Rate-limit** (`GATE_RATE_LIMIT = 8` por IP por hora): conta só tentativas
  que já passaram da validação de corpo/formato de e-mail (#4322) — um typo
  repetido não deveria consumir o mesmo balde de uma tentativa de força-bruta
  real.

## Fonte de verdade do conteúdo

A página é **gerada** de `seed/courses/cursos-ia.json` (curadoria do editor,
versionada) pelo `scripts/build-cursos-page.ts`, que produz DOIS artefatos
committed a partir do mesmo seed:

- `public/index.html` — o teaser público/estático (servido por `env.ASSETS`).
- `src/courses-full.generated.ts` — o HTML completo (`CURSOS_FULL_HTML`),
  servido pelo script SÓ depois do gate passar; nunca fica acessível como
  asset estático.

`test/cursos-asset-drift.test.ts` e `test/cursos-full-drift.test.ts` garantem
que os dois HTMLs committed batem com um render fresco do seed — CI quebra se
o seed mudar sem regenerar.

## Atualizar conteúdo

1. Editar `seed/courses/cursos-ia.json` (cursos, links, filtros).
2. Regenerar os dois assets numa única invocação:
   ```
   npx tsx scripts/build-cursos-page.ts --out workers/cursos/public/index.html --gen-full workers/cursos/src/courses-full.generated.ts
   ```
3. Commitar seed + os dois HTMLs juntos.
4. Deploy: `cd workers/cursos && npx wrangler deploy`.

## Filtros

Idioma · Nível · Custo · Formato · Duração · Plataforma · Certificado · Tema.
Cada dropdown só aparece se houver ≥2 valores distintos no seed (ex: se todos
os cursos forem gratuitos, o filtro de Custo é omitido). Filtros 100%
client-side (lista pequena, sem backend de busca).

## Setup manual (1x, antes do 1º deploy — ver PR #4052 pro passo-a-passo completo)

1. `wrangler kv namespace create CURSOS_SUBSCRIBERS` → colar o id no
   `wrangler.toml`.
2. `wrangler secret put COOKIE_HMAC_SECRET` (gerar: `openssl rand -hex 32`) —
   assina o cookie de sessão; sem ela o gate inteiro fica indisponível
   (fail-closed, #4305).
3. `wrangler secret put BEEHIIV_API_KEY` (opcional — habilita verificação
   secundária + cadastro inline).
4. `wrangler secret put BEEHIIV_PUBLICATION_ID` (opcional, par do anterior).
5. Rodar `scripts/sync-cursos-subscribers-kv.ts` pra popular o KV pela 1ª vez
   — já agendado depois disso via Task Scheduler diariamente às 09:15 (ver
   `scripts/setup-cursos-kv-sync-schedule.ps1`, task `Diaria-Cursos-Kv-Sync`).

Separadamente, a task `Diaria-Cursos-Error-Alarm` (a cada 2h,
`scripts/setup-cursos-error-alarm-schedule.ps1`) monitora os logs do worker
via Cloudflare GraphQL Analytics API e alarma o editor por e-mail em caso de
erro fatal ou taxa alta de `?email=` não confirmado (runbook completo:
`docs/cursos-worker-alarm-setup.md`).
