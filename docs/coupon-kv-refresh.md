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

O workflow `.github/workflows/refresh-coupons-kv.yml` roda o comando acima
**todo dia às 06:00 BRT** (`0 9 * * *` UTC) e também sob demanda
(`workflow_dispatch`). Assim a comissão/pago/1º-pagamento atualizam sozinhos
conforme os trials convertem — sem populate manual.

Rodamos como **job agendado no GitHub Actions** (Node), não como cron no Worker:
`fetchCouponUsage` pagina TODAS as subscriptions da conta Stripe, o que em volume
alto estoura os limites de subrequest/CPU de um Cloudflare Worker. O runner Node
não tem esse teto.

## Setup (editor, 1×)

Em **Settings > Secrets and variables > Actions**, criar os secrets:

| Secret | Valor |
|---|---|
| `STRIPE_API_KEY` | chave restrita read-only (Coupons/Customers/Subscriptions/Charges = Read) — mesma do `.env.example` |
| `CLOUDFLARE_ACCOUNT_ID` | account id do Cloudflare |
| `CLOUDFLARE_WORKERS_TOKEN` | token com permissão de escrita no KV `STATS_CACHE` |

Sem os secrets, o run falha com mensagem clara (sinal visível no Actions) e
**não corrompe o KV** — o CLI aborta antes de escrever.

## Disparo manual

- GitHub UI: **Actions > Refresh Coupons KV > Run workflow**.
- Local (com os envs setados no shell / `.env.local`):
  `npx tsx scripts/stripe-coupon-usage.ts --write-kv`

## Nota

Todas as 3 assinaturas com NEWS50/NEWS25 estão em trial de 7 dias enquanto este
doc é escrito → pago/comissão = R$0,00 e a data do 1º pagamento aparece como
previsão (`*`). Os valores reais surgem conforme os trials convertem e o refresh
diário roda.
