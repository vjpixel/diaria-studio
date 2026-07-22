# Experimento CTA-01 — copy do CTA do topo (digest mensal Clarice, ciclo 2606-07)

**Status:** em preparação (aguardando aprovação da copy B pelo editor)
**Início:** envio 8 (qui 23/07/2026, 06:00 BRT) — campanhas Brevo 95 (A) + nova (B)
**Continuação:** envio 9 (sex 24/07) — campanhas 96 (A) + nova (B); envios seguintes do ramp mantêm as MESMAS variantes até bater a regra de decisão.

---

## Hipótese

Trocar o CTA do topo (Apresentação) por uma versão com benefício explícito e âncora de ação aumenta a taxa de clique única no link em **≥30% relativo** vs o texto atual ("se cadastre gratuitamente [aqui]").

## Braços

- **A (controle):** texto atual do topo, sem mudanças.
- **B (tratamento):** nova copy do CTA do topo (registrada abaixo quando aprovada). **Única variável** — bloco do meio ("Assinar a edição diária") e encerramento idênticos nos dois braços. A frase do "quero" (prioridade na mensal da Clarice) fica intacta nos dois braços — é outro funil.

## Randomização

Split 50/50 **dentro de cada envio** (nunca entre envios — ondas são ordenadas por priority_points/cohort, comparar onda N×N+1 confunde variante com qualidade do contato). Amostragem sistemática (alternada) sobre a ordem da lista original → preserva a mistura de tiers em cada célula (mesmo padrão do teste A/B/C de assunto, `clarice-split-cells.ts`). Duas campanhas por envio, **mesmo horário**.

## Tracking (UTMs)

Todos os links `diaria.beehiiv.com`:

- `utm_source=clarice` + `utm_medium=email` — inalterados (filtro agregado existente).
- `utm_campaign=clarice-2606-07-cta-a` | `-cta-b` — identifica o **braço**; chega ao Beehiiv (Acquisition details), que não armazena utm_content de forma confiável.
- `utm_term=topo|corpo|fim` — identifica a **posição** do link; permite ler clique por URL na Brevo (links stats são por URL exata — sem isso, topo e fim têm a mesma URL e são indistinguíveis).

**Pré-condição descoberta em 22/07:** o HTML das campanhas 95/96 na Brevo estava com `utm_source=sendinblue&utm_campaign=` (vazio) gravado nos hrefs — UTMs nossos perdidos (campanhas montadas manualmente, HTML copiado já reescrito pelo GA tracking da Brevo). O setup do experimento reaplica o HTML canônico (`data/monthly/2606-07/_internal/cloudflare-preview.html`, que está correto) com os UTMs acima. **GA tracking da Brevo deve ficar DESLIGADO nas campanhas do experimento** (Additional settings → Sending and Tracking → "Activate Google Analytics tracking" OFF), senão a Brevo reescreve os links no envio.

## Métricas

- **Primária (decisão):** cliques na URL do CTA do **topo** (`utm_term=topo`) ÷ entregues, por braço, acumulado entre envios.
- **Secundárias:** cadastros no Beehiiv por `utm_campaign` (aquisição); desses, % que abriu a 1ª edição diária (ativação). Validam que o clique não é métrica de vaidade — se B clica mais mas converte igual, o gargalo é a landing, não o e-mail.
- **Guardrails (por braço, mesmos circuit breakers do ramp):** unsub ≥3%, spam ≥0,1%, abertura <15%, hard bounce ≥2%.

## Regra de decisão (pré-registrada)

Acumular envios até ~150 cliques de topo somados nos dois braços (ou fim do ciclo, o que vier primeiro). Teste de duas proporções sobre cliques únicos: **se B ≥ +30% relativo com p<0,05 e guardrails limpos → B vira o novo controle** (entra no template/render) e o round 2 testa a próxima variável (posição do bloco dedicado ou CTA do encerramento). Senão → mantém A.

**Honestidade estatística:** cadastro é evento raro demais pra decidir (canal inteiro = 6 subs/trimestre). Envios 8+9 dão ~6,2k + 6,8k por braço; com clique de topo na casa de 0,3–0,8% dos entregues, só lifts grandes (≥+40–50%) fecham em 2 envios — por isso a regra é acumular envios com as mesmas variantes, não decidir por envio.

## Regras operacionais (Brevo)

- Destinatários congelam no **agendamento**: mexer na lista de campanha queued exige suspend → re-agendar (re-snapshot).
- Campanha agendada não deleta/desagenda via API — validar 100% (lista, HTML, UTMs, horário) ANTES do scheduledAt.
- Investigação manual em loop estoura o rate limit horário da Brevo — usar `brevo-client.ts` (retry 429) e não martelar.

## Log de decisões

- 2026-07-22 — protocolo registrado; descoberta da corrupção de UTM nas campanhas 95/96; aguardando copy B.
- 2026-07-22 — copy B1 aprovada (tagline oficial + "Assine grátis a edição diária →"). Setup executado via `scripts/clarice-cta-ab-setup.ts`:
  - **Envio 8 (qui 23/07 06:00):** A = campanha **95** → lista **80** (6.179); B = campanha **97** → lista **81** (6.178).
  - **Envio 9 (sex 24/07 06:00):** A = campanha **96** → lista **82** (6.797); B = campanha **98** → lista **83** (6.796).
  - Listas originais 78/79 preservadas intactas (auditoria). Test emails dos 2 braços enviados ao editor.
- 2026-07-22 — **causa raiz do UTM corrompido identificada:** o GA tracking da Brevo reescreve `utm_source/utm_medium/utm_campaign` (campaign → NOME da campanha) **no save do htmlContent** (inclusive via API), mas **preserva `utm_term`**. Implicações: (a) leitura por posição funciona mesmo com tracking ligado; (b) braço é distinguível pelo utm_campaign reescrito (nomes A/B); (c) para o filtro agregado `utm_source=clarice` no Beehiiv funcionar, o editor precisa DESLIGAR o GA tracking nas 4 campanhas (UI) e o HTML precisa ser re-PUTado depois (`clarice-cta-ab-setup.ts` re-run ou reapply).
