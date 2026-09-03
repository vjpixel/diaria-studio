# Roteiro do preflight — UTM (#5522) + cookies de atribuição (#5543)

**Reescrito no #7359 (03/09/2026) pro fluxo real.** A versão anterior deste
documento descrevia o widget JS da Beehiiv com double opt-in hospedado na
publicação — esse fluxo está extinto desde a home nova (`workers/site`,
commits `a0237e17`/`3a46efeb`, 01-02/09/2026). O cadastro real hoje é: **form
próprio na home → `POST` JSON direto pro worker `poll`
(`https://eia.diar.ia.br/jogar/subscribe`) → custom fields do Kit**
(`SUBSCRIBE_BACKEND = "kit"`, `workers/poll/wrangler.toml`). Os scripts do
passo 7/8 abaixo foram migrados no mesmo PR (`verify-utm-attribution.ts`,
`cleanup-preflight-subscribers.ts`) — rodá-los contra a versão anterior deste
roteiro daria **FALHOU falso nos 3 braços** (os e-mails de teste nunca
existiram na Beehiiv) e deixaria os 3 cadastros de teste vivos na conta Kit
de produção.

Uma única passada de navegador cobre as duas issues (#5543 pega carona no
teste da #5522 — mesmo navegador, mesma sessão, mesmo carregamento da home
com UTM real). Este documento é o roteiro executável — segue-lo do início ao
fim, na ordem, sem reabrir #5522 ou #5543.

**O que este roteiro NÃO substitui:** o clique real em "Assinar grátis" no
navegador. Os scripts abaixo preparam, verificam e limpam — nenhum deles
prova que o form da home de fato submete e que o cadastro chega no Kit com o
UTM certo.

## Antes de começar

Escolha um `utm_campaign` único pra esta rodada (ex: `preflight-{AAMMDD}`,
onde `AAMMDD` é a data de hoje — evita colidir com uma rodada anterior).
Gere o plano (URLs + e-mails de teste dos 3 braços — o gerador é
backend-agnóstico, não mudou no #7359):

```
npx tsx scripts/print-preflight-plan.ts --campaign preflight-2609
```

Saída (exemplo, campanha `preflight-2609`):

```
Plano de preflight — campanha "preflight-2609"

[google-ads]
  URL:   https://diar.ia.br/?utm_source=google-ads&utm_medium=cpc&utm_campaign=preflight-2609
  email: vjpixel+test-preflight-google-ads-preflight-2609@gmail.com

[microsoft-ads]
  URL:   https://diar.ia.br/?utm_source=microsoft-ads&utm_medium=cpc&utm_campaign=preflight-2609
  email: vjpixel+test-preflight-microsoft-ads-preflight-2609@gmail.com

[meta-ads]
  URL:   https://diar.ia.br/?utm_source=meta-ads&utm_medium=paid_social&utm_campaign=preflight-2609
  email: vjpixel+test-preflight-meta-ads-preflight-2609@gmail.com
```

Guarde essa saída à mão — os 3 pares URL/e-mail são usados nos passos 1-6
abaixo, um braço de cada vez, num **navegador anônimo**. **Fechar a janela
anônima INTEIRA e abrir uma nova (Ctrl+Shift+N) a cada braço — nunca só uma
aba nova na mesma janela, e nunca contar com "limpar cookies" como
alternativa.** Achado ao vivo confirmado na sessão `/diaria-develop` 260817
(ver comentários da #5522): testar os 3 braços em sequência numa mesma
sessão de navegador fez 2 dos 3 herdarem o `utm_source` do primeiro
cadastro (atribuição first-touch presa num cookie de 1ª parte) — abas da
mesma janela anônima compartilham cookies entre si, e janelas anônimas
SIMULTÂNEAS também compartilham a mesma sessão off-the-record — só
**fechar TODAS as janelas anônimas antes de abrir a próxima** zera de
verdade. Reproduzir esse erro de metodologia produz um FALHOU espúrio no
passo 7, que não é sinal real sobre o teste de produção.

## Passada de navegador — repita para cada um dos 3 braços

1. **Abrir a home com a query string do braço** — cole a `URL` do plano
   acima na barra de endereço. Não use `/jogar/subscribe` nem nenhum
   atalho — o destino real dos anúncios é a home
   (`workers/site/public/index.html`), e é essa navegação que está sob
   teste (#5522 "O risco"). A allowlist do worker (`CLIENT_UTM_SOURCE_ALLOWED_PREFIXES`,
   `workers/poll/src/subscribe.ts`) já cobre os 3 `utm_source` dos braços —
   confirmado pelo fix do #6980.

2. **Antes de clicar em qualquer coisa**, abrir o console do navegador e
   inspecionar `document.cookie` em `diar.ia.br`. Anotar se `_fbc`, `_fbp`
   (Meta Pixel) e `_ga` (GA4) estão presentes — e, se der pra inspecionar
   via DevTools → Application → Cookies (não só `document.cookie`, que não
   mostra o atributo `domain`), **anotar o `domain` de cada cookie**. Isto é
   o item da #5543: o esperado é que os cookies sobrevivam ao salto pra
   `eia.diar.ia.br` (subdomínio do mesmo apex, é pra lá que o form da home
   envia o `POST`) **desde que `domain` seja `.diar.ia.br`** (com o ponto —
   cobre subdomínios) **e não** `diar.ia.br` restrito (só o host exato). É
   esse atributo, não só a presença do cookie, que decide o resultado do
   item 6 abaixo.

3. **Preencher o e-mail no campo do hero (masthead) e marcar o consentimento
   LGPD** — o "campo de e-mail" do hero é hoje um `<form>` real (não mais um
   link estilizado pra `/assinar`, ver `a0237e17`) que faz `POST` JSON pra
   `https://eia.diar.ia.br/jogar/subscribe` com o `utm_source`/`utm_medium`
   dinâmicos da própria query string (`source: "apex"`). A checkbox de
   opt-in é obrigatória — o servidor recusa (`400 optin_required`) sem ela,
   qualquer que seja `source`. Cadastrar o e-mail de teste do braço (o
   `email` do plano acima).

4. **Confirmar o double opt-in** — o worker cria o subscriber `inactive` e
   vincula ao form DOI do Kit (`KIT_DOI_FORM_ID`, dashboard Kit → form
   "Newsletter site"), que dispara o e-mail de confirmação (copy em
   `docs/kit-doi-confirmation-copy.md`). Abra o e-mail (chega na caixa de
   `vjpixel@gmail.com`, já que os e-mails de teste são plus-addressing sobre
   ela) e clique no link de confirmação.

5. **Na página de destino pós-confirmação**, inspecionar `document.cookie`
   de novo, mesmo processo do passo 2. **Anotar qual URL o link de
   confirmação abriu** — o redirect pós-confirmação é configurado no painel
   "Incentive" do form do Kit (mesmo painel citado em
   `docs/kit-doi-confirmation-copy.md`), não neste repo; não presumir que é
   `eia.diar.ia.br/confirmado` sem checar ao vivo (aquela página existe —
   `workers/poll/src/confirmado.ts` — mas foi escrita pro redirect da
   Beehiiv, `opt_in_redirect_url`, que não é mais o mecanismo de DOI ativo;
   se o painel Incentive do Kit ainda aponta pra lá, ótimo — GTM/cookies
   testam igual; se não, ajustar este passo com a URL real observada).
   Comparar com o que foi anotado no passo 2: os mesmos `_fbc`/`_fbp`/`_ga`
   deveriam aparecer aqui também, com o mesmo `domain` `.diar.ia.br`. Se
   sumiram, ou se o `domain` anotado no passo 2 era `diar.ia.br` restrito
   (sem o ponto), é isso que está quebrando a atribuição de clique pago na
   conversão pós-opt-in — ver #5543 pro porquê.

   **Fora de escopo, não confundir:** `gclid`/`msclkid` (Google/Microsoft
   Ads) viajam por query string, nunca por cookie — não são afetados por
   este item (achado já registrado na #5499).

   **Item 3 do critério de aprovação da #5522 — confirmar que o GTM dispara
   na página pós-confirmação.** Ainda nela, abrir DevTools → Console e
   rodar `dataLayer` (ou a aba Network, filtrando por
   `googletagmanager.com/gtm.js`) — confirmar que o container `GTM-TC8C65ZN`
   carregou e que algum evento de pageview/conversão aparece no `dataLayer`
   dessa página. A instrumentação em si já foi validada por código (#5499,
   PR #5540), mas isto aqui é a confirmação AO VIVO, com o cadastro real de
   teste, de que o disparo acontece na prática.

Repita os passos 1-5 pros outros 2 braços antes de seguir pro passo 6 — os
3 cadastros precisam existir no Kit pro script do passo 6 conseguir
avaliar todos de uma vez.

## Depois da passada — os dois comandos que fecham a rodada

6. **Rodar a verificação de atribuição** (critério de aprovação da #5522,
   avaliado de forma binária, sem ler JSON à mão — lê o Kit desde o #7359):

   ```
   npx tsx scripts/verify-utm-attribution.ts --campaign preflight-2609
   ```

   Exit code `0` = os 3 braços PASSARAM (`fields.utm_source` exato +
   `fields.utm_campaign` sobreviveu). Exit code `1` = ao menos 1 FALHOU — a
   saída lista `esperado → obtido` por braço com o motivo. Requer
   `KIT_API_KEY` no ambiente (`.env`). **Se algum braço falhar, NÃO
   acender nada** — ver "Se reprovar" na #5522 (trocar destino dos anúncios
   pra uma landing própria em Worker, ou revisar `CLIENT_UTM_SOURCE_ALLOWED_PREFIXES`).

7. **Limpar os 3 cadastros de teste** (último item do critério de aprovação
   — sem isso eles contaminam `leitor-v1`/custo-por-leitor):

   ```
   npx tsx scripts/cleanup-preflight-subscribers.ts --campaign preflight-2609 --push
   ```

   Idempotente — rodar de novo (com ou sem `--push`) depois de já ter
   limpado não erra, só reporta "já cancelled/bounced/complained"/"sem
   registro". Sem `--push` é dry-run (só mostra o plano, nenhuma escrita).
   Muda o estado do subscriber pra `cancelled` no Kit (`POST
   /subscribers/{id}/unsubscribe`) — nunca DELETE, preserva o histórico do
   registro.

## Critério de pronto (das duas issues, juntas)

- [ ] Passo 6 retornou `PASSOU` pros 3 braços (#5522).
- [ ] `dataLayer`/Network confirmaram o container `GTM-TC8C65ZN` disparando
      na página pós-confirmação, checado no passo 5 (#5522, item 3 do
      critério de aprovação original).
- [ ] O `domain` dos cookies `_fbc`/`_fbp`/`_ga` anotado nos passos 2 e 5
      é `.diar.ia.br` nos dois pontos, e os mesmos cookies aparecem na
      página pós-confirmação (#5543).
- [ ] Passo 7 rodou com `--push` e os 3 e-mails de teste saíram de
      `state: active`/`inactive` no Kit.

Se os 4 itens acima baterem, as issues #5522 e #5543 podem ser fechadas
citando este roteiro + a saída do passo 6 como evidência.
