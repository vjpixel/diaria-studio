# Studio UI — Guidelines de UX (#3866)

Regras acionáveis para telas do Studio (`scripts/studio-ui/`), destiladas de: lições já pagas neste repo (#2622, #2379/#2688, #573, #738, #3617), auditoria das telas embarcadas no V1/V2 (260722) e levantamento externo (NN/G, WCAG, Material/HIG, Datadog — fontes no fim). Vale para toda tela nova e para retrofit das existentes.

**Como usar:** o [checklist padrão de tela](#checklist-padrão-de-tela-critério-de-aceite) é critério de aceite de qualquer PR que crie ou altere tela do Studio. As regras R1–R18 são a justificativa e o detalhe de cada item. Issues de retrofit já abertas: #3870 (gates sem affordance no cockpit), #3872 (painéis stale pós-save na revisão), #3874 (passe transversal a11y/mobile/tokens).

---

## Estado e tempo

**R1 — Todo dado que envelhece declara a própria idade.** Painel com dado de fetch/snapshot mostra "Atualizado HH:MM" (BRT, absoluto — não só "há 5min"). O timestamp **nunca** é atualizado quando o fetch falha (padrão correto em `rodada.js`: "atualizado agora" só em sucesso). Idade acima de limiar → aviso visual explícito ("dados de HH:MM — travado?"), como o espelho read-only já faz (`renderStudioSnapshotHtml`, #3565). Hoje falta justamente nas telas mais olhadas: index e cockpit da edição.

**R2 — "Rodando" e "travado" só se distinguem por tempo desde a última atividade verificável.** Nunca por heartbeat auto-declarado — a fonte é mtime de arquivo ou timestamp de log (`computeLastActivity()` do watchdog #2688; detecção-no-wake #2379). Processo longo mostra: stage atual + duração + último evento. UI nunca implica "tudo bem" por omissão de sinal.

**R3 — Falha de rede ≠ dado ausente.** Nunca colapsar os dois num texto genérico. `rodada.js` (`fetchFailed` vs `found === false`) e `triagem.js` ("gh falhou, mostrando cache de HH:MM" vs "gh falhou e não há cache") são a referência; `apoios.js`/`integracoes.js` ainda colapsam. Erro sempre com caminho de saída: retry, ou abrir o chat com contexto — nunca beco sem saída (heurística NN/G #9).

**R4 — Vazio, carregando e erro são parte do design de toda tela.** Os 3 estados desenhados desde o início, não fallback de engenharia (NN/G: 92% dos dashboards auditados sem empty state). Vazio explica por quê e o que fazer (`relatorios.js` com `#reports-empty` é o template do repo). Filtro client-side que zera a lista mostra "0 resultados para este filtro" — tabela só com cabeçalho lê como bug. "—" de carregando e "—" de sem-dado não podem ser o mesmo glifo.

## Verdade sobre estado externo

**R5 — Zero UI otimista em escrita; estado externo só via validação determinística.** Toda mutação refetcha do servidor antes de repintar (padrão `apoios.js`, generalização correta do #573). Estado de publicação/agendamento só via helpers de `scripts/lib/publish-state.ts` — nunca o `status` cru da API nem o gloss de um agent; sem dado suficiente, o default é "desconhecido", nunca sucesso (incidente canônico: `confirmed` do Beehiiv 16h no futuro relatado como "publicado"). Otimismo visual só em interação local de alta frequência e reversível — e mesmo aí revertendo em falha (padrão da edição inline de título em `revisao.js`, que restaura o texto original em erro).

**R6 — Fricção proporcional ao blast radius** (o modelo de gates 1/2/B do `/diaria-develop` aplicado a UI):
- Reversível e local (filtro, refresh): zero fricção; feedback no próprio botão ("Atualizando…", padrão `refreshStatusBtn` de apoios).
- Descarta trabalho (trocar de aba com edição não salva, sobrescrever divergência, 409 de mtime): `confirm()` com mensagem **específica do risco real**, nunca "Tem certeza?" genérico (padrão `revisao.js`/`revisao-guards.js`).
- Irreversível ou externo (disparar onda, agendar, publicar): confirmação dedicada com resumo do efeito, botão rotulado com o verbo real e o alvo ("Agendar para 06:00 BRT", nunca "OK"), estilo de perigo, sem auto-focus no botão perigoso (NN/G). Determinístico não precisa de humano (Gate 2: CI verde + threads==0); humano nunca tem fallback silencioso — ausência de resposta pausa, não avança.
- Nunca posicionar ação consequente colada em ação benigna (NN/G).

**R7 — Estado que espera o editor sempre aponta a ação.** Card de gate pendente sem botão é beco sem saída — se a ação mora em outro lugar (card do chat drawer), a tela faz a ponte com 1 clique (#3870). Botão desabilitado sempre com o motivo em **texto visível** ao lado, não só `title=` — tooltip não existe em touch (vale pro "Disparar esta onda" da triagem e pro item "Revisão" da nav).

**R8 — Gate humano nunca fica invisível.** Badge global + card no drawer sempre-presente (#3617) + "esperando há Xmin" ao vivo + push quando remoto. Sem timeout por design (semântica do `AskUserQuestion` preservada, #3557). Hidratação de gates pendentes que falha não pode falhar em silêncio — avisar e re-tentar.

**R9 — Parada inesperada = halt com 3 campos obrigatórios:** onde parou (stage), por quê (reason), o que fazer agora (action concreta — nunca "aguarde"). Visual distinto de gate: gate é pausa esperada (decisão), halt é quebra (#738/#737, `render-halt-banner.ts`). O cockpit que só aproxima halts via run-log declara essa limitação com destaque, não em letra miúda.

## Camadas e densidade

**R10 — Progressive disclosure em 3 camadas: resumo → detalhe expandível → raw.** O topo da tela responde em <5s "tem algo esperando ou quebrado?"; detalhe expande in-place (stages → eventos do run-log); a camada final é o raw (run-log completo, chat). Semântica e thresholds explicados **dentro da própria página** — padrão do brevo-dashboard: "vermelho sempre significa ruim" + critérios de circuit breaker inline, sem exigir doc externo.

**R11 — Cores de status são tokens semânticos, e vermelho é reservado.** Uma fonte única (`--status-ok/--status-warn/--status-danger/--status-info` em `tokens-css.ts`), não hex ad-hoc por página (hoje: 7+ paletas duplicadas entre triagem/rodada/apoios/integracoes, com o mesmo `#5319e7` significando coisas diferentes — #3874). Vermelho só para "ruim/perigo" na página inteira (convenção já vigente nos dashboards). Cor nunca é o único canal: sempre texto ou forma junto (os badges atuais acertam nisso).

## Mobile e acessibilidade

**R12 — Fluxos de decisão são mobile-first.** Aprovar gate do celular é o caso de uso âncora do epic #3554. Alvo de toque ≥44px (WCAG 2.5.5/HIG; 24px é o piso AA) com ≥8px entre ações adjacentes — crítico em Aprovar/Negar lado a lado. Formulários de decisão sem digitação onde der (opções clicáveis; campo livre é fallback). A referência de maturidade mobile do repo é o chat drawer (FAB colapsado, overlay full-screen, `visualViewport` para o teclado virtual) — generalizar o raciocínio, não necessariamente o componente.

**R13 — Widgets seguem o padrão WAI-ARIA correspondente, com enhancement sobre base funcional.** Lição do #2622: a navegação nunca depende de JS carregar — base funcional primeiro, e a camada de enhancement sincroniza URL-hash ↔ estado (deep-link) + `aria-selected`. Abas com `role="tab"` + `aria-selected` gerenciado + setas (APG); erros com `role="alert"`; regiões que atualizam via SSE com `aria-live="polite"` (`assertive` só para erro urgente — abuso dessensibiliza); toggles com `aria-expanded` (`nav.js` faz certo; o toggle do chat não — #3874); modais com `<dialog>` nativo (foco, backdrop e Esc de graça — padrão apoios).

**R14 — Ordem do DOM = ordem de leitura.** Não inverter listas visualmente com `column-reverse` deixando o DOM cronológico (log do index) — teclado e leitor de tela leem na ordem errada. Inserir na ordem que se quer ler.

**R15 — Secret nunca ecoa.** Campo sensível vira `type="password"` e é limpo da tela após envio **mesmo em falha** (padrão chat drawer); telas de diagnóstico mostram presença/ausência e nome da env var, nunca o valor (padrão integrações). Nada de secret em log, plan.json ou URL.

## Notificação e tema

**R16 — Notificação em escada: badge < card < push.** Push (Telegram, #3564) só para "espera o editor": gate pendente, halt, CI vermelho persistente — com dedup (1 por gate; janela de 15min do halt banner) e deep-link. Threshold alinhado a impacto, não a evento cru; alerta sem próximo passo é ruído (Datadog, alarm fatigue). A mensagem declara quando o deep-link só resolve na rede local (limitação real do `resolveStudioPublicBaseUrl` hoje).

**R17 — Studio sempre em tema claro, sem dark mode.** O #3876 tinha introduzido `@media (prefers-color-scheme: dark)` em `tokens-css.ts` (sobrescrevendo `--paper`/`--paper-alt`/`--ink`/`--on-ink`/`--status-*`) — revertido no #4001 por decisão do editor: o Studio não deve mudar de tema com a preferência do sistema/browser, sempre a paleta clara do DS (#4 cores, hierarquia por tamanho/peso — `design-tokens.ts`). `tokens-css.ts` declara `color-scheme: light` no `:root` pra garantir que controles nativos (inputs, scrollbars, selects) também rendeiam claros. Isso é independente do dark mode do e-mail (`newsletter-styles.ts`, `darkCanvasMediaRule`) — aquele continua vivo, é superfície separada (e-mail é lido no cliente do assinante, não no Studio). Continua valendo: nenhum hardcode de cor fora dos tokens sem comentário justificando.

**R18 — Dataviz e timelines: cor + forma + texto, nunca só cor.** Os chips de stage codificam done/current/gate por cor e borda — adicionar sempre o texto/`aria-label` do estado. Novas visualizações usam os tokens do DS, staleness da R1, e a skill `dataviz` como método (paleta/formas/validação de contraste).

---

## Checklist padrão de tela (critério de aceite)

Todo PR que cria ou altera tela do Studio confirma:

1. **Estados:** vazio (com explicação + próximo passo), carregando (distinto de vazio) e erro (com retry/ação) desenhados; filtros zerados mostram "0 resultados".
2. **Staleness:** "Atualizado HH:MM" visível; timestamp não avança em falha; limiar de "possivelmente travado" quando fizer sentido.
3. **Ações:** botão descreve efeito + alvo; desabilitado tem motivo em texto visível; fricção proporcional (R6); nenhuma escrita otimista.
4. **A11y:** `role`/`aria-selected`/`aria-expanded`/`role="alert"`/`aria-live` conforme R13; foco visível; ordem DOM = ordem de leitura.
5. **Mobile:** usável em viewport pequena; alvos ≥44px; nada essencial escondido atrás de hover/tooltip.
6. **Tokens:** cores via tokens (semânticos para status); hardcode só com comentário justificando.
7. **Gates:** pendência visível globalmente + caminho de 1 clique até a ação; sem default silencioso.

## Aplicável aos 3 dashboards existentes (backlog futuro, sem escopo aqui)

Os workers (diaria-dashboard, brevo/clarice-dashboard, poll) já são a origem de vários padrões (abas #2622, vermelho-é-ruim, thresholds inline, `generated_at` visível). Ficam anotadas como pendências futuras, **sem issue aberta ainda**:

- Tokens semânticos de status compartilhados (mesma consolidação do #3874) — hoje cada worker repete a paleta.
- `aria-live` nos blocos que mudam entre reloads e `role="alert"` nos banners de threshold cruzado.
- Alvos de toque ≥44px nas labels de aba em mobile.
- Estado vazio com texto nos painéis que podem vir sem dados (ex.: CTR de edição recém-publicada).

## Fontes externas (levantamento 260722)

NN/G: Visibility of System Status · Progress Indicators · Designing for Long Waits · Empty States in Complex Applications · Confirmation Dialogs · Dangerous UX (proximidade de opções consequentes). WCAG 2.5.8 (24px AA) / 2.5.5 (44px AAA). Material/HIG (touch targets, 8dp de espaçamento). UXPin/A11Y Collective (aria-live). Harvard DAS (modais acessíveis). Smashing Magazine / Raw.Studio (real-time dashboards: staleness, refresh manual, banner de desconexão). Simon Hearne / xiaoyunyang (limites de optimistic UI). Datadog / Grafana (alarm fatigue, alertas multi-estágio com dedup).
