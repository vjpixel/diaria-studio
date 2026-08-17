# Roteiro do preflight — UTM (#5522) + cookies de atribuição (#5543)

Uma única passada de navegador cobre as duas issues (#5543 pega carona no
teste da #5522 — mesmo navegador, mesma sessão, mesmo carregamento da home
com UTM real). Este documento é o roteiro executável — segue-lo do início ao
fim, na ordem, sem reabrir #5522 ou #5543.

**O que este roteiro NÃO substitui:** o clique real em "Assinar grátis" no
navegador. Os scripts abaixo preparam, verificam e limpam — nenhum deles
prova que o widget JS da Beehiiv propaga a query string (ver `scripts/probe-beehiiv-subscribe-widget.ts`,
que é diagnóstico, não aprovação).

## Antes de começar

Escolha um `utm_campaign` único pra esta rodada (ex: `preflight-{AAMMDD}`,
onde `AAMMDD` é a data de hoje — evita colidir com uma rodada anterior).
Gere o plano (URLs + e-mails de teste dos 3 braços):

```
npx tsx scripts/print-preflight-plan.ts --campaign preflight-2608
```

Saída (exemplo, campanha `preflight-2608`):

```
Plano de preflight — campanha "preflight-2608"

[google-ads]
  URL:   https://diar.ia.br/?utm_source=google-ads&utm_medium=cpc&utm_campaign=preflight-2608
  email: vjpixel+test-preflight-google-ads-preflight-2608@gmail.com

[microsoft-ads]
  URL:   https://diar.ia.br/?utm_source=microsoft-ads&utm_medium=cpc&utm_campaign=preflight-2608
  email: vjpixel+test-preflight-microsoft-ads-preflight-2608@gmail.com

[meta-ads]
  URL:   https://diar.ia.br/?utm_source=meta-ads&utm_medium=paid_social&utm_campaign=preflight-2608
  email: vjpixel+test-preflight-meta-ads-preflight-2608@gmail.com
```

Guarde essa saída à mão — os 3 pares URL/e-mail são usados nos passos 1-6
abaixo, um braço de cada vez, num **navegador anônimo** (aba anônima nova
por braço, ou limpar cookies entre braços — os 3 testes não podem
contaminar uns aos outros).

(Opcional, reduz a superfície antes de abrir o navegador: `npx tsx
scripts/probe-beehiiv-subscribe-widget.ts --url "<URL do braço>"` — reporta
o que o HTML da home contém sobre o widget de assinatura. Diagnóstico, não
aprovação — ver nota no topo deste doc.)

## Passada de navegador — repita para cada um dos 3 braços

1. **Abrir a home com a query string do braço** — cole a `URL` do plano
   acima na barra de endereço. Não use `/subscribe` nem nenhum atalho —
   o destino real dos anúncios é a home, e é essa navegação que está sob
   teste (#5522 "O risco").

2. **Antes de clicar em qualquer coisa**, abrir o console do navegador e
   inspecionar `document.cookie` em `diar.ia.br`. Anotar se `_fbc`, `_fbp`
   (Meta Pixel) e `_ga` (GA4) estão presentes — e, se der pra inspecionar
   via DevTools → Application → Cookies (não só `document.cookie`, que não
   mostra o atributo `domain`), **anotar o `domain` de cada cookie**. Isto é
   o item da #5543: o esperado é que os cookies sobrevivam ao salto pra
   `eia.diar.ia.br` (subdomínio do mesmo apex) **desde que `domain` seja
   `.diar.ia.br`** (com o ponto — cobre subdomínios) **e não** `diar.ia.br`
   restrito (só o host exato). É esse atributo, não só a presença do
   cookie, que decide o resultado do item 6 abaixo.

3. **Clicar em "Assinar grátis"** — o botão principal da home, nunca o campo
   de e-mail do rodapé. O teste é justamente da navegação interna que esse
   botão dispara (widget JS do Beehiiv, sem `href` estático — #5522).

4. **Cadastrar o e-mail de teste do braço** (o `email` do plano acima) no
   formulário que o widget abrir.

5. **Confirmar o double opt-in** — abra o e-mail de confirmação (chega na
   caixa de `vjpixel@gmail.com`, já que os e-mails de teste são
   plus-addressing sobre ela) e clique no link de confirmação.

6. **Na página `/confirmado`** (ela vive em `eia.diar.ia.br`), inspecionar
   `document.cookie` de novo, mesmo processo do passo 2. Comparar com o que
   foi anotado lá: os mesmos `_fbc`/`_fbp`/`_ga` deveriam aparecer aqui
   também, com o mesmo `domain` `.diar.ia.br`. Se sumiram, ou se o `domain`
   anotado no passo 2 era `diar.ia.br` restrito (sem o ponto), é isso que
   está quebrando a atribuição de clique pago na conversão pós-opt-in — ver
   #5543 pro porquê.

   **Fora de escopo, não confundir:** `gclid`/`msclkid` (Google/Microsoft
   Ads) viajam por query string, nunca por cookie — não são afetados por
   este item, e o redirect da Beehiiv não os repassa de qualquer forma
   (achado já registrado na #5499).

Repita os passos 1-6 pros outros 2 braços antes de seguir pro passo 7 — os
3 cadastros precisam existir na Beehiiv pro script do passo 7 conseguir
avaliar todos de uma vez.

## Depois da passada — os dois comandos que fecham a rodada

7. **Rodar a verificação de atribuição** (critério de aprovação da #5522,
   avaliado de forma binária, sem ler JSON à mão):

   ```
   npx tsx scripts/verify-utm-attribution.ts --campaign preflight-2608
   ```

   Exit code `0` = os 3 braços PASSARAM (utm_source exato + utm_campaign
   sobreviveu). Exit code `1` = ao menos 1 FALHOU — a saída lista
   `esperado → obtido` por braço com o motivo. **Se algum braço falhar, NÃO
   acender nada** — ver "Se reprovar" na #5522 (trocar destino dos anúncios
   pra `/subscribe`, ou landing própria em Worker).

8. **Limpar os 3 cadastros de teste** (último item do critério de aprovação
   — sem isso eles contaminam `leitor-v1`/custo-por-leitor):

   ```
   npx tsx scripts/cleanup-preflight-subscribers.ts --campaign preflight-2608 --push
   ```

   Idempotente — rodar de novo (com ou sem `--push`) depois de já ter
   limpado não erra, só reporta "já inativo"/"sem registro". Sem `--push` é
   dry-run (só mostra o plano, nenhuma escrita).

## Critério de pronto (das duas issues, juntas)

- [ ] Passo 7 retornou `PASSOU` pros 3 braços (#5522).
- [ ] O `domain` dos cookies `_fbc`/`_fbp`/`_ga` anotado nos passos 2 e 6
      é `.diar.ia.br` nos dois pontos, e os mesmos cookies aparecem em
      `eia.diar.ia.br/confirmado` (#5543).
- [ ] Passo 8 rodou com `--push` e os 3 e-mails de teste saíram de
      `status: active` na Beehiiv.

Se os 3 itens acima baterem, as issues #5522 e #5543 podem ser fechadas
citando este roteiro + a saída do passo 7 como evidência.
