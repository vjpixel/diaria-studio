# workers/meta-leads — Secrets manifest + checklist de go-live (#7769)

Este worker foi só **escrito** por esta unidade — nunca deployado, nunca
testado contra a API real da Meta/Kit (guard de publicação do overnight,
`context/overnight-dispatch-rules.md` item 1: subagente implementador nunca
roda `wrangler deploy` nem chama API de terceiro ao vivo). Todos os passos
abaixo são ação POSTERIOR do editor.

## Required secrets

| Nome | Endpoint que depende | Onde conseguir |
|------|-----------------------|-----------------|
| `META_APP_SECRET` | `POST /webhook` (valida `X-Hub-Signature-256`) | Meta for Developers → App → Configurações → Básico → "Chave secreta do aplicativo" |
| `META_WEBHOOK_VERIFY_TOKEN` | `GET /webhook` (handshake) | Qualquer string forte escolhida pelo editor — é o MESMO valor que se digita no campo "Verificar token" do painel de configuração do webhook da Meta |
| `META_LEADS_PAGE_ACCESS_TOKEN` | `POST /webhook` (fetch do lead na Graph API) | Token de acesso de PÁGINA (não de usuário) com permissão `leads_retrieval` — gerado via Graph API Explorer ou fluxo OAuth do app, escopo `pages_show_list` + `pages_manage_ads` + `leads_retrieval` |
| `KIT_API_KEY` | `POST /webhook` (cria o subscriber) | Mesma key já usada pelos outros workers Kit-nativos (`workers/poll`, `workers/cursos`) — Kit → Configurações → Chaves de API |

```bash
cd workers/meta-leads
echo "$META_APP_SECRET"              | npx wrangler secret put META_APP_SECRET
echo "$META_WEBHOOK_VERIFY_TOKEN"    | npx wrangler secret put META_WEBHOOK_VERIFY_TOKEN
echo "$META_LEADS_PAGE_ACCESS_TOKEN" | npx wrangler secret put META_LEADS_PAGE_ACCESS_TOKEN
echo "$KIT_API_KEY"                  | npx wrangler secret put KIT_API_KEY
```

Sem `META_APP_SECRET`/`META_WEBHOOK_VERIFY_TOKEN`, o handshake `GET /webhook`
e a validação de assinatura de `POST /webhook` sempre rejeitam (403) —
comportamento fail-closed por design (`verifyMetaSignature`/`handleVerify`
em `src/crypto.ts`/`src/index.ts` tratam secret vazio como "nunca válido",
nunca "sem verificação").

## Checklist de go-live (ordem importa)

1. **Deploy do worker**: `cd workers/meta-leads && npx wrangler deploy`
   (primeiro deploy cria a rota `*.workers.dev` automaticamente — nenhum KV/DO
   a provisionar antes, este worker é stateless).
2. **Setar os 4 secrets acima.**
3. **App no Meta for Developers**: criar (ou reusar) um app com o produto
   "Webhooks" adicionado, permissões `leads_retrieval` + `pages_show_list` +
   `pages_manage_ads` — pode exigir App Review dependendo do modo do app
   (Live vs. Development; em Development, só admins/testers do app recebem
   webhooks).
4. **Configurar o webhook**: Meta for Developers → App → Webhooks → Página →
   "Editar assinatura" → URL de callback = `https://meta-leads.<subdomínio>.workers.dev/webhook`
   (ou domínio customizado, se configurado depois) → Verificar token = o
   MESMO valor setado em `META_WEBHOOK_VERIFY_TOKEN` → campo `leadgen`
   marcado.
5. **Subscrever a Página específica** ao campo `leadgen` (é um passo
   separado de configurar o app — "Subscrever" a página dentro da tela de
   Webhooks, não só configurar a URL).
6. **Smoke test end-to-end**: preencher um lead de teste no formulário
   instantâneo (Ads Manager tem um modo de teste/preview que dispara o
   webhook sem gastar budget) e confirmar via `wrangler tail` que o
   `POST /webhook` chegou, processou e o subscriber apareceu no Kit.
7. **Só depois**: publicar o rascunho de ad set `BR · conversao · sem teto —
   Cópia` (já criado, não publicado — ver corpo da #7769) que muda o local de
   conversão para "Site e formulário instantâneo". Decidir junto se o ad set
   ORIGINAL é pausado ou fica rodando em paralelo (dois ad sets ativos dobram
   o gasto potencial da campanha — ver #7769).

## Retenção de 90 dias da Meta (por que este worker é fail-hard)

A Meta só guarda o lead do formulário instantâneo por 90 dias em
`GET /{leadgen_id}`. `POST /webhook` responde **502** (não 200) sempre que
não conseguir processar algum lead do payload — assinatura inválida, falha
ao buscar o lead na Graph API, e-mail ausente/inválido, ou falha ao criar o
subscriber no Kit — para que a Meta faça retry automaticamente. Ver a
docstring no topo de `src/index.ts` para o racional completo e por que isso
é uma exceção deliberada ao padrão fail-soft do resto do projeto.

**Monitoramento recomendado (fora do escopo desta issue, mas caso o volume
justifique):** `wrangler tail` filtra por `[meta-leads]` nos logs de erro;
o painel "Error rate" do app no Meta for Developers também expõe falhas de
entrega de webhook. Se o volume de leads via formulário instantâneo crescer,
considerar um alarme dedicado (mesmo padrão de
`scripts/check-brevo-diaria-guardrail.ts`) — não implementado aqui por não
haver ainda volume real pra calibrar o threshold.

## `state: "active"` — decisão de design (não é bug)

`src/kit.ts` cria o subscriber já `active` (não `inactive` + DOI), porque o
consentimento já foi capturado pelo próprio formulário instantâneo da Meta.
Ver a docstring de `createKitSubscriberFromLead` em `src/kit.ts` para o
racional completo e como reverter isso se o editor decidir depois que o
formulário da Meta (dependendo de como for configurado no Ads Manager) não é
consentimento suficiente.
