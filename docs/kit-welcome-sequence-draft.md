# Sequence de boas-vindas do Kit — proposta de conteúdo (draft)

> **Status: aguardando aprovação do editor.** Refs #6508. Nada disto foi criado
> no Kit — é só o texto proposto, pronto pra colar assim que aprovado.
>
> Calibrado por: `data/past-editions.md` (14 edições mais recentes, até
> 27/08/2026), amostra de corpo completo de edição real
> (`data/beehiiv-cache/posts/`, 259 posts com stats), e `context/editorial-rules.md`
> §5 (linguagem — evitar "IA"/"inteligência artificial" quando dá pra nomear o
> agente concreto).

## Formato recomendado: série de 4 e-mails, espaçados ao longo de ~10 dias

A issue deixou o formato em aberto entre 1 e-mail único e uma série de 3–5.
Recomendo **4 e-mails**, um por elemento candidato listado na decisão do
editor, espaçados **D0 (imediato) → D+3 → D+6 → D+10**. Justificativa:

1. **Os 4 elementos candidatos (o que é a diária, melhores edições, o É IA?,
   pedido de apoio) fazem sentido em ordens diferentes de intimidade** — dar
   boas-vindas e explicar o formato é dia 0; provar valor com edições reais
   vem depois que a pessoa já viu 1–2 edições normais chegarem; convidar pro
   jogo funciona melhor como engajamento leve no meio da sequência; e pedir
   apoio funciona bem mais quando já demonstrou valor 2–3 vezes antes — pedir
   isso no e-mail 1 é o oposto do que qualquer análise de conversão recomenda.
   Um e-mail único forçaria as 4 coisas na mesma respiração, incluindo um pedido
   de dinheiro antes da pessoa ter lido uma edição sequer.
2. **Aquecimento de domínio (motivo #2 da issue) se beneficia de envios
   distribuídos, não de um pico único.** O incidente do #6096/#6114 (rampa Kit,
   revertida em 28/08 por queda de abertura no Gmail — ver nota em
   `platform.config.json` → `publishing.newsletter.backend_note`) mostrou na
   prática que domínio novo sem histórico de reputação sofre justamente em
   Gmail. Uma sequência de 4 envios de baixo volume ao longo de ~10 dias por
   assinante gera sinal de engajamento contínuo (abertura + clique
   distribuídos no tempo) — o padrão que provedores de e-mail leem como
   positivo — em vez de 1 envio isolado que não ajuda a construir histórico.
3. **Não é diário nem semanal.** A diária já manda e-mail de segunda a sexta —
   empilhar a sequência em cima disso sem espaçamento (ex: 1 e-mail por dia)
   sobrecarregaria quem acabou de assinar. D0/D+3/D+6/D+10 garante que cada
   e-mail da sequência chegue em dias onde a pessoa já recebeu 2–3 edições
   normais, nunca no mesmo dia que outra mensagem da sequência.
4. **4, não 5+.** Cada e-mail cobre exatamente 1 dos 4 elementos já listados
   pelo editor — não há um 5º tema óbvio que justifique mais um envio, e
   dividir qualquer um dos 4 em 2 e-mails diluiria sem ganho.

Se o editor preferir menos e-mails, a fusão mais natural é E3+E4 (É IA? +
apoio) num só, porque os dois são "convites a se engajar mais" — mas prefiro
propor os 4 separados e deixar a decisão de cortar para a revisão, em vez de
já cortar por conta própria (critério 2 de "Perguntar é exceção": é trade-off
editorial genuíno sobre o que o assinante novo vê).

---

## E-mail 1 — D0 (imediato ao cadastro)

**Assunto (3 opções):**
1. Bem-vindo à diar.ia.br: isto é o que vem a seguir
2. Você acabou de assinar. Aqui está o que esperar.
3. Antes da 1ª edição chegar, uma explicação rápida

**Preview text:** Sem newsletter genérica de robô: é curadoria com nome e sobrenome.

**Corpo:**

```
Oi! Aqui é o Pixel, editor da diar.ia.br.

Obrigado por assinar. Antes da próxima edição chegar, um resumo rápido de
como isso funciona, pra você não ficar tentando entender o formato no meio
de uma manhã corrida.

O que é a diar.ia.br

Todos os dias úteis, eu seleciono e resumo as notícias mais relevantes sobre
inteligência artificial em português. O processo é assistido por modelos de
linguagem (Claude, Gemini), mas a curadoria final é minha: o que entra, o
que fica de fora, o que realmente importa. Nenhuma edição sai sem eu ler
antes.

Cada edição tem de 2 a 3 destaques, com uma linha fixa em cada um: "Por que
isso importa". É a parte que eu mais me importo de acertar. Não basta saber
o que aconteceu, o texto explica o que muda pra quem lê.

Além dos destaques, toda edição traz uma seção Radar (mais notícias,
resumidas em 1 linha), uma seção Use Melhor (tutoriais e ferramentas
testados) e um joguinho diário chamado É IA?. Mais sobre ele num e-mail
separado, daqui a alguns dias.

O que não esperar

Não é um agregador de manchetes, nem um resumo genérico do que já saiu em
todo lugar. Uma edição pode ser sobre um lançamento de produto; outra, sobre
alguém que perdeu o emprego pra automação e foi recontratado meses depois
pagando menos. A newsletter cobre o que muda pra quem lê, não o que é só
mais um anúncio.

Nos próximos dias mando mais 3 e-mails curtos: um com as edições que mais
valeram a pena até hoje, um sobre o É IA?, e um contando por que existe um
jeito de apoiar o projeto. Sem spam, só isso, espaçado.

Até a próxima edição,
Pixel
```

---

## E-mail 2 — D+3

**Assunto (3 opções):**
1. 3 edições que valem seu tempo (antes de mais nada)
2. As edições que mais fizeram sentido pra quem lê
3. Se você só vai ler 3 edições antigas, comece por estas

**Preview text:** Escolhidas por dado, não por achismo: as 3 com mais cliques dos últimos meses.

**Corpo:**

```
Oi de novo, Pixel aqui.

Você já deve ter recebido 1 ou 2 edições normais da diar.ia.br. Antes de
seguir, separei 3 edições antigas que tiveram a maior taxa de cliques entre
quem já lê a newsletter. Não é opinião minha, é o que os números mostram
que mais interessou.

Brasil: potência em IA travada por falta de talentos
https://diar.ia.br/p/brasil-pote-ncia-em-ia-travada-por-falta-de-talentos
Por que o país tem escala e investimento, mas não tem gente formada
suficiente pra aproveitar, e o que isso custa.

4 meses usando IA criam "dívida cognitiva" no cérebro
https://diar.ia.br/p/4-meses-usando-ia-criam-di-vida-cognitiva-no-ce-rebro
Um estudo mediu o que acontece com quem terceiriza o raciocínio pro modelo
por tempo demais. O resultado incomoda. Vale terminar de ler antes de
formar opinião.

Adeus recorte manual: separando objetos sozinho
https://diar.ia.br/p/adeus-recorte-manual-ia-separa-objetos-sozinha
Uma mudança pequena e prática que economiza tempo de verdade. O tipo de
destaque que não vira manchete, mas que você acaba usando na mesma semana.

Se alguma dessas te fizer sentido, esse é o tom da diar.ia.br no dia a dia:
histórias com consequência real, não só "empresa X lança produto Y".

Pixel
```

*(As 3 edições foram escolhidas por CTR real, cliques únicos sobre
destinatários, entre posts com ≥200 destinatários, medido em
`data/beehiiv-cache/posts/`. São de dez/2025 a fev/2026; se o editor
preferir picks mais recentes ou mais alinhados à cobertura atual, é só
trocar os 3 links, o mecanismo de escolha segue o mesmo.)*

---

## E-mail 3 — D+6

**Assunto (3 opções):**
1. Você consegue diferenciar imagem real de imagem gerada?
2. O joguinho que abre toda edição da diar.ia.br
3. Teste seu olho pra imagem gerada por IA

**Preview text:** 1 imagem, 2 alternativas, e um ranking de quem mais acerta.

**Corpo:**

```
Pixel de novo.

Toda edição da diar.ia.br termina com um joguinho: o É IA? Duas imagens
lado a lado, uma real e uma gerada, e você tenta adivinhar qual é qual.

Não é só distração. É um lembrete de que a linha entre imagem real e imagem
gerada está cada vez mais difícil de ver a olho nu, e a diar.ia.br existe
justamente pra acompanhar esse tipo de mudança.

Quem acerta entra pra um ranking público de quem mais identifica imagem
gerada corretamente. Cada edição também tem um erro intencional escondido
no texto: quem encontra concorre a um sorteio mensal (a última recompensa
foi uma caneca da diar.ia.br).

Joga na próxima edição. A imagem certa fica logo no fim do e-mail, com o
link pro ranking.

Pixel
```

---

## E-mail 4 — D+10

**Assunto (3 opções):**
1. Por que a diar.ia.br pede apoio (e o que isso muda)
2. A newsletter é grátis. A curadoria tem custo.
3. Se você chegou até aqui, um pedido direto

**Preview text:** Sem paywall, sem anúncio invasivo: só um jeito opcional de sustentar o projeto.

**Corpo:**

```
Último e-mail desta série de boas-vindas. Pixel aqui, prometo ser direto.

A diar.ia.br é gratuita e sempre vai continuar sendo. Mas selecionar e
escrever uma edição todo dia útil tem custo real: tempo, ferramentas,
revisão. Quem quiser ajudar a sustentar isso pode apoiar a partir de R$5/mês
em apoia.se/diaria.

O conteúdo da newsletter é o mesmo pra todo mundo, apoiando ou não. Isso não
é assinatura premium, é apoio direto ao projeto, com algumas recompensas pra
quem contribui:

- A partir de R$10/mês: acesso ao Artigo Especial mensal, um texto mais
  longo e aprofundado, fora do ritmo diário, com acesso a todo o histórico
  publicado.
- Sorteios mensais entre quem apoia.
- Acesso antecipado a projetos novos antes de saírem pra todo mundo.

Sem letra miúda: se a diar.ia.br te poupa tempo toda semana, considera
apoiar. Se não fizer sentido agora, sem problema. Você continua recebendo a
newsletter exatamente igual.

apoia.se/diaria

Obrigado por estar aqui,
Pixel
```

---

## Itens codáveis do checklist original (#6508) — sem depender da sequence existir

- **Cadastro via API (`subscribeToKit`, `workers/poll/src/subscribe.ts`)
  não tem hoje nenhum hook de sequence.** `subscribeToKit` cria o subscriber
  via `POST /v4/subscribers` (`state: "active"` ou `"inactive"` conforme o
  flag de double opt-in do #6340) e, quando `state === "inactive"`, chama
  `vincularKitDoiForm` pra vincular o subscriber ao form de double opt-in
  (`POST /v4/forms/{form}/subscribers/{sub}`) — isso é o único vínculo
  form↔subscriber que o código já faz, e é sobre confirmação de e-mail, não
  sobre sequence.
- **Caminho recomendado, quando a sequence existir: vincular a sequence ao
  FORM `9839463` no dashboard do Kit** (mecanismo nativo do Kit — um form
  pode disparar uma sequence automaticamente pra quem se cadastra por ele),
  não via código. Isso cobre o cadastro que já passa pelo form. Não muda
  nada em `subscribe.ts`.
- **Cadastro via API direto (`subscribeToKit`) não passa pelo form**, então
  não herda esse vínculo automaticamente. Se o editor quiser que TODO
  cadastro (form + API) entre na sequence, o próximo passo — não
  implementado aqui, porque a sequence ainda não existe — é: depois de criar
  o subscriber com sucesso em `subscribeToKit`, chamar
  `POST /v4/sequences/{sequence_id}/subscribers` (equivalente ao
  `mcp__kit__add_subscriber_to_sequence` já disponível como tool) passando o
  `subscriber_id` retornado pela criação. Mesmo padrão de best-effort/fail-soft
  que `vincularKitDoiForm` já usa (nunca reverte a criação do subscriber se a
  vinculação à sequence falhar).
- **Interação com double opt-in (#6340) — só como referência, não implementado
  aqui:** quando `DOUBLE_OPT_IN_FLAG.enabledForWorkers` inclui o worker, o
  subscriber nasce `inactive` até confirmar. Se a sequence for vinculada só
  pelo form (caminho recomendado acima), o Kit por padrão só dispara a
  sequence depois da confirmação — o que é o comportamento correto (não
  faz sentido mandar boas-vindas pra quem ainda nem confirmou o e-mail). Se
  o editor optar pelo caminho via API direto no futuro, essa mesma pergunta
  (disparar antes ou depois da confirmação) precisa ser decidida
  explicitamente — não é óbvio no código hoje.

## Próximos passos (fora do escopo desta unidade — ação real na conta Kit)

1. Editor revisa e aprova (ou ajusta) o conteúdo dos 4 e-mails acima.
2. Criar a sequence no Kit (`mcp__kit__create_sequence` + `create_sequence_email`
   × 4) com o conteúdo aprovado.
3. Ligar o form `9839463` à sequence recém-criada, pelo dashboard do Kit.
4. Decidir se o cadastro via API (`subscribeToKit`) também deve entrar na
   sequence — se sim, implementar o `add_subscriber_to_sequence` descrito
   acima como unidade separada.
5. Confirmar como a sequence se comporta pra quem nasce `inactive` sob o
   flag do #6340 (double opt-in).
