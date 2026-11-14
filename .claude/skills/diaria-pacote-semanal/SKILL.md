---
name: diaria-pacote-semanal
description: Pacote semanal numa sessão só (#13022) — os dois carrosséis da retro (`/diaria-retro-semanal`, highlights no sábado e clicked no domingo), a newsletter semanal do LinkedIn (`/diaria-linkedin-semanal`, segunda) e o post do Radar de Notícias Stack (`/diaria-stack`, envio de segunda 06:00), com seleção única por clique compartilhada entre o clicked e as manchetes do LinkedIn, escrita e humanizador+Clarice numa leva, renders em paralelo e UM gate consolidado (um Artifact, uma aprovação). Depois do sim, agenda a retro, aprova a Stack e cola o LinkedIn pelo Chrome, terminando na lista do que falta à mão (capa e agendamento do LinkedIn, #8031). Execução manual entre sexta e sábado. As três skills continuam existindo como entrada isolada (retry, um produto só). Uso — `/diaria-pacote-semanal [AAMMDD-do-sabado] [--no-gates]`.
disable-model-invocation: true
---

# /diaria-pacote-semanal

Produz numa invocação os três conteúdos semanais que saem de três skills
separadas, cortando o tempo do editor: em vez de revisar 3 a 4 prévias com
um gate cada, ele revisa UM Artifact com uma seção por produto e aprova uma
vez (decisões do editor de 13/11/2026 na #13022).

**Orquestra, não funde (#4456 segue de pé).** `/diaria-retro-semanal`,
`/diaria-linkedin-semanal` e `/diaria-stack` continuam sendo os produtos e as
entradas isoladas, para retry, reagendamento ou um produto só. Esta skill
chama os MESMOS scripts, com os mesmos guards, e só muda três coisas:

1. **Uma janela, um preflight:** âncoras derivadas uma vez, `kit-sync.ts` uma
   vez, `--check-slot` da retro antes de tudo.
2. **Seleção única compartilhada** entre o carrossel clicked e as manchetes do
   LinkedIn (`scripts/weekly-shared-selection.ts`, ver "O que muda em cada
   produto").
3. **Escrita, passes e renders em leva, gate consolidado no fim.**

Quando um passo abaixo diz "como no Passo N da skill X", leia aquele passo na
`SKILL.md` da skill X e siga-o: o detalhe (formatos, recuperação de erro,
casos de borda) vive lá e não é repetido aqui.

## Argumentos

- `AAMMDD-do-sabado` — o sábado da retro. **Omitido (#5321): o próximo
  sábado** (`nextSaturdayAAMMDD()` em `scripts/lib/select-weekly-d1.ts`; se
  hoje é sábado, hoje), com o banner `AAMMDD-do-sabado não informado —
  assumindo {S} (próximo sábado). Passe explicitamente para outra data.`
  Nunca parar para confirmar a data.
- `--no-gates` — pula o gate consolidado. Agenda a retro (com a sugestão nos
  empates do clicked, via `--allow-suggested-ties`; não é idêntico ao
  automático da retro isolada, porque a diversidade de dia do #8817 agora
  decide antes do desempate editorial) e para:
  **não aprova a Stack e não cola o LinkedIn** (#13022). O resumo final
  lista os dois como pendentes.

## Âncoras (derivadas uma vez, no Passo 0)

| Âncora | Valor | Quem usa |
|---|---|---|
| `{S}` | o sábado | retro (`--saturday`), highlights publica no próprio sábado |
| `{D}` | `{S}` + 1 | dia do carrossel clicked |
| `{M}` | `{S}` + 2 (segunda) | LinkedIn (`--publish-monday`) e Stack (`--publish-monday`) |
| `{cycle}` | `{YY}w{WW}` da semana de conteúdo | `data/weekly/{cycle}/` (LinkedIn, Stack, seleção compartilhada) |

A semana de conteúdo (segunda a sexta antes de `{S}`) é a mesma para os três.
O `{cycle}` sai impresso pelo Passo 1 (`weekly-shared-selection.ts`).

## Guards (continuam valendo, não negociáveis)

- **Stack:** o envio só sai pela task de segunda 06:00 com o ciclo aprovado,
  ou com `/diaria-stack {M} --publish`, que esta skill nunca roda. A
  aprovação (`--approve`) só depois do sim do editor no gate consolidado, e
  nunca dentro de `/diaria-overnight`, `/diaria-develop` ou
  `/diaria-continuo` (guard de execução de `/diaria-stack`).
- **LinkedIn:** capa e agendamento são manuais (#8031). A skill cola,
  audita (8c) e para no Passo 9 da skill do LinkedIn.
- **Humanizador + Clarice (com `clarice-filter.ts`, #11798) só em texto
  NOVO:** resumos da retro, abertura/notas/descrição de vídeo da Stack, post
  de feed do LinkedIn. Manchetes do LinkedIn (#8818) e destaques da Stack
  (#11184) são isentos, como nas skills isoladas.
- **Retro:** nunca publica carrossel parcial, nunca passa
  `--force-incomplete-week`/`--force-incomplete-click-data` sem o editor
  confirmar (casos de borda de `/diaria-retro-semanal`).
- `AskUserQuestion` falhando = halt banner (#3938); MCP fora = halt banner
  (#738). Clarice fora na Stack = halt banner (regra de `/diaria-stack`).

## Passo 0 — Preflight (uma vez)

1. Resolver `{S}`, `{D}`, `{M}`.
   **Claude in Chrome (#13053):** conferir as ferramentas disponíveis nesta
   sessão (incluindo descoberta de ferramentas, quando houver) e registrar
   `chromeAvailable`: só é verdadeiro se o Claude in Chrome estiver
   disponível para operar o navegador. Não inferir pela máquina ou por um
   browser genérico. Se ausente (caso do `300`), avisar já: "Sem Claude in
   Chrome nesta sessão: o paste do LinkedIn ficará para o Neo; entregarei
   o prompt de handoff no fim." Continuar a produção e levar esse aviso ao
   gate. Ausência desde o preflight não é desconexão MCP (#738); se uma
   ferramenta disponível desconectar durante o uso, segue o halt normal.
2. Slot da retro (#10389), antes de tudo:
   `npx tsx scripts/publish-weekly-social.ts --saturday {S} --mode both --check-slot`.
   Exit 2 segue o Passo 0 de `/diaria-retro-semanal` (opções de `--time`,
   `--day-offset` ou pular um modo; com `--no-gates`, aplica a sugestão e
   registra a premissa). Rodando no sábado depois do horário do highlights,
   é aqui que aparece.
3. `npx tsx scripts/kit-sync.ts` (#7629), uma vez para os três.
4. Conferir `data/editions/{AAMMDD}/02-reviewed.md` das 5 edições da semana;
   as que faltarem entram no bloco de avisos do gate.
5. **Retomada.** Ler o que já saiu e pular o produto concluído, como o
   `/diaria-edicao`:
   - retro: `data/weekly/{S}/06-weekly-published.json` com
     `weekly-highlights` e `weekly-clicked` agendados nos 4 canais;
   - Stack: `data/weekly/{cycle}/_internal/circle-stack-approval.json` com o
     sha da seleção atual, ou `circle-stack-published.json`;
   - LinkedIn: `data/weekly/{cycle}/ln-{cycle}.json` com
     `published_manually`/URL (#12745). Rascunho já colado não deixa rastro
     em arquivo: se o editor disser que já colou, pule o paste.
   Texto já escrito e já passado pelo humanizador/Clarice também é
   reaproveitado: os trilhos de cada produto (`06-summaries.json` com
   `summary_clarice`, `circle-stack-copy.json` aplicado na seleção,
   `ln-feed-post-review.json`) dizem o que falta.

## Passo 1 — Seleção compartilhada

```bash
npx tsx scripts/weekly-shared-selection.ts --saturday {S}
```

Grava `data/weekly/{cycle}/_internal/shared-selection.json`: o ranking único
da semana, o recorte `clicked` (5 itens, D1/D2/D3/RADAR), o recorte `linkedin`
(até 3, só destaques, teto menor em semana curta), a idade do dado de clique
por edição e os avisos. Os empates do #5109 saem com a SUGESTÃO do desempate
editorial pré-marcada (`pending.resolution: "suggestion"`), e é ela que as
prévias mostram até o gate.

## Passo 2 — Seleção de cada produto (em paralelo)

Três chamadas independentes, na mesma leva:

- Retro, prévia dos dois modos (sem `--schedule`):
  `npx tsx scripts/publish-weekly-social.ts --saturday {S} --mode both --shared-selection {arquivo do Passo 1}`.
  O highlights ignora a flag; o clicked usa o recorte `clicked`.
- LinkedIn:
  `npx tsx scripts/select-linkedin-weekly.ts --publish-monday {M} --shared-selection {arquivo do Passo 1}`,
  depois o Passo 4 da skill do LinkedIn (`verify-linkedin-weekly-sources.ts`
  + `render-linkedin-swap-checkpoint.ts`, só informativos).
- Stack: `npx tsx scripts/publish-circle-stack.ts --publish-monday {M}`
  (Passo 1 de `/diaria-stack`; a seleção da Stack não é por clique e fica
  fora do ranking compartilhado, decisão do #10904).

## Passo 3 — Escrita em paralelo

Gerar os insumos (cada um num arquivo do scratchpad):

- `npx tsx scripts/publish-weekly-social.ts --saturday {S} --mode clicked --shared-selection {arquivo} --summary-manifest > {scratchpad}/summary-manifest-clicked.json`
- `npx tsx scripts/publish-weekly-social.ts --saturday {S} --mode highlights --summary-manifest > {scratchpad}/summary-manifest-highlights.json`
- `npx tsx scripts/circle-stack-copy.ts --publish-monday {M} --manifest > {scratchpad}/stack-manifest-{cycle}.json`

E disparar NUMA mensagem só, para rodarem juntos:

```
Agent(subagent_type="weekly-summary-writer", prompt="Manifest: {scratchpad}/summary-manifest-clicked.json")
Agent(subagent_type="weekly-summary-writer", prompt="Manifest: {scratchpad}/summary-manifest-highlights.json")
Agent(subagent_type="stack-writer", prompt="Manifest: {scratchpad}/stack-manifest-{cycle}.json")
```

Enquanto os agentes rodam, a sessão escreve o **post de feed do LinkedIn**
(Passo 8d de `/diaria-linkedin-semanal`: estrutura do #12787, título = manchete
1 literal) a partir das manchetes do `ln-selection.json`. Ele só depende das
manchetes, então sai antes do paste, não depois. Comentário do Use Melhor
continua opcional e nunca inventado (#5970): só entra se o editor oferecer.

## Passo 4 — Humanizador + Clarice numa leva

Todos os textos novos de uma vez, na ordem da diária. `{P}` = o arquivo de
resumos de cada modo, `data/weekly/{S}-{modo}/_internal/06-summaries.json`
(`{modo}` = `clicked` ou `highlights`).

1. Snapshot dos resumos (cada modo):
   `npx tsx scripts/weekly-summaries-passes.ts snapshot --path {P}`.
2. **Uma chamada do humanizador** (passe completo) cobrindo: o campo
   `summary` dos dois `06-summaries.json` (só item sem `summary_clarice`,
   teto 200 caracteres e 2 frases), `opening`/`notes[].stackNote`/
   `videoDescription` do `circle-stack-copy.json` (tetos do Passo 3 de
   `/diaria-stack`) e o texto do post de feed. Mesmas instruções de campo
   das skills isoladas: não tocar `url`, `title`, `summary_raw`, `carouselKey`, `cycle`.
   Depois: `weekly-summaries-passes.ts humanized --path {P}` (cada modo) e
   tirar todo travessão do post de feed antes da Clarice.
3. **Clarice, uma chamada por texto, em série (#4952)**, cada lista de
   sugestões filtrada por `clarice-filter.ts` antes de aplicar:
   - resumos: `weekly-summaries-passes.ts clarice --path {P} --suggestions ...`
     (Passo 2c de `/diaria-retro-semanal`);
   - Stack: aplicar as filtradas no `circle-stack-copy.json` e rodar
     `npx tsx scripts/circle-stack-copy.ts --publish-monday {M} --apply`
     (Passos 3-4 de `/diaria-stack`);
   - post de feed: gravar o texto em
     `data/weekly/{cycle}/_internal/ln-feed-post-clarice-input.txt`, filtrar
     com `--source-text` e fechar com o guard do #12794
     (`weekly-feed-post-review.ts --cycle {cycle} --mark --humanizador --clarice-filtered ...`).

## Passo 5 — Renders em paralelo (antes do gate)

Na mesma leva:

- Retro, imagens reais de cada modo (Passo 2a de `/diaria-retro-semanal`):
  `publish-weekly-social.ts --saturday {S} --mode clicked --shared-selection {arquivo} --images-only`
  e `--mode highlights --images-only`; baixar as `carouselImageUrls` para
  `{scratchpad}/pacote-{cycle}/`.
- Retro, prévia de texto final de cada modo (legendas com os resumos), sem
  `--schedule`.
- LinkedIn: `npx tsx scripts/render-linkedin-weekly.ts --cycle {cycle}`
  (Passo 7 da skill do LinkedIn; copiar a capa e a imagem do vídeo para o
  scratchpad, #12788).
- Stack: `npx tsx scripts/publish-circle-stack.ts --publish-monday {M}` e
  `npx tsx scripts/publish-circle-stack-email-kit.ts --publish-monday {M}`
  (Passo 5 de `/diaria-stack`; o HTML sai em
  `data/weekly/{cycle}/_internal/circle-stack-preview.html`).

## Passo 6 — Gate consolidado (pulado com `--no-gates`)

**Um Artifact só**, montado em `{scratchpad}/pacote-{cycle}/index.html`
(imagens e HTMLs de apoio copiados para a mesma pasta e publicados em
`files`; nada de `data/` direto, #12788). Título "Pacote semanal {cycle}".

1. **Bloco de avisos no topo**, juntando os de todos os scripts: avisos do
   `shared-selection.json` (empates pendentes com a sugestão, trocas que não
   se aplicaram a um produto, edição sem dado de clique), a **tabela de
   idade do dado de clique por edição** com as edições de menos de 48 h
   (tipicamente a sexta) marcadas como imaturas
   (premissa abaixo), avisos da retro (empate, semana curta, resumo faltando,
   linguagem comercial, item sem imagem), do `ln-{cycle}.json` (capa
   ausente, trocas #5538, Use Melhor sem comentário) e os `⚠` da Stack.
   Se `chromeAvailable: false`, incluir explicitamente: "Paste e auditoria
   do LinkedIn pendentes para outra máquina (Neo); aprovar este pacote não
   cola o artigo. O prompt de handoff será entregue no Passo 8."
2. **Uma seção por produto, no formato final:**
   - carrossel highlights (slides reais, legendas dos 4 canais, horário de `{S}`);
   - carrossel clicked (slides, legendas, horário de `{D}`, taxa de cada item);
   - artigo do LinkedIn renderizado (como o Passo 7b da skill do LinkedIn,
     com a nota do mecanismo de colagem) + o post de feed final;
   - post da Stack (o `circle-stack-preview.html` como página de apoio,
     embutida e linkada) com o estado do ciclo.
3. **O ranking compartilhado** (título, edição, taxa, onde cada item entrou)
   para o editor trocar um item sem abrir arquivo.

Apresentar o link e fazer UMA pergunta (`AskUserQuestion`): aprovar tudo
(recomendado), pedir ajuste (com o que mudar) ou abortar.

**Ajuste volta só para o produto afetado**, e o Artifact é republicado no
mesmo endereço:
- trocar item do clicked ou do LinkedIn:
  `npx tsx scripts/weekly-shared-selection.ts --saturday {S} --swap {url que sai} --with {url que entra}`.
  A troca vale nos dois produtos quando o item novo é elegível nos dois
  (destaque) e só no clicked quando ele é RADAR; o script avisa onde não
  aplicou e marca os produtos com troca do gate (`manual: true`). Troca que
  mexe num item do empate pendente é recusada: resolva o empate antes com
  `--pick`.
  Depois, refazer só o que mudou: seleção + render do LinkedIn, resumo do
  item novo no clicked (`weekly-summary-writer` via SendMessage ou de novo,
  e os passes só nesse item), post de feed se a manchete mudou;
- escolher o empate de outro jeito:
  `weekly-shared-selection.ts --saturday {S} --pick clicked|linkedin --urls u1,u2`;
- texto (resumo, nota da Stack, post de feed): editar e repassar só aquele
  texto pelo humanizador/Clarice, com os guards de cada skill;
- Use Melhor do LinkedIn (#11777): `select-linkedin-weekly.ts ... --use-melhor-url`.

## Passo 7 — Pós-gate (sem nova pergunta)

Com o "aprovar":

1. **Gravar a aprovação, sempre (com ou sem empate):**
   `npx tsx scripts/weekly-shared-selection.ts --saturday {S} --confirm-suggestions`.
   Ele refaz a seleção com o cache de agora e as decisões gravadas e confere
   que ela é a mesma que o gate mostrou; grava as sugestões aceitas como
   escolha exata e o hash da seleção aprovada. **Exit ≠ 0 aqui para tudo**:
   nada de agendar, aprovar ou colar. Exit 2 = a seleção mudou depois do gate
   (kit-sync ou edição nova que mexeu nos itens): re-rodar o Passo 1 e levar
   a seleção nova ao gate. Com exit 0, re-rodar
   `select-linkedin-weekly.ts --shared-selection` + render, para o
   `ln-selection.json` sair sem `pendingGroup`.
2. Só depois do item 1 ok, em paralelo:
   - retro: `publish-weekly-social.ts --saturday {S} --mode both --shared-selection {arquivo} --schedule`
     (Passo 4 de `/diaria-retro-semanal`; recusa com exit 2 se o replay da
     seleção com o cache de agora der outra seleção, se as URLs não baterem
     com o hash da aprovação, ou se o empate do clicked ainda for só
     sugestão; taxa que mudou sem mexer na seleção, como a sexta ainda
     acumulando clique, é só aviso) e
     o registro do horário de cada dia, como no cabeçalho "Horário durante o
     teste rotativo" de `/diaria-retro-semanal`:
     `social-schedule-rotation.ts --record --date {S} --kind weekend` e o
     mesmo com `--date {D}`;
   - Stack: `npx tsx scripts/publish-circle-stack-scheduled.ts --approve --publish-monday {M}`
     (Passo 6 de `/diaria-stack`; com `scheduledRunPast: true`, não aprovar e
     dizer que o ciclo só sai com `/diaria-stack {M} --publish`).
3. Se `chromeAvailable: false`, não tentar o paste: marcar LinkedIn como
   pendente e gerar o handoff no Passo 8, sem nova pergunta.
   Se `chromeAvailable: true`, LinkedIn pelo Chrome: Passos 8a a 8c de `/diaria-linkedin-semanal`
   (abrir pela página da newsletter, colar com o sentinela, auditar com
   `auditLinkedinPaste`; `ok: false` para e envolve o editor, máximo 2
   tentativas de correção). Em ambos os casos, antes de entregar o post de feed:
   `weekly-feed-post-review.ts --cycle {cycle} --check`.

Com `--no-gates`: sem o item 1 (ninguém aprovou nada); só a retro do item
2, com `--allow-suggested-ties` no `--schedule` (o único lugar onde essa
flag é usada). Stack não é aprovada e o LinkedIn não é colado.

## Passo 8 — Lista única ao editor (Passo 9 do LinkedIn)

A skill termina aqui, com uma lista só:

- **Feito:** retro agendada (horário de cada modo e canais), Stack aprovada
  para segunda 06:00 (ou o motivo de não estar), artigo do LinkedIn colado e
  auditado no rascunho **somente se executado com auditoria aceita**, link do Artifact.
- **Falta à mão (#8031):** capa do LinkedIn (`data/weekly/{cycle}/04-d1-2x1.jpg`
  e, havendo vídeo, a imagem dele), o post de feed pronto para colar, o
  horário de `social-schedule-rotation.ts --linkedin-article --date {M}`,
  o ajuste manual da âncora da menção (#10385) quando houver, e o
  `--record ... --kind linkedin_article` depois de agendar. Itens que
  `--no-gates` deixou pendentes (aprovação da Stack, paste do LinkedIn)
  entram aqui também.

### Handoff automático para o Neo sem Chrome (#13053)

Se o paste estiver pendente e `chromeAvailable: false`, entregar SEM o
editor precisar pedir um **prompt pronto para colar numa sessão do Neo**.
Gravar também em `data/weekly/{cycle}/_internal/ln-chrome-handoff.txt`.
Expandir `{cycle}`, `{M}`, todos os caminhos e o título com os valores
reais do ciclo; não entregar placeholders. Ler o título literal de
`headlines[0].title` em `_internal/ln-selection.json`. Usar este modelo:

```text
Retome apenas o paste do artigo do LinkedIn do pacote semanal {cycle}.
Leia CLAUDE.md e os Passos 8a-8c e 9 de /diaria-linkedin-semanal,
bem como context/publishers/linkedin.md. Não re-renderizar, não refazer
seleção/escrita/passes e não agendar a retro nem aprovar a Stack de novo.
HTML final: I:\Meu Drive\diaria-studio-data\weekly\{cycle}\ln-{cycle}.html
Seleção: I:\Meu Drive\diaria-studio-data\weekly\{cycle}\_internal\ln-selection.json
Metadados: I:\Meu Drive\diaria-studio-data\weekly\{cycle}\ln-{cycle}.json
Capa: I:\Meu Drive\diaria-studio-data\weekly\{cycle}\04-d1-2x1.jpg
Título do artigo (literal): {headlines[0].title}
Confirme os arquivos sincronizados; se faltarem, pare e informe, sem gerar outros.
8a: abra pela página DA newsletter e confirme o destino no cabeçalho.
Confira se já há corpo colado antes de qualquer paste, para não duplicar.
8b: use o HTML final via ClipboardEvent com o sentinela <p>&nbsp;</p>.
Espere estabilizar. Retorno [BLOCKED] não autoriza colar de novo.
8c: extraia âncoras (texto, base e utm_content, sem href cru) e tamanho do
texto; chame auditLinkedinPaste de scripts/lib/linkedin-paste-audit.ts
contra o HTML fonte sem sentinela. Confira TODAS as âncoras e UTMs,
inclusive a menção diar.ia.br (#10385, #13049), sem presumir que o paste
preservou os links. Só WORDMARK_HREF_REWRITE_HINT em mencao-abertura pode
seguir como ajuste manual documentado; outros erros param a entrega,
com no máximo 2 tentativas de correção conforme 8c. Não declarar auditado
sem executar a auditoria. Preencha o título diretamente no campo.
Pare no Passo 9: capa, imagem de vídeo quando houver e agendamento são
manuais (#8031). Entregue o resultado da auditoria e o ajuste da menção,
com a URL original completa/UTM para o editor conferir após salvar.
```

Incluir no prompt também o caminho Windows de `videoImagePath`, se houver
nos metadados (normalmente `video-04-d1-2x1.jpg`), e o post de feed já
revisado, após o `weekly-feed-post-review.ts --cycle {cycle} --check`.
Com `--no-gates`, explicitar que o pacote **não foi aprovado** e que o
prompt só pode executar o paste depois da aprovação do editor; entregar
handoff não autoriza a colagem. Em retomada com artigo já colado/publicado,
não gerar instrução para repetir o paste.

## O que muda em cada produto

**Ranking compartilhado** (`scripts/lib/weekly-shared-ranking.ts`):

- **Métrica:** a taxa de clique verificado que as duas skills já usavam,
  `(cliques verificados + cliques web) / aberturas únicas` da edição de
  origem, com a mesma exclusão comercial/própria. Nenhum número muda.
- **Regra de empate:** a do LinkedIn, para os dois recortes. Fora da banda
  de 1 clique a taxa decide; banda que cabe nas vagas entra inteira; banda
  maior que as vagas é decidida pela diversidade de dia quando cabe exato
  (#8817) e, se não couber, vai ao editor (#5109) com a sugestão do desempate
  editorial pré-marcada.
- **Retro clicked:** o empate maior que as vagas deixa de ser resolvido
  sozinho pelo desempate editorial (ângulo Brasil > implicação profissional >
  categoria, com a preferência do #10378); esse critério vira a sugestão que
  o editor confirma no gate. A diversidade de dia (#8817) passa a valer antes
  dele. A intro "mais lidas" só muda para a neutra quando há troca no gate.
- **LinkedIn:** a regra não muda. Muda a origem: as manchetes vêm do ranking
  compartilhado, e uma troca de destaque feita para o clicked vale aqui
  também.
- **Stack:** nada muda; a seleção dela não é por clique.
- **Skills isoladas:** sem `--shared-selection`, `publish-weekly-social.ts` e
  `select-linkedin-weekly.ts` seguem com a seleção própria de sempre.

## Premissa: cliques de sexta imaturos (#13022)

O pacote roda entre sexta e sábado, e a edição de sexta tem poucas horas de
clique. **Default adotado: aceitar e avisar no gate.** O ranking não
normaliza por idade nem exclui a sexta; o `shared-selection.json` traz a
idade do dado de clique por edição (`clickAge`), e as edições com menos de
48 horas (tipicamente a sexta) aparecem marcadas como imaturas no topo do
gate. O editor pode mudar essa
premissa depois (normalizar por idade ou tirar a sexta do ranking por
clique); a mudança mora em `weekly-shared-ranking.ts`.

## Casos de borda

- **Um produto falhou e os outros não:** siga com os outros e liste a falha
  no Passo 8; o retry é a skill isolada daquele produto.
- **`kit-sync` rodou depois:** se a seleção não mudou, os scripts seguem e
  só avisam a taxa nova. Se mudou, o script da seleção, o `--schedule` da
  retro e o `select-linkedin-weekly.ts --shared-selection` saem com exit 2:
  re-rodar o Passo 1 e voltar ao gate. Troca ou escolha gravada que deixou
  de valer também dá exit 2 (nada gravado); `--reset-overrides` recomeça do
  automático.
- **Troca de item empatado:** com o empate ainda só sugerido, a troca é
  recusada (resolva com `--pick` ou `--confirm-suggestions` antes); com o
  empate já decidido, a troca vale e o empate daquele produto sai do
  arquivo (a lista final é escolha do editor).
- **Semana curta:** o LinkedIn reduz as manchetes sozinho
  (`computeHeadlineCap`); a retro aborta abaixo de 4 itens e só segue com
  `--force-incomplete-week` confirmado pelo editor.
- **Sem nenhuma edição na janela:** `weekly-shared-selection.ts` sai com
  exit 1; reportar e parar.
