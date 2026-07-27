# Experimento CTA-01 — copy do CTA do topo (digest mensal Clarice, ciclo 2606-07)

**Status:** ENCERRADO em 26/07/2026, **sem vencedor** — o braço B teve entrega degradada (classificado como spam), o que confunde entrega com efeito do CTA. Não repetir o protocolo antes de resolver a causa (#4061).
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
- 2026-07-22 (sessão `/diaria-develop`, #3893) — **toggle "Activate UTM tracking" desligado pelo editor + re-PUT verificado nas 4 campanhas.** Estado encontrado antes do fix: os 7 links `diaria.beehiiv.com` das 4 campanhas (95/97/96/98) tinham `utm_source`/`utm_medium`/`utm_campaign` **removidos** (não reescritos pra `sendinblue` como o registro anterior assumia — o toggle aparentemente strippa esses 3 parâmetros no save, preservando só `utm_term`). Ação: re-PUT do `htmlContent` a partir dos arquivos canônicos já gerados (`data/monthly/2606-07/_internal/cta-ab/envio{8,9}-{a,b}.html`), campanha-a-campanha, com revalidação de `status=queued` imediatamente antes de cada PUT (nunca tocando campanha não-queued). Canary (#95) rodado sozinho primeiro pra confirmar que o toggle realmente parou de reescrever antes de aplicar às outras 3.
  - **GET-verify determinístico pós-PUT, todas as 4 campanhas:** 7/7 links com `utm_source=clarice`, `utm_campaign=clarice-2606-07-cta-{a|b}` (braço correto por campanha), zero `utm_source=sendinblue`; `subject`/`scheduledAt`/`status=queued` inalterados em todas.
  - Novo test email dos 2 braços do envio 8 (campanhas 95/97) enviado ao editor (`vjpixel@gmail.com`) via `POST /emailCampaigns/{id}/sendTest`.
  - Envio 8 dispara qui 23/07 06:00 BRT — dentro do prazo.
- 2026-07-26 — **round ENCERRADO pelo editor, sem vencedor.** Causa: uma das opções foi classificada como spam, degradando a entrega daquele braço — os braços passaram a diferir em ENTREGA, não em persuasão do CTA, e a regra de decisão pré-registrada perdeu validade.
  - Números finais (Brevo, `globalStats`):

    | Envio | Braço | Campanha | Entregues | Aberturas únicas | Taxa | Cliques únicos | Reclamações |
    |---|---|---|---|---|---|---|---|
    | 8 (23/07) | A | 95 | 6.105 | 1.325 | 21,7% | 10 | 0 |
    | 8 (23/07) | B | 97 | 6.106 | 676 | 11,1% | 8 | 1 |
    | 9 (24/07) | A | 96 | 6.697 | 1.271 | 19,0% | 59 | 1 |
    | 9 (24/07) | B | 98 | 6.687 | 134 | 2,0% | 5 | 0 |

  - Leitura: B degrada progressivamente (abertura pela metade no envio 8, colapso no envio 9), com o clique caindo junto. Reclamações formais ~0 nas 4 campanhas → **não é denúncia de leitor, é colocação de caixa de entrada** (foldering), que o contador `complaints` da Brevo não captura. Células comparáveis por construção (split 50/50 sistemático dentro do MESMO envio), então qualidade de contato não explica o gap.
  - Guardrail furado sem parar o round: B já estava abaixo do limiar de abertura (<15%) no envio 8, e o envio 9B saiu mesmo assim — com resultado pior. Enforcement automático entre envios: ver issue irmã do #4061.
  - `status` do experimento no registro da dashboard atualizado pra `encerrado` com `closureNote` (`workers/brevo-dashboard/src/experiment-cta.ts`).
- 2026-07-27 — **investigação de causa (#4061), escopo autônomo = só diagnóstico offline** (decisão do editor, comentário 260727): diff dos dois HTMLs canônicos + hipótese de gatilho, sem tocar campanhas.
- 2026-07-27 — **CTA-01 CONGELADO pelo editor**, seguindo a recomendação desta investigação. Não há novo round enquanto as duas pré-condições não forem atendidas: (a) **#4063** — circuit breaker de spam lendo o Postmaster em vez do `complaints` da Brevo, **e** reputação do domínio de volta abaixo de 0,3%; (b) **#4064** — enforcement de guardrail entre envios, pra que um braço que furou o limiar no envio N não saia no envio N+1. A decisão de repetir ou abandonar de vez o CTA-01 fica para quando as duas estiverem cumpridas — não é "abandonado", é **adiado com pré-condições explícitas**. #4061 fechada como investigada; o trabalho remanescente vive em #4063 e #4064.

## Investigação de causa (#4061)

### O diff exato entre os braços

Única variável do protocolo, o parágrafo do topo (`scripts/clarice-cta-ab-setup.ts`, `TOPO_A`/`TOPO_B`):

- **A (controle):** "Se quiser receber tutoriais e notícias de IA todos os dias, se cadastre gratuitamente **aqui**." — âncora de 1 palavra ("aqui"), verbo no infinitivo/reflexivo ("se cadastre"), sem marca em destaque, sem símbolo.
- **B (tratamento):** "E pra não esperar um mês: a **diar.ia.br** entrega isso todo dia — 5 minutos pra se manter atualizado e usar melhor as IAs. **Assine grátis a edição diária →**" — âncora é a frase inteira ("Assine grátis a edição diária →", verbo imperativo + "grátis" + seta), wordmark em bold com cor de destaque logo antes.

O re-PUT do HTML **não é candidato**: o #4045 já comparou 96 vs 98 byte-a-byte e o único diff fora do parágrafo do topo é o sufixo esperado `utm_campaign=cta-a`→`cta-b` — sem corrupção, sem link extra, sem alteração de proporção texto/link no resto do corpo (só esse bloco muda).

### Candidatos e avaliação

1. **Palavra "grátis"** — descartada como diferenciador isolado: aparece nos DOIS braços ("gratuitamente" em A, "grátis" em B), só muda a flexão.
2. **Proporção texto/link do e-mail inteiro** — descartada: o bloco do meio ("Assinar a edição diária") e o encerramento são idênticos nos dois braços; só o parágrafo do topo muda, e o texto adicional em B (~25 palavras a mais) é marginal frente ao corpo completo do digest.
3. **HTML corrompido / re-PUT** — descartada (ver acima, já coberto pelo #4045).
4. **Âncora do link + densidade promocional do bloco** — candidato mais forte, não descartado: em B a âncora clicável é uma frase-CTA completa com verbo imperativo ("Assine"), a palavra "grátis" adjacente ao link (não só em outra frase), e o glifo "→", precedida por uma wordmark em **bold** com cor de destaque. Esse padrão — CTA imperativo + "grátis" + seta, tudo no mesmo bloco clicável, logo no topo do e-mail (above the fold) — é um sinal textual clássico de classificadores de conteúdo promocional/comercial (Gmail e afins), diferente da âncora "aqui" de A, que é neutra e não carrega esses tokens.

### Leitura: gatilho vs condição de fundo

A causa mais provável **não é puramente a copy nem puramente a infraestrutura** — é a combinação:

- A reputação do domínio remetente (`clarice.ai`) já estava degradada antes do experimento: Postmaster Tools mostra reclamação de spam em ~1,0% desde início de julho (pico 1,5% em 20/07), muito acima do limiar do Google (0,10%) — ver #4063. A Brevo não captura isso (`complaints` fica ≤0,02%) porque a maior parte da base é Gmail e o botão "marcar como spam" do Gmail não passa por feedback loop.
- Nessa condição de reputação já fragilizada, o parágrafo de topo de B, com densidade de sinais promocionais (CTA imperativo + "grátis" + seta + marca em destaque, tudo above the fold) é plausivelmente o empurrão que faltava para o classificador de conteúdo do Gmail foldear aquele fluxo especificamente para Promoções/Spam — enquanto A, com âncora neutra, ficou abaixo do limiar de suspeita.
- **Isto não está provado, é a hipótese mais consistente com a evidência disponível.** Os dois braços são confundidos com a tendência temporal de reputação (envio 9 pior que envio 8 nos DOIS braços, mesmo em A: 21,7%→19,0%) — não dá para isolar 100% o efeito da copy do efeito de reputação caindo ao longo dos dias com o mesmo teste rodando. O que a evidência permite afirmar com confiança: (a) não é infraestrutura/IP (headers idênticos, #4045); (b) não é reclamação de leitor (complaints ~0); (c) é colocação de caixa, não persuasão (MPP prefetch divergente); (d) dado que a única variável de conteúdo entre os braços é a copy do topo, e a copy de B tem densidade promocional muito maior que A no bloco mais sensível (above the fold), essa é a explicação mais parcimoniosa para por que B piorou MAIS que A ao longo dos dois envios, e não só igualmente com a tendência de fundo.

### Recuperação do canal pós-envio-9 — PENDENTE

Não verificada nesta investigação (escopo 260727 restringiu a diagnóstico offline; sessão rodou em ambiente cloud sem acesso ao junction `data/` nem à dashboard local). Fica pendente de um envio futuro do ramp, conforme a própria decisão do editor no #4061 registra — não bloqueia o fechamento desta parte.

### Recomendação (não é decisão — cabe ao editor)

Não repetir o protocolo A/B nesta peça até: (a) o #4063 corrigir a fonte do circuit breaker de spam (Postmaster em vez de `complaints` da Brevo) e a reputação do domínio voltar a operar abaixo de 0,3%; e (b) o #4064 (enforcement de guardrail entre envios) estar implementado, para que um braço que já furou o limiar de abertura no envio N não volte a sair no envio N+1. Refazer o round hoje, mesmo com espaçamento e alternância de ordem corrigidos, herdaria a mesma reputação degradada de fundo e arriscaria reproduzir o problema.
