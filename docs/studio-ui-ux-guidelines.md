# Studio UI — guidelines de UX para dashboards/admin UI

Issue: [#3866](https://github.com/vjpixel/diaria-studio/issues/3866) (parte do epic [#3554](https://github.com/vjpixel/diaria-studio/issues/3554))

## Nota de escopo — auditoria retrofit, não pré-V1

A issue original pedia essa revisão **antes/durante** o V1 (#3555–#3559), pra
evitar retrofit. Na prática, quando esta sessão rodou, o V1 inteiro — #3555,
#3556, #3557, #3558, #3559 **e #3560** (acesso remoto, fora do range
original) — já estava fechado e implementado. Este documento é, portanto,
uma **auditoria retrofit**: as regras abaixo foram derivadas cruzando (a)
pesquisa web de práticas de UX para dashboards/admin UI e (b) leitura direta
do código já em produção — os 2 dashboards embutidos
(`scripts/studio-ui/dashboard-diaria.ts`, `dashboard-clarice.ts`, que reusam
os renderers dos Workers `workers/diaria-dashboard/`,
`workers/brevo-dashboard/`), a aba "É IA?" (dados do `workers/poll/`
embutidos como seção do dashboard diária, não um painel à parte), e as 8
páginas do Studio propriamente dito (`scripts/studio-ui/public/*.html`, ver
`nav-core.js` `NAV_ITEMS` pra lista canônica: Home, Rodada, Triagem, Revisão,
Apoios, Relatórios, Integrações + o cockpit `/edicao/:aammdd`).

Cada regra abaixo é **acionável** (aplica a uma decisão real de código/design
neste repo) e marcada com o estado atual: `✅ conforme` (já implementado
corretamente em algum lugar — citado como referência a replicar),
`⚠️ gap conhecido` (desvio real mas pequeno/baixo-risco, sem issue própria —
ver §Gaps conhecidos), ou `🔴 issue aberta` (desvio concreto que virou issue
de follow-up — ver §Issues de follow-up).

---

## Índice de regras

1. [Statusbar sempre responde "o que mudou" em <5s](#1-statusbar-sempre-responde-o-que-mudou-em-5s)
2. [Todo processo longo mostra idade do último evento, não só o rótulo do estágio](#2-todo-processo-longo-mostra-idade-do-último-evento-não-só-o-rótulo-do-estágio)
3. [Estado vazio sempre com o comando/link que resolve](#3-estado-vazio-sempre-com-o-comandolink-que-resolve)
4. [Erro nunca é beco sem saída](#4-erro-nunca-é-beco-sem-saída)
5. [Falha parcial preserva o último dado bom (stale-while-error)](#5-falha-parcial-preserva-o-último-dado-bom-stale-while-error)
6. [Botão de ação descreve efeito + blast radius, nunca "OK"](#6-botão-de-ação-descreve-efeito--blast-radius-nunca-ok)
7. [Nunca UI otimista em publicação/agendamento](#7-nunca-ui-otimista-em-publicaçãoagendamento)
8. [Camadas de progressive disclosure são o contrato, não um acidente](#8-camadas-de-progressive-disclosure-são-o-contrato-não-um-acidente)
9. [Alvo de toque ≥24px sempre, ≥44px em controle primário](#9-alvo-de-toque-24px-sempre-44px-em-controle-primário)
10. [Widget ARIA custom implementa o contrato INTEIRO ou não usa o role](#10-widget-aria-custom-implementa-o-contrato-inteiro-ou-não-usa-o-role)
11. [CSS-only vs JS-driven tabs: escolha consciente, mesmo checklist de saída](#11-css-only-vs-js-driven-tabs-escolha-consciente-mesmo-checklist-de-saída)
12. [Status nunca é só cor](#12-status-nunca-é-só-cor)
13. [Foco visível nunca suprimido sem substituto](#13-foco-visível-nunca-suprimido-sem-substituto)
14. [Dark mode é responsabilidade do design system, não de cada página](#14-dark-mode-é-responsabilidade-do-design-system-não-de-cada-página)
15. [Conector de conexão (SSE) em toda página com dado ao vivo](#15-conector-de-conexão-sse-em-toda-página-com-dado-ao-vivo)
16. [Notificação: badge (in-page) < push externo, nunca toast por evento de baixo valor](#16-notificação-badge-in-page--push-externo-nunca-toast-por-evento-de-baixo-valor)
17. [Dataviz nova consome os tokens gerados, nunca hex solto](#17-dataviz-nova-consome-os-tokens-gerados-nunca-hex-solto)

---

## 1. Statusbar sempre responde "o que mudou" em <5s

**Regra:** toda página do Studio carrega um `<header class="statusbar">` fixo
(`position: sticky; top: 0`) cuja primeira leitura, sem scroll, responde:
edição corrente? stage atual? quantos gates pendentes? conectado ou não?
Nunca enterrar esse resumo dentro de uma aba ou abaixo da dobra.

**Onde já é assim:** `index.html`/`app.js` (Edição · Stage · Gates ·
Overnight · conexão), `edicao.html`/`edicao.js` (Edição · Stage · conexão),
`rodada.html`, `triagem.html`, `integracoes.html` — todas seguem o mesmo
padrão de statusbar com valores em `<span class="value">`. ✅ conforme.

**Ao adicionar página nova:** reusar a mesma estrutura de `.statusbar` +
`.statusbar-item` (`style.css`) em vez de inventar um header próprio — é o
que torna a resposta em <5s previsível para quem já usa outra página do
Studio.

## 2. Todo processo longo mostra idade do último evento, não só o rótulo do estágio

**Regra (lição #2379):** rodando vs. travado são visualmente indistinguíveis
se a UI só mostra "Stage 4 — em andamento" sem timestamp do último sinal de
vida. Qualquer estado "em andamento"/"current" precisa expor **há quanto
tempo** desde o último evento relevante (log-line, mudança de arquivo,
heartbeat) — não só o nome do estágio.

**Onde já é assim:** o espelho remoto `renderStudioSnapshotHtml`
(`workers/diaria-dashboard/src/index.ts`) aplica isso taxativamente — calcula
`ageMinutes` a partir de `generated_at` e escala pra um banner amarelo "⚠
Dados de HH:MM (há Nmin) — PC offline?" quando ultrapassa
`STUDIO_SNAPSHOT_STALE_MINUTES` (10min). Esse é o padrão de referência: idade
numérica + banner de suspeita, não um dot verde/vermelho binário. ✅
conforme (nessa view específica).

**Gap:** o cockpit local `/edicao/:aammdd` (`edicao.js` `renderTimeline`) usa
exatamente o mesmo vocabulário visual (`status-${status}`, classe `current`)
mas **sem** o cálculo de idade — um stage "current" às 14h e ainda "current"
às 17h renderiza de forma idêntica. Esse é o cenário mais comum de "travou e
ninguém percebeu" porque é a MESMA máquina, mesma sessão do Studio — não
precisa de um snapshot remoto pra saber, só precisa olhar a hora do último
evento do buffer de log que a página já tem em memória (`logBuffer`). 🔴
issue aberta — ver §Issues de follow-up (#1).

## 3. Estado vazio sempre com o comando/link que resolve

**Regra:** nenhuma seção pode renderizar "sem dados" sem dizer o que rodar
ou clicar pra ter dados. Texto solto tipo "Nenhuma fonte encontrada." é
insuficiente — precisa do comando exato ou de um link.

**Onde já é assim (referência a replicar):** toda `render*Section` de
`workers/diaria-dashboard/src/index.ts` segue esse padrão à risca —
`renderSourceHealthSection` ("Rode `build-diaria-dashboard-data.ts
--dry-run` e verifique `data/source-health.json`"), `renderCtrSection`
("Rode `npm run build-link-ctr`"), `renderPollEiaSection` (2 comandos em
sequência, na ordem certa). Mesmo padrão em `triagem.js`/`rodada.js`
(`round-empty`: "Nenhuma sessão encontrada em `{dir}`" — o diretório exato
onde procurar). ✅ conforme, e é o nível de especificidade a manter em
qualquer seção nova.

## 4. Erro nunca é beco sem saída

**Regra:** toda tela de erro de página inteira precisa de pelo menos 1 ação:
link de volta, botão de retry, ou instrução copy-pasteável. Nunca só uma
frase e mais nada.

**Estado atual:** parcialmente conforme. `triagem.js` é o melhor exemplo —
em falha do `gh`, mostra o **último snapshot bom em cache** com um banner
explicando a falha (`"gh falhou nesta tentativa (mostrando o último snapshot
bom)"`), nunca uma tela em branco. Mas as páginas de erro full-page de
`dashboard-clarice.ts` (`rateLimitedHtml`, `errorHtml`, `notConfiguredHtml`)
e o "Dashboard não inicializado" do fetch handler de
`workers/diaria-dashboard/src/index.ts` são texto puro, sem link de volta
pro Studio nem botão de retry — o usuário precisa saber usar o botão
"voltar" do browser. ⚠️ gap conhecido (ver §Gaps conhecidos — baixo esforço,
não abriu issue própria).

## 5. Falha parcial preserva o último dado bom (stale-while-error)

**Regra:** quando uma fonte de dado falha (rate limit, API fora, arquivo
ausente), preferir mostrar o último dado válido conhecido + um aviso de
staleness, a substituir a tela inteira por um erro. Vale tanto pra dado
fresco-mas-atrasado quanto pra erro de rede.

**Onde já é assim:** `triagem.js` (cache + banner, ver regra 4);
`dashboard-clarice.ts` (`buildClariceDashboardHtml`, cache de página de 5min
em memória — protege contra o rate-limit HORÁRIO da Brevo, lição já
registrada no CLAUDE.md/memória: "investigação manual em loop já quebrou o
clarice-dashboard remoto"); os workers de dashboard (`diaria-dashboard`,
`brevo-dashboard`) usam `Cache-Control: private, max-age=300` + `?fresh=1`
pra bypass explícito. ✅ conforme — o padrão já é consistente nas 3
superfícies que buscam dado externo.

## 6. Botão de ação descreve efeito + blast radius, nunca "OK"

**Regra (aplicação de UI do princípio já em CLAUDE.md — Etapa 5/6):** texto
de botão nomeia o efeito concreto e, quando relevante, o horário/alvo real —
"Agendar para 06:00 BRT", nunca "Confirmar" ou "OK". Fricção (confirmação
extra, campo de digitação) proporcional ao blast radius: uma ação que
publica/agenda em canal externo (Beehiiv/LinkedIn/Facebook) merece mais
fricção que uma que só salva um arquivo local.

**Estado atual:** o Studio hoje **não tem** nenhum botão que dispare
publicação/agendamento real — Stage 5/6 continuam disparados só via terminal
ou chat (`/diaria-5-publicacao`, `/diaria-6-agendamento`); os botões que
existem hoje na UI (`revisao.html`: "Salvar", "Ver diff vs. original",
"Rodar lints", "Usar versão atual como base"; `apoios.js`: ações de
apoio/contato) são de baixo blast radius (edição local de arquivo, leitura),
o que já é adequado pro rótulo genérico atual. **Esta regra é
forward-looking**: quando #3702/#3720 (studio-server disparando subagentes
via Agent SDK — "disparar onda") ou uma futura ação de publish/schedule
chegar à UI, o texto do botão e a fricção devem seguir este padrão desde o
primeiro commit, não como retrofit. Sem issue própria — é um critério de
aceite a aplicar quando #3702 avançar.

## 7. Nunca UI otimista em publicação/agendamento

**Regra (lição #573):** qualquer elemento de UI que afirme "publicado" /
"agendado" / "enviado" precisa validar contra uma fonte determinística
(estado real da API — `resolveBeehiivState`/`resolveLinkedInState`/
`resolveFacebookState` de `scripts/lib/publish-state.ts`), nunca refletir só
a resposta imediata de uma chamada ou o rótulo cru de um agente. O caso
canônico do incidente 2026-05-05 (orchestrator afirmou "3 edições
publicadas" com uma delas na verdade 16h no futuro) se aplica IGUALMENTE a
qualquer badge/texto que o Studio vier a desenhar sobre esse mesmo dado.

**Estado atual:** ✅ conforme por ausência de violação — o Studio hoje não
renderiza nenhum estado de publish/schedule vindo de Beehiiv/LinkedIn/
Facebook (o `_internal/05-published.json`/`_internal/06-social-published.json`
não são consumidos por nenhuma página ainda). Regra registrada aqui como
guard-rail preventivo: se uma página futura passar a exibir esse dado
(candidato natural: um card de "Publicação" no cockpit `/edicao`), ela DEVE
rodar o mesmo helper de `publish-state.ts` no lado servidor antes de
renderizar o rótulo — nunca `status === "confirmed"` cru.

## 8. Camadas de progressive disclosure são o contrato, não um acidente

**Regra:** resumo → detalhe → raw → chat, cada camada mais barata de
carregar e mais rica em contexto que a anterior; nenhuma camada pula direto
pra "raw" sem passar pelo resumo.

**Onde já é assim:** a cadeia real do Studio já segue essa hierarquia:
Home (`/`, resumo global) → cockpit (`/edicao/:aammdd`, timeline + gates de
UMA edição) → revisão de conteúdo (`/revisao/:aammdd`, raw Markdown/HTML com
diff e lint) → chat drawer (livre, qualquer pergunta/ação, presente em TODA
página via `chat-drawer.js`). Cada dashboard interno replica a mesma ideia
em miniatura via abas (Visão geral primeiro, dado cru mais fundo). ✅
conforme — usar esta cadeia como modelo ao decidir onde uma feature nova
entra (raramente deveria pular direto pro chat).

## 9. Alvo de toque ≥24px sempre, ≥44px em controle primário

**Regra (WCAG 2.2 SC 2.5.8 Target Size Minimum, nível AA, exige 24×24px CSS
mínimo com exceção de espaçamento; 44×44px é o nível AAA/melhor prática
recomendada para controles primários):** todo elemento clicável/tocável no
Studio — o Studio é acessado por Cloudflare Tunnel inclusive no celular,
`docs/studio-ui-remote-setup.md` — precisa de no mínimo 24px de área de
toque, com os controles primários dos fluxos de decisão (gates 4/6, "Salvar"
no editor de revisão) mirando 44px.

**Estado atual:** `nav.css` — `.app-nav-item` não define `padding`/
`min-height` própria (herda só o `line-height`/`font-size: 0.85rem` do texto,
o que resulta em área de toque bem abaixo de 24px verticalmente) e
`.app-nav-toggle` (`padding: 0.25rem 0.6rem` ≈ 4px+9.6px em fonte 0.8rem) fica
perto de 24×24px mas não claramente acima. Esse é o único menu de navegação
GLOBAL do Studio (aparece em toda página) — um alvo pequeno demais aqui
penaliza toda sessão mobile, não uma página isolada. 🔴 issue aberta — ver
§Issues de follow-up (#2).

## 10. Widget ARIA custom implementa o contrato INTEIRO ou não usa o role

**Regra (lição #2622 + WAI-ARIA Authoring Practices, padrão Tabs):** usar
`role="tab"`/`role="tablist"` só é seguro se TODO o contrato do padrão for
implementado — `aria-selected` atualizado ao trocar de aba, `tabindex="0"`
só na aba ativa (`-1"` nas demais), navegação por seta esquerda/direita
movendo o foco entre abas, `Home`/`End` pulando pra primeira/última. Um
`role="tab"` sem esse comportamento é **pior** que não usar role nenhum —
anuncia pra leitor de tela um widget que não se comporta como anunciado.

**Onde já é assim:** as abas CSS-only dos 2 dashboards embutidos
(`workers/diaria-dashboard/src/index.ts`, `workers/brevo-dashboard/src/
sections-core.ts`) implementam o padrão via radio+label — o script inline
de progressive enhancement sincroniza `aria-selected` a cada `change` do
radio (`function syncAria()`), o radio widget nativo já dá navegação por
seta/Home/End "de graça" (é um radiogroup HTML puro), e o hash da URL
sincroniza com a aba ativa (deep-link, #2622). ✅ conforme.

**Gap:** as abas JS-driven de `revisao.js` (`.rv-tabs`, `role="tablist"` +
botões `role="tab"`) e `rodada.js` (`.round-kind-tabs`, mesmo `role=
"tablist"`) só alternam uma classe `.active` via `click` — nunca escrevem
`aria-selected`, nunca implementam seta/Home/End, e todos os botões ficam no
mesmo `tabindex` implícito (todos tabuláveis, contra o padrão "só o ativo").
É a MESMA lição de #2622 regredindo numa superfície mais nova (#3558/#3559
vieram depois do dashboard). 🔴 issue aberta — ver §Issues de follow-up (#3).

## 11. CSS-only vs JS-driven tabs: escolha consciente, mesmo checklist de saída

**Regra:** o repo tem 2 implementações de abas coexistindo de propósito —
CSS-only (dashboards, sem framework, ganha deep-link e Ctrl+F de graça
porque todos os painéis existem no DOM o tempo todo) e JS-driven
(`revisao.js`/`rodada.js`, mais fácil de combinar com lógica de estado
already-in-JS como "qual arquivo está carregado"). Ambas são escolhas
válidas — a regra não é "use sempre X", é: **qualquer nova aba, dos dois
tipos, sai da PR com o checklist da regra 10 verificado** (aria-selected,
tabindex roving, teclado), não só o resultado visual.

**Trade-off documentado (#2622), pra decidir qual usar numa feature nova:**
CSS-only ganha Ctrl+F/deep-link/foco nativo de graça mas exige que TODO
painel esteja sempre no DOM (custo de payload se o conteúdo for pesado);
JS-driven é mais barato quando o conteúdo de cada aba é caro de montar (ex:
`revisao.js` só carrega o arquivo quando a aba é clicada) mas exige
implementar manualmente o que o CSS-only ganha de graça. Nenhuma das duas é
estritamente melhor — ver regra 10 para o gap concreto de hoje.

## 12. Status nunca é só cor

**Regra (WCAG 1.4.1 Use of Color):** todo indicador de status (verde/
amarelo/vermelho, ok/erro) precisa de um segundo canal — glifo, texto, ou
`aria-label` — além da cor, porque cor sozinha falha pra usuários com
daltonismo e é invisível pra leitor de tela.

**Onde já é assim:** `statusBadge()` em `workers/diaria-dashboard/src/
index.ts` é a referência canônica — glifo diferente por status (`●` cheio /
`◐` meio / `○` vazio) + `role="img" aria-label="verde|amarelo|vermelho"`,
com o comentário inline já documentando por que `title=` sozinho não basta
(não é anunciado de forma confiável, e não existe em touch). Mesmo padrão
no semáforo 🟢/🟡 do `brevo-dashboard`. ✅ conforme — replicar
`statusBadge()` (ou extrair pra `scripts/lib/shared/` se um 3º consumidor
aparecer) em vez de reinventar o esquema de cor em um card novo.

**Atenção ao introduzir status novo no Studio (não-dashboard):** o `.dot`
genérico de `style.css` (`ok`/`down`, verde/cinza/vermelho) hoje é só cor —
aceitável porque acompanha sempre um `<span id="conn-label">` textual
adjacente ("conectado"/"desconectado"/"conectando…"), então já cumpre a
regra via o texto irmão, não o dot isolado. Preservar esse par ao copiar o
padrão.

## 13. Foco visível nunca suprimido sem substituto

**Regra:** nunca `outline: none`/`outline: 0` num elemento focável sem
fornecer um substituto visível equivalente (o padrão do próprio DS é
`outline: 2px dashed var(--brand); outline-offset: 2px`, já usado em
`edicao.css`/`style.css` pros gates pendentes).

**Estado atual:** ✅ conforme por ausência de violação — grep confirma zero
ocorrências de `outline: none`/`outline: 0` em qualquer CSS de
`scripts/studio-ui/public/`. O foco visível de botões/links/tabs no Studio
hoje é 100% o anel nativo do browser (nunca suprimido). Regra registrada
como guard-rail: ao estilizar um componente novo com aparência muito
customizada (ex: um botão redondo, um card clicável), resistir o impulso de
"limpar" o outline nativo sem repor algo equivalente.

## 14. Dark mode é responsabilidade do design system, não de cada página

**Regra:** se o dark mode for adotado, ele vive nos tokens
(`scripts/lib/shared/design-tokens.ts` + `tokens-css.ts`), nunca em overrides
locais por página — o mesmo princípio que já rege o resto do DS ("paleta
editorial reduzida a 4 cores-base").

**Estado atual:** `design-tokens.ts` hoje é **single-palette absoluto** —
não existe um único token dark em lugar nenhum da definição canônica. A
ÚNICA superfície do repo com algum tratamento de `prefers-color-scheme` é o
renderer de e-mail (`scripts/lib/shared/newsletter-styles.ts`,
`darkCanvasMediaRule` — e mesmo ali, por decisão editorial deliberada
(#2645/#3104), o escurecimento cobre só o CANVAS externo ao card, não o
conteúdo, porque inverter cores dos boxes internos arriscava contraste
quebrado sem revisão página a página). Todo o resto — as 8 páginas do
Studio, os 2 dashboards embutidos, a aba É IA?, os workers `livros`/`cursos`
— é fixo no palette claro (`--paper: #FBFAF6`, `--ink: #171411`), com ZERO
`@media (prefers-color-scheme: dark)` em qualquer um dos CSS do Studio
(`style.css`, `nav.css`, `edicao.css`, `revisao.css`, `rodada.css`,
`triagem.css`, `apoios.css`, `integracoes.css`, `chat-drawer.css`). Isso
contradiz o próprio uso mobile do Studio (à noite, longe do desktop —
justamente o cenário que justificou o acesso remoto do #3560) e o padrão que
a organização já cobra de si mesma em outras superfícies com tema
adaptativo. 🔴 issue aberta — ver §Issues de follow-up (#4).

## 15. Conector de conexão (SSE) em toda página com dado ao vivo

**Regra:** toda página que consome `/api/events` (SSE) mostra um indicador
de conexão explícito — ok/conectando/desconectado — nunca assume
silenciosamente que o stream está vivo.

**Onde já é assim:** `.dot`/`#conn-label` em `index.html`, `edicao.html`,
`revisao.html`, `rodada.html`, `triagem.html`, `integracoes.html` — todas
reusam a mesma função `setConn(status)` (replicada por módulo, mesmo
contrato). ✅ conforme, e é o padrão a reusar (ou extrair pra um módulo
compartilhado, já que a função é idêntica byte-a-byte em pelo menos 3
arquivos — oportunidade de simplificação, não um bug de UX).

## 16. Notificação: badge (in-page) < push externo, nunca toast por evento de baixo valor

**Regra (lição #3564):** hierarquia de notificação em 2 níveis apenas —
badge silencioso pra "algo mudou, veja quando quiser" (contagem, sem
interromper) e push externo (Telegram) só pra "está esperando por você"
(gate 4/6 pendente, `AskUserQuestion` pendente, turno de chat concluído) —
com dedup por chave (`NotifiedStore`) pra não re-notificar o mesmo evento
enquanto ele seguir pendente. Nunca adicionar uma 3ª camada (toast in-page)
pra eventos de baixo valor — isso é o gatilho clássico de fadiga de
notificação.

**Onde já é assim:** `chat-drawer.js` (`setPendingBadge`, contagem no rail do
drawer) + `studio-telegram-notify.ts` (dedup em memória, só remove a chave
quando o gate original deixa de estar pendente, só marca dedup em envio
`ok:true` pra não "esquecer" um pendente por falha de rede). ✅ conforme —
zero toasts in-page em todo `scripts/studio-ui/public/*.js` hoje; manter
essa disciplina ao adicionar qualquer feedback novo (preferir texto de
status inline — como `rv-save-status` em `revisao.js` — a um toast
flutuante).

## 17. Dataviz nova consome os tokens gerados, nunca hex solto

**Regra:** qualquer visualização nova (timeline de stages, funil do É IA?
standalone, etc.) importa cor/fonte de `DS_COLORS`/`DS_FONTS`
(`ds-tokens.generated.ts`, gerado a partir de `design-tokens.ts` — mesmo
arquivo consumido por `diaria-dashboard` e `brevo-dashboard`) ou, no
studio-server, do CSS custom properties de `tokens-css.ts`. Consultar
também a skill `dataviz` disponível no ambiente pra forma/paleta/interação
antes de desenhar o primeiro gráfico.

**Gap conhecido, sem issue própria:** as cores SEMÂNTICAS de status
(verde `#2d8a4e`, amarelo `#c07800`, vermelho `#C00000`, erro `#c0392b`) são
hardcoded inline em cada arquivo que precisa delas (`workers/diaria-dashboard/
src/index.ts`, `style.css` `.dot.down`, presumivelmente repetidas em
`sections-core.ts`) em vez de viverem como tokens nomeados em
`design-tokens.ts` — ao contrário das 8 cores estruturais do DS, que têm
fonte única. Não chega a ser uma issue própria (baixo risco, sem
inconsistência visual hoje — os valores batem entre os arquivos), mas vale
consolidar (`STATUS_COLORS` em `design-tokens.ts`) na próxima vez que
alguém tocar esses arquivos por outro motivo.

---

## Gaps conhecidos (sem issue própria)

Achados concretos, mas de baixo esforço/baixo risco — não abriram issue,
ficam registrados aqui pra quando alguém tocar o arquivo por outro motivo:

1. **Páginas de erro full-page sem link de volta** (regra 4) —
   `notConfiguredHtml`/`rateLimitedHtml`/`errorHtml` em
   `scripts/studio-ui/dashboard-clarice.ts` e o HTML "Dashboard não
   inicializado" do fetch handler de `workers/diaria-dashboard/src/index.ts`
   são texto puro sem CTA. Fix trivial: 1 link `<a href="/">← voltar ao
   Studio</a>` ou `?fresh=1` em cada.
2. **Cores de status não centralizadas** (regra 17) — consolidar
   verde/amarelo/vermelho/erro em `design-tokens.ts` como
   `STATUS_COLORS` na próxima vez que um desses arquivos for tocado.
3. **`setConn()` duplicada por módulo** (regra 15) — mesma função
   byte-idêntica em `app.js`/`edicao.js`/`revisao.js`/`rodada.js`/
   `triagem.js`/`integracoes.js`. Oportunidade de extrair pra
   `nav-core.js` ou um `conn-status.js` próprio (puro, testável), não um
   bug de UX — registrado aqui só porque a auditoria passou por ele.
4. **Botão "Atualizar É IA?" (`renderEiaRefreshButtonHtml`) some do
   dashboard-diaria embutido se `data/poll-eia-summary.json` nunca foi
   gerado** — o botão só aparece dentro do `if (!poll)` negativo (ou seja,
   quando JÁ há dado); o estado "nunca rodei o script ainda" mostra só o
   texto instrutivo sem o botão que resolveria isso com 1 clique. Pequeno
   — o texto já linka o comando certo (regra 3 cumprida via texto), só não
   oferece o atalho de botão nesse caso específico.

---

## Issues de follow-up abertas

Derivadas diretamente dos gaps marcados 🔴 acima — cada uma com prioridade
justificada, aberta nesta mesma sessão:

| # | Issue | Prioridade | Regra |
|---|---|---|---|
| [#3871](https://github.com/vjpixel/diaria-studio/issues/3871) | Cockpit `/edicao`: indicar idade do último evento quando um stage está "current" (#2379) | P2 | 2 |
| [#3873](https://github.com/vjpixel/diaria-studio/issues/3873) | Nav global do Studio: alvos de toque abaixo de 24px em mobile | P3 | 9 |
| [#3875](https://github.com/vjpixel/diaria-studio/issues/3875) | Abas JS-driven (`revisao.js`/`rodada.js`): `role="tab"` sem `aria-selected` nem teclado (#2622) | P3 | 10 |
| [#3876](https://github.com/vjpixel/diaria-studio/issues/3876) | Design system + Studio: dark mode ausente em toda a superfície administrativa | P2 | 14 |
| [#3877](https://github.com/vjpixel/diaria-studio/issues/3877) | Cockpit `/edicao`: Gate 4/6 não menciona nem linka a aprovação via chat drawer (mobile) | P2 | 6, 8 |

**#3871** — Stage "em andamento" sem idade do último evento no cockpit
`/edicao` (regra 2, lição #2379) — impossível distinguir rodando de travado
olhando só a UI local, mesmo tendo o dado (`logBuffer`) já em memória no
cliente.

**#3873** — Alvos de toque abaixo do mínimo recomendado no menu de
navegação global (regra 9) — `.app-nav-item`/`.app-nav-toggle` sem
padding/min-height, penaliza toda sessão mobile porque é o menu presente em
toda página.

**#3875** — Abas JS-driven (`revisao.js`, `rodada.js`) com `role="tab"`
incompleto (regra 10) — sem `aria-selected`, sem tabindex roving, sem
teclado — regressão da lição #2622 numa superfície mais nova que o
dashboard que a originou.

**#3876** — Dark mode ausente em 100% da superfície administrativa (regra
14) — design system single-palette, Studio + 2 dashboards + aba É IA? sem
nenhum tratamento de tema, apesar do próprio repo já ter (parcial)
precedente no renderer de e-mail.

**#3877** — Gate 4/6 no cockpit `/edicao` não linka nem menciona a
aprovação via chat drawer (regras 6/8) — o texto estático manda o editor
"aprovar no terminal", mas se a edição estiver rodando via o próprio chat
do Studio (o caminho que de fato viabiliza aprovar o gate direto do
celular, sem terminal nenhum — #3557), a página não diz isso nem dá o link
pra aba do chat onde a pergunta pendente de fato aparece; quem só olha o
cockpit no celular não descobre esse caminho.
