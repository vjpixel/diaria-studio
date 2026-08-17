# Instrumentação de conversão do teste de 3 canais — estado final (#5500)

Documenta o estado **já publicado e verificado ao vivo** do container GTM
`GTM-TC8C65ZN`, depois que as tags novas (Meta, Microsoft UET) foram
importadas e publicadas via `docs/gtm-signup-tracking-setup.md` (material de
prep da #5546). Este arquivo é a fotografia do resultado, não o plano — pra
quem chegar depois e quiser saber "o que está no ar hoje", sem precisar
reconstruir a história pelos comentários da #5500/#5522.

## O gatilho único

Todas as 4 tags de conversão disparam do **mesmo trigger de dataLayer**,
exatamente o que o título da issue pedia:

```
Newsletter Signup - signedUp
tipo: Custom Event, casando {{_event}} == "signedUp"
```

`signedUp` é o evento nativo que o **Website Builder v2** da Beehiiv emite no
formulário de cadastro (confirmado ao vivo — a ressalva original da issue,
de que a documentação da Beehiiv só cobria o builder legado, caiu: builder v2
também emite, com `eventProps` presente). Sequência real capturada no
`dataLayer` durante um cadastro de teste:

```
gtm.formInteract · gtm.click-v2 · gtm.formSubmit · signedUp · gtm.historyChange-v2
```

Não foi necessário o "Plano B" (repontar pro trigger antigo `Newsletter Form
Submit`) que `gtm-signup-tracking-setup.md` previa como contingência.

## As 4 tags, todas no mesmo trigger

| Plataforma | Tag | Ação/evento | Trigger |
|---|---|---|---|
| Google Ads | `Google Ads Conversion Tracking` | conversão ligada a `AW-17790097065` | `Newsletter Signup - signedUp` |
| LinkedIn | `LinkedIn Conversion - Newsletter Signup` | `conversion_id: 29163954`, conta `550020065` | `Newsletter Signup - signedUp` |
| Meta | `Meta CompleteRegistration` | evento padrão `CompleteRegistration`, Advanced Matching | `Newsletter Signup - signedUp` |
| Microsoft UET | `Microsoft UET - Newsletter Signup` | Custom conversion, action `signup`, category `newsletter`, moeda `BRL` | `Newsletter Signup - signedUp` |

O Google Ads e o LinkedIn já mediam cadastro antes desta issue (Google desde
o fix do #4348) — o trabalho novo foi trazer Meta e Microsoft pro mesmo
padrão. **As duas tags existentes FORAM repontadas**: o acionador antigo
(`Newsletter Form Submit`) foi removido de cada uma e trocado por
`Newsletter Signup - signedUp` (GTM soma acionadores múltiplos com OU —
manter os dois teria disparado a conversão 2× por cadastro). O que ficou
intacto foi a **ação de conversão em si** — o Google Ads continua ligado ao
mesmo `AW-17790097065`/rótulo `pKZTCKnJxdAbEKmt_aJC`, sem criar uma 2ª ação
que quebraria a série histórica pós-31/07. O trigger antigo continua
existindo no container, sem tags — deixado de propósito como caminho de
volta se `signedUp` regredir.

**Tag separada para a base UET** (não combinada com o evento, diferente do
que `gtm-signup-tracking-setup.md` tinha desenhado): `Microsoft UET - Base
(todas as paginas)`, tipo nativo do GTM (**"Acompanhamento universal de
eventos do Microsoft Advertising"** — não é HTML customizado, é o template
oficial da Microsoft, disponível em "Mais" na galeria de tags, fácil de não
achar porque não aparece na busca por "UET"), disparando em
`Initialization - All Pages`. A base precisa carregar antes de qualquer
evento porque o próprio template do GTM avisa: sem ela, `uetq` não existe
quando o evento de cadastro chega.

## IDs de referência

- **Container GTM:** `GTM-TC8C65ZN` (conta `6328623289`, container
  `237767386`).
- **Microsoft UET Tag ID:** `187268188` (nome "UET diar.ia.br", conta
  `MEMELAB PRODUCAO MULTIMIDIA LTDA — G107CN1T`, `aid=189335528`).
- **Meta dataset:** `1285191740325112` (conta `10151064543294811`).
- **Meta Custom Conversion:** "Cadastro newsletter (signedUp)", categoria
  Sign-up (sob Leads, não Sales — Sales implica pagamento), parâmetros
  `action equals signup` + `category equals newsletter`, **"Use for
  auto-bidding optimization" = Yes** (crítico — vem `No` por padrão; sem
  isso o Performance Max não consegue licitar por essa meta).
- **Google Ads tag:** `AW-17790097065`.

## Verificação ao vivo (17/08/2026)

Confirmado por três caminhos independentes:

1. **Rede, no cadastro de teste:** `bat.bing.com/p/action/187268188.js`
   carrega e `bat.bing.com/action/0` dispara com
   `event=signup, event_category=newsletter, currency=BRL`. `fbq` chamado 0
   vezes num cadastro isolado do fluxo padrão (ver ressalva abaixo), `lintrk`
   1 vez. `typeof window.uetq` deixou de ser `"undefined"`.
2. **Painel da própria Microsoft:** o teste de conversão do painel (*"test
   your conversion goals at least once"*) devolveu **`Test passed`** — é
   confirmação da ponta deles, que a inspeção de rede sozinha não prova
   (rede só mostra que o beacon saiu, não que foi aceito e casou com a
   regra do goal).
3. **Observado ao vivo nesta mesma sessão, incidentalmente, ao investigar o
   #5543:** navegando `eia.diar.ia.br/confirmado` pra outro teste (o
   comentário do #5543 registra a lista genérica de requests, sem este nível
   de detalhe), capturei o mesmo `bat.bing.com/action/0` com `ti=187268188`
   e o `gtag.js` de `AW-17790097065` aparecendo na carga
   da página — confirma que a base UET e o gtag do Google Ads também
   carregam em `/confirmado`, não só na home.

### Armadilha de diagnóstico registrada

O snippet que o painel da Microsoft mostra usa `bat.bing.net/bat.js`, mas a
tag do GTM carrega `bat.bing.com` — checar `.net` primeiro dá falso negativo.

## Higiene

9 assinantes de teste criados entre as sessões da #5500 e #5522, 9
deletados (`DELETE /subscriptions/{id}` → HTTP 204 em todos). Base limpa.

## Itens que continuam abertos (não cobertos por este documento)

- **Reconciliação da 1ª semana de campanha** — comparar conversões
  reportadas por cada painel contra cadastros reais em
  `data/aquisicao/origem-original.json`. Só é possível depois que a
  campanha rodar por tempo suficiente; não é um item de setup.
- **Formulário do rodapé** (`f116dddf-…`) — não verificado se também emite
  `signedUp`. O tráfego pago cai no formulário do herói (provado), mas
  cadastro orgânico pelo rodapé pode não estar sendo contado pelas 4
  plataformas. Pendência herdada do #5500, ainda sem dono.
- **Meta Pixel em `/confirmado`** — achado da #5543 (17/08/2026): o
  `facebook.com/tr` não dispara em `eia.diar.ia.br/confirmado`, só em
  `diar.ia.br`. Não é bug desta instrumentação (que cobre cadastro, não
  confirmação pós-double-opt-in) — é escopo de quem tocar #5500/#5516 a
  seguir, se a campanha Meta precisar contar confirmação e não só cadastro.
- **`fbq` zero num teste isolado** — o comentário original da #5500 mediu
  `fbq` chamado 0 vezes no cadastro de teste 1, contra `lintrk` 1 vez. Não
  investigado se é intermitência do Pixel base (que carrega fora do GTM,
  injeção nativa da Beehiiv) ou problema real — registrado, não resolvido.

## Relacionadas

#5500 (issue-mãe), #5546/`docs/gtm-signup-tracking-setup.md` (material de
import pré-publicação, agora histórico), #5522 (gate de UTM que trouxe os
achados de `fbq`/`lintrk`/`uetq`), #5543 (achado do Meta Pixel ausente em
`/confirmado`), #5524 (protocolo do teste de 3 canais que consome esta
instrumentação), #4348 (origem do trigger `Newsletter Form Submit`).
