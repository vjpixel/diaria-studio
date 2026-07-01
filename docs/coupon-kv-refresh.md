# Refresh automático do KV de cupons (#2750)

O tab **Cupons** do dashboard (`clarice-dashboard.diaria.workers.dev`) lê o KV
`coupons:usage`, que carrega, por assinatura com cupom NEWS50/NEWS25: o valor
pago (realizado, 12m desde o resgate), a comissão de 40% (#2743) e a data do 1º
pagamento — real ou prevista com `*` para trials (#2749).

Esse KV é repopulado por `scripts/stripe-coupon-usage.ts --write-kv`, que:
1. lê a Stripe (read-only: promotion_codes, coupons, subscriptions, customers,
   charges) e agrega via `fetchCouponUsage`/`aggregateCouponUsage`;
2. sobe o report JSON pro KV via `uploadTextToWorkerKV`.

## Automação

O workflow `.github/workflows/refresh-coupons-kv.yml` roda o comando acima (com
`--no-pii`, ver abaixo) **todo dia às 06:00 BRT** (`0 9 * * *` UTC) e também sob
demanda (`workflow_dispatch`). Assim a comissão/pago/1º-pagamento atualizam
sozinhos conforme os trials convertem — sem populate manual.

Rodamos como **job agendado no GitHub Actions** (Node 24), não como cron no
Worker: `fetchCouponUsage` pagina TODAS as subscriptions da conta Stripe, o que
em volume alto estoura os limites de subrequest/CPU de um Cloudflare Worker. O
runner Node não tem esse teto.

**Custo:** um run diário de ~1 min fica muito abaixo do free tier do GitHub
Actions (2.000 min/mês em repo privado) — honra o "zero custo recorrente" do
CLAUDE.md, sem justificativa adicional necessária.

**PII nos logs:** o workflow passa `--no-pii` — o CLI mostra o `cus_id` (opaco)
em vez do e-mail no stdout e **não grava o CSV local**, porque os logs do Actions
são retidos (~90 dias) e visíveis a colaboradores. O KV `coupons:usage` segue
com os e-mails (o dashboard é auth-gated, por design — ver #2748).

## Setup (editor, 1×)

Em **Settings > Secrets and variables > Actions**, criar os secrets:

| Secret | Valor |
|---|---|
| `STRIPE_API_KEY` | chave restrita read-only — **Coupons, Promotion Codes, Customers, Subscriptions, Charges = Read** (Promotion Codes é permissão separada de Coupons na UI da Stripe; sem ela o 1º call já dá 403). Mesma do `.env.example` |
| `CLOUDFLARE_ACCOUNT_ID` | account id do Cloudflare |
| `CLOUDFLARE_WORKERS_TOKEN` | token com permissão de escrita no namespace KV do dashboard (id `2f87d65d735c499ab8f465774d0167e2`, binding `STATS_CACHE` no worker) |

Sem os secrets, o run falha com mensagem clara (sinal visível no Actions) e
**não corrompe o KV**: faltando a chave Stripe, aborta antes de qualquer call;
faltando as credenciais Cloudflare com `--write-kv`, o CLI aborta **antes do
fetch na Stripe** (fail-fast, sem gastar quota) e nunca escreve no KV.

## Disparo manual

- GitHub UI: **Actions > Refresh Coupons KV > Run workflow** (roda com `--no-pii`).
- Local (com os envs setados no shell / `.env.local`, Node 24 como no CI):
  `npx tsx scripts/stripe-coupon-usage.ts --write-kv`
  (localmente, sem `--no-pii`, imprime e-mails e grava o CSV em `data/` — ok na
  máquina do editor; **não** use assim em ambiente compartilhado).

## Nota

Todas as 3 assinaturas com NEWS50/NEWS25 estão em trial de 7 dias enquanto este
doc é escrito → pago/comissão = R$0,00 e a data do 1º pagamento aparece como
previsão (`*`). Os valores reais surgem conforme os trials convertem e o refresh
diário roda.
