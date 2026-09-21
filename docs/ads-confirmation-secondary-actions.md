# Confirmação (DOI) como ação SECUNDÁRIA nas plataformas de anúncio (#8387)

Runbook do que resta da Etapa 1 do #8387. Nenhuma meta primária muda antes de
**27/09/2026** (fim da janela do teste 2608); ações novas nascem **secundárias**.

## Estado (20/09/2026)

| Item do #8387 | Estado |
|---|---|
| Etapa 2, `doi-confirmacao-dia` real | entregue (#8552, PR #8566) |
| Etapa 3 Google, import offline com `click_id` | entregue em código (#8555, PR #8567, task #8573); falta criar a ação `UPLOAD_CLICKS` secundária no painel |
| Etapa 3 Meta CAPI / Microsoft / LinkedIn | aberto: #8543 |
| Pixel Meta deduplica com a CAPI | entregue (#8572, #8579) |
| Confirmação pela Brevo termina em `/confirmada` | entregue (#8539, #8554) |
| Doc-rot circular `confirmado.ts` x `confirmado-page.ts` | já resolvido: racional no bloco `#8387` de `scripts/lib/shared/confirmado-page.ts` |
| 2ª ação por pageview (4 plataformas, Meta incluída) | proposta versionada: `docs/gtm-confirmation-secondary-import-proposal.json`; falta importar no GTM |
| "After confirming redirect to" do form Kit `9897918` | painel do Kit, pendente (ver `docs/kit-doi-confirmation-copy.md`) |
| Promover a primária (Google + Meta juntos) | decisão depois de 27/09, ver abaixo |

## Passos do editor (painéis, nada disso é executável pelo repo)

1. **Kit**: form `9897918`, "After confirming redirect to" = `https://diar.ia.br/confirmada`.
2. **Criar as ações secundárias** (sem entrar em lance): Google Ads (website, "Incluir em Conversões" desmarcado, contagem "Uma"), Meta (nada a criar, é evento custom), Microsoft (goal de evento `newsletter_confirmed`), LinkedIn (conversão nova, id numérico).
3. **GTM** (`GTM-TC8C65ZN`): importar `docs/gtm-confirmation-secondary-import-proposal.json` em modo **Merge**, substituir os `REPLACE_*`, validar no **Preview** em `https://diar.ia.br/confirmada` e em `https://diar.ia.br/confirmada?via=brevo` (mesmo disparo, uma vez por sessão; limpe o sessionStorage ou use janela anônima entre as duas URLs, senão o guard suprime o 2º disparo), confirmar que o Pixel base da Meta carrega na página (#5543), só então publicar. O container real usa o template oficial do Pixel, não Custom HTML (#8578): conferir o resultado do Merge.
4. **Checklist antes de publicar:** o arquivo/workspace final não pode conter nenhum `REPLACE_` (o placeholder do LinkedIn é JS válido e só falha em runtime com ReferenceError; o do Google vira rótulo inválido). Só grava o guard de sessão depois que `fbq`/`lintrk` rodam, então pixel tardio não queima o guard.
5. Registrar a mudança em `edicoes.jsonl` (`scripts/ads-registrar-edicao.ts`) antes de publicar, pelo regime do teste 2608.

## Leitura (fase 2, a partir de 27/09)

Comparar por canal, sobre coorte madura (7 dias ou mais): `signedUp` x pageview de `/confirmada` x import offline x confirmados reais no Kit. O pageview subconta quem confirma em outro device e superconta recargas (o guard de sessão mitiga, não elimina); o import é o que deduplica por pessoa.

## Promoção a primária

Só depois de 27/09, no Google e na Meta ao mesmo tempo, com o import cobrindo bem (dedup Meta do #8572 já fechado; o import é #8555/#8543). O alvo de custo é recalibrado sobre confirmado (comentário de 20/09 na issue: ~R$ 3,50), e o atraso de 7 a 14 dias da confirmação exige o modelo de atraso construído antes, com a ação secundária rodando 2 a 3 semanas.
