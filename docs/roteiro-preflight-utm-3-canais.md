# Roteiro — preflight de atribuição do teste de 3 canais (#5522 + #5543)

Issues: [#5522](https://github.com/vjpixel/diaria-studio/issues/5522) (UTM sobrevive da home até o assinante — gate BLOQUEADOR MÁXIMO do teste de 3 canais) · [#5543](https://github.com/vjpixel/diaria-studio/issues/5543) (cookie de clique sobrevive ao salto `diar.ia.br` → `eia.diar.ia.br`) · [#5545](https://github.com/vjpixel/diaria-studio/issues/5545) (esta ferramentaria — script de veredito + limpeza + este roteiro) · [#5524](https://github.com/vjpixel/diaria-studio/issues/5524) (decisão que fecha o desenho do teste: R$ 1.000/braço · 14 dias · conversão).

**Este documento é uma passada só de navegador.** A #5543 pega carona explicitamente no teste da #5522 — não abrir o navegador duas vezes. Se você chegou aqui achando que precisa de dois roteiros separados, não precisa: siga a sequência abaixo do início ao fim.

**Nada aqui substitui a passada no navegador.** O objetivo é que ela dure ~5 minutos e não produza nenhuma dúvida de interpretação depois. Se algum passo aqui divergir do texto das issues-mãe, as issues-mãe são a fonte da verdade — este roteiro é a checklist executável delas, não uma reinterpretação.

---

## Leitura obrigatória antes de começar — achado ao vivo já registrado

**Uma sessão anterior (`/diaria-develop` 260817) já rodou este teste e reprovou — leia os comentários da [#5522](https://github.com/vjpixel/diaria-studio/issues/5522) antes de repetir.** Resumo do que já se sabe, pra não redescobrir:

1. **Testar os 3 braços em sequência no MESMO navegador contamina o resultado.** Os braços 2º e 3º herdaram o `utm_source` do 1º cadastro da sessão — `microsoft-ads` e `meta-ads` gravaram `google-ads` na Beehiiv, mesmo com a URL de chegada correta em cada troca (confirmado via eventos GTM/GA4/pixel, que refletiam o UTM certo a cada navegação — o problema é só no CADASTRO).
2. **Diagnóstico provável: atribuição first-touch via cookie de 1ª parte da Beehiiv.** Não é `localStorage`/`sessionStorage` (testado explicitamente: limpar os dois não resolveu o problema num reteste). A documentação oficial da Beehiiv ("Understanding subscriber attribution from your website") descreve a captura como algo que acontece "durante a visita", sem detalhar se é first-touch entre visitas — a mecânica exata (TTL do cookie, nome) não foi confirmada, só o comportamento observado.
3. **Por que isso pode não invalidar o teste real:** um visitante genuíno tende a chegar por UM canal, não a clicar em 3 anúncios de 3 plataformas diferentes em minutos no mesmo navegador. O risco real e mais estreito: alguém exposto a mais de um dos 3 anúncios dentro da janela de vida do cookie (desconhecida) seria atribuído ao PRIMEIRO clique — plausível dado que os 3 braços rodam simultaneamente por 14 dias com remarketing ativo nas 3 plataformas.

**A implicação prática para este roteiro:** os passos abaixo já refletem a mitigação — **cada braço numa janela anônima NOVA**, nunca reaproveitando aba/perfil. Pular essa instrução reproduz o falso-negativo já documentado.

---

## Sequência (uma passada, ~5 minutos + tempo de confirmação de e-mail)

Repita os passos 1–6 para cada um dos 3 braços, **cada um numa janela anônima nova** (Ctrl+Shift+N / Cmd+Shift+N — feche a janela anônima anterior antes de abrir a próxima, não só a aba).

### URLs pré-montadas dos 3 braços

Ajuste `SEU_UTM_CAMPAIGN` para um valor de teste distinto da campanha de produção real (ex: `preflight-2608`) — nunca o mesmo `utm_campaign` usado nos anúncios ao vivo, para não contaminar o snapshot real com tráfego de teste.

```
Google:     https://diar.ia.br/?utm_source=google-ads&utm_medium=cpc&utm_campaign=SEU_UTM_CAMPAIGN
Microsoft:  https://diar.ia.br/?utm_source=microsoft-ads&utm_medium=cpc&utm_campaign=SEU_UTM_CAMPAIGN
Meta:       https://diar.ia.br/?utm_source=meta-ads&utm_medium=paid_social&utm_campaign=SEU_UTM_CAMPAIGN
```

(Mesma estrutura de `data/aquisicao/campanhas-260816/00-PROTOCOLO.md` §0.3/§8.4 — arquivo gitignored, não linkável, mas o `utm_medium` por braço é o mesmo: `cpc` para busca, `paid_social` para Meta.)

### Passos, por braço

1. **Abrir a URL do braço numa janela anônima NOVA.** Confirmar visualmente que a home carregou (não um erro/redirect inesperado).

2. **Antes de clicar em qualquer coisa — item da #5543** — inspecionar `document.cookie` em `diar.ia.br` (DevTools → Console → `document.cookie`, ou aba Application → Cookies). Anotar:
   - se `_fbc`/`_fbp` (Meta Pixel) e `_ga` (GA4) estão presentes;
   - o atributo `domain` de cada cookie relevante (Application → Cookies → coluna Domain) — **é isso que decide se o cookie sobrevive ao salto de subdomínio**, não só a presença. Esperado: `.diar.ia.br` (com o ponto inicial, domain aberto ao subdomínio). Se algum vier como `diar.ia.br` restrito (sem o ponto), ele **não** vai acompanhar a navegação para `eia.diar.ia.br` — registrar isso como achado, não como coisa a "consertar" na hora.

3. **Clicar em "Assinar grátis"** — o botão da seção **hero** da home, nunca o campo de e-mail do rodapé. O teste é justamente da navegação interna (clique no widget → formulário), que é onde a #5522 registrou o risco de perda de UTM.

4. **Cadastrar o endereço de teste do braço** (ex: `preflight-google@…`, `preflight-microsoft@…`, `preflight-meta@…` — um endereço distinto por braço, nunca reaproveitar).

5. **Confirmar o double opt-in pelo e-mail.** O link de confirmação leva a `/confirmado` em `eia.diar.ia.br` ([`DIARIA_EIA_URL`](../scripts/lib/canonical-urls.ts), `https://eia.diar.ia.br`) — é onde a conversão de qualidade (pós-opt-in) dispara.

6. **Na página `/confirmado`, inspecionar `document.cookie` de novo — item da #5543.** Comparar com o passo 2: os mesmos `_fbc`/`_fbp`/`_ga` devem aparecer, porque `eia.diar.ia.br` e `diar.ia.br` são subdomínios do mesmo apex — **desde que o `domain` do cookie seja `.diar.ia.br`, não `diar.ia.br` restrito** (o mesmo atributo checado no passo 2). Registrar se os cookies sobreviveram ou não, e se o `domain` bate com o esperado.

    Nota separada, fora do escopo deste item: `gclid`/`msclkid` viajam por **query string**, não cookie — o redirect da Beehiiv não os repassa (achado já registrado na #5499), mas isso não afeta o teste de cookie de clique em si.

Repita 1–6 para os 2 braços restantes, cada um em janela anônima nova.

### Depois dos 3 braços

7. **Rodar o script de veredito da #5522** (requer `BEEHIIV_API_KEY` no ambiente — mesmo setup do resto do projeto, ver `CLAUDE.md`):

   ```bash
   npx tsx scripts/verify-preflight-utm.ts \
     --campaign SEU_UTM_CAMPAIGN \
     --emails google-ads=preflight-google@…,microsoft-ads=preflight-microsoft@…,meta-ads=preflight-meta@…
   ```

   Imprime, por braço, `esperado → obtido` de `utm_source`/`utm_campaign` (e `utm_medium`, informativo) + veredito `PASSOU`/`FALHOU`, e um veredito geral. **Critério de aprovação da #5522 (o que decide o veredito):**
   - os 3 cadastros aparecem com `utm_source` **exato** do braço (não `direct`, não `diar.ia.br`, não vazio);
   - `utm_campaign` também sobreviveu.

   Exit code 0 = passou; 1 = pelo menos 1 braço falhou ou não foi encontrado.

   **Se o veredito FALHAR reproduzindo o padrão já documentado** (braços 2º/3º com o `utm_source` do 1º) — não é motivo pra abrir uma investigação nova: é o mesmo achado já registrado na #5522, e a causa mais provável é ter reaproveitado sessão/aba entre braços. Confirmar que cada braço rodou em janela anônima **genuinamente nova** e repetir antes de escalar.

8. **Rodar a limpeza dos 3 cadastros de teste** (idempotente — pode rodar mais de uma vez sem erro; dry-run por padrão):

   ```bash
   npx tsx scripts/cleanup-preflight-test-subscribers.ts \
     --emails preflight-google@…,preflight-microsoft@…,preflight-meta@… \
     --execute
   ```

   Sem `--execute`, só lista o que seria deletado (dry-run). Isso fecha o último item do critério de aprovação da #5522 — os 3 endereços de preflight não podem ficar na base contaminando `leitor-v1`/custo por leitor do próprio teste que eles validam.

---

## Sondagem estática opcional (antes de abrir o navegador, ou pra diagnosticar uma reprovação)

Não é gate, não substitui os passos acima. Baixa a home com uma query string de teste e reporta o que o HTML servido contém sobre o widget "Assinar grátis" — útil só como redução de superfície e diagnóstico rápido:

```bash
npx tsx scripts/probe-home-widget-static.ts --query "utm_source=google-ads&utm_medium=cpc&utm_campaign=SEU_UTM_CAMPAIGN"
```

Como a #5522 já registrou, o botão real é um widget JS **sem `href` no HTML** — a sondagem não prova (nem tenta provar) se a query string chega até o cadastro. O gate é sempre o passo 7 acima, depois da passada real no navegador.

---

## Critério de pronto (visão geral, ambas as issues)

| Item | Onde é decidido | Ferramenta |
|---|---|---|
| `utm_source` exato por braço + `utm_campaign` sobrevivente (#5522) | Passo 7 | `scripts/verify-preflight-utm.ts` |
| Cookies de clique sobrevivem `diar.ia.br` → `eia.diar.ia.br` (#5543) | Passos 2 e 6 (inspeção manual do `document.cookie`, incl. atributo `domain`) | DevTools — sem ferramenta automatizada, ver "Se reprovar" abaixo |
| Cadastros de teste limpos | Passo 8 | `scripts/cleanup-preflight-test-subscribers.ts` |

## Se reprovar

Para o item do #5522 (UTM não sobrevive de verdade, não por reuso de sessão): não acender nada — seguir as alternativas registradas no corpo da #5522 (trocar destino dos anúncios para `/subscribe`, ou landing própria em Worker).

Para o item do #5543 (cookie não sobrevive ao salto de subdomínio): a conversão em `/confirmado` perde atribuição de clique pago mesmo com os pixels corretamente instalados — registrar o achado na #5543 com o `domain` exato observado em cada cookie; não há script de verificação automatizada para este item (é inspeção de `document.cookie` no navegador, não dado que a API da Beehiiv expõe).
