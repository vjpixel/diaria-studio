/**
 * newsletter-styles.ts (#2635) — fonte única do CSS de email Diar.ia: o bloco
 * <style> de cada renderer (diário e mensal) é construído por funções deste módulo.
 *
 * Arquitetura de dois níveis:
 *   1. BASE (emailBaseRules) — reset body/img/table. Hoje consumido pelo renderer
 *      DIÁRIO (tratado como canônico pela issue). Ver nota de escopo abaixo.
 *   2. OVERRIDES por renderer:
 *      - Diária: a.headline:hover + @media .container/.pad/.hero
 *      - Mensal:  @media .mob-stack (imagens A/B do É IA? em telas estreitas, #1918)
 *
 * Design-tokens (cores/fontes) já são compartilhados via ./design-tokens.ts — ambos
 * os renderers importam COLORS/FONTS de lá (fonte única de tokens). Este módulo NÃO
 * redefine valores visuais: as cores entram como ARGUMENTOS (pageBg, brandColor)
 * passados pelos callers, que os derivam de COLORS. Clientes de email não suportam
 * var() CSS; os valores são inline.
 *
 * ESCOPO CONSERVADOR (#2635): o objetivo deste PR é a INFRAESTRUTURA compartilhada
 * (uma fonte única para os blocos <style> + a base extraível) SEM mudar o que cada
 * renderer renderiza hoje. A base (emailBaseRules) é byte-idêntica ao bloco original
 * da diária e por isso já é consumida por ela. O renderer MENSAL hoje NÃO emite o
 * reset body/img/table — só a media query .mob-stack — então buildMensalStyleBlock
 * preserva exatamente esse output. Migrar a mensal para a base compartilhada MUDA o
 * render: o reset inclui `table { border-collapse:collapse; }`, e as tabelas de canto
 * arredondado da mensal (renderClariceBox, renderEncerramento, renderEia) não têm o
 * guard inline `border-collapse:separate;border-spacing:0` que a diária usa em TODA
 * tabela arredondada — sem o guard, `collapse` quadra os cantos em clientes que
 * honram o <style> (Apple Mail/iOS). Adotar a base na mensal (com os guards inline
 * correspondentes) é a decisão editorial de FOLLOW-UP que a própria issue antecipa
 * ("Confirmar quais diferenças são intencionais antes de unificar").
 */

/**
 * Regras CSS base de email Diar.ia: reset de body/img/table.
 *
 * Retorna as regras SEM a tag <style> envolvente; o caller embute no seu bloco.
 *
 * Nota de indentação: a primeira linha NÃO carrega espaço líder — o caller adiciona
 * via `  ${emailBaseRules(...)}` na template literal. As linhas seguintes já têm
 * 2 espaços de indent para alinhamento ao padrão do bloco <style>. Mantenha o caller
 * a 2 espaços de indent (ver buildDiariaStyleBlock).
 *
 * @param pageBg — cor de fundo da página (caller passa COLORS-derived, "#FFFFFF" hoje).
 */
export function emailBaseRules(pageBg: string): string {
  return `body { margin:0; padding:0; width:100% !important; background:${pageBg}; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  table { border-collapse:collapse; }`;
}

/**
 * Bloco <style> completo do renderer DIÁRIO (newsletter-render-html.ts).
 *
 * Combina emailBaseRules + overrides específicos da diária:
 *   - a.headline:hover { color:brand } — progressive enhancement (hover de manchete)
 *   - @media max-width:480px: .container (width), .pad (padding lateral), .hero (height)
 *
 * Produz output byte-idêntico ao DS_STYLE_BLOCK inline anterior — o snapshot de hash
 * em ds-golden-full-render.test.ts não muda (validado em newsletter-styles.test.ts).
 *
 * @param pageBg     — cor de fundo da página (#FFFFFF canonical após #1943).
 * @param brandColor — cor de acento do hover (#00A0A0 = COLORS.brand). Passado pelo
 *   caller; o módulo não importa COLORS para não virar segundo lugar-de-verdade.
 */
export function buildDiariaStyleBlock(pageBg: string, brandColor: string): string {
  return `<style>
  ${emailBaseRules(pageBg)}
  a.headline:hover { color:${brandColor} !important; }
  @media only screen and (max-width:480px) {
    .container { width:100% !important; }
    .pad { padding-left:12px !important; padding-right:12px !important; }
    .hero { height:auto !important; }
  }
</style>`;
}

/**
 * Bloco <style> completo do renderer MENSAL (monthly-render.ts wrapEmail).
 *
 * Preserva EXATAMENTE o output atual da mensal: apenas a media query .mob-stack
 * (#1918, empilha imagens A/B do É IA? em telas estreitas). NÃO inclui o reset
 * body/img/table de emailBaseRules — ver nota de escopo conservador no topo do
 * arquivo (a mensal hoje não emite o reset; adotá-lo mudaria o render por causa do
 * `table { border-collapse:collapse; }` em tabelas arredondadas sem guard). A
 * adoção da base compartilhada na mensal é follow-up editorial (#2635).
 *
 * #2645: também emite o suporte a dark theme (`@media (prefers-color-scheme: dark)`)
 * pedido pela issue — o Brevo (ao contrário do Beehiiv, que envolve a diária no seu
 * próprio shell configurável) não fornece dark mode automaticamente pro digest mensal.
 * ESCOPO DELIBERADO: a regra escurece só o CANVAS externo ao card (classe `.ds-canvas`,
 * aplicada por wrapEmail no `<body>`/tabela mais externa) — o card em si e todo o
 * conteúdo renderizado (títulos/parágrafos/boxes com INK/BEGE/TEAL fixos dos outros
 * render* da mensal) permanecem inalterados. Invert completo do conteúdo exigiria
 * retocar a cor de cada elemento (fora do escopo desta issue) e arrisca contraste
 * quebrado nos boxes internos já bege (fio condutor, É IA?, Clarice/Laboratório) —
 * que já são claros e não devem escurecer. O canvas escuro ao redor do card claro é
 * sinal real de dark mode sem esse risco.
 *
 * @param _reservedPageBg — reservado para a futura adoção da base (paridade de
 *   assinatura com buildDiariaStyleBlock, #2709 decide se/quando a mensal adota
 *   emailBaseRules). Deliberadamente ignorado hoje pra preservar o output atual;
 *   o fundo da mensal já é setado inline no <body> por wrapEmail. Renomeado de
 *   `_pageBg` (#2716 item 2) — o prefixo `_` sozinho não deixava claro que é
 *   reservado para uso futuro vs. um parâmetro genuinamente morto.
 * @param darkCanvasBg — cor do canvas em dark mode (#2645). Módulo não importa
 *   design-tokens por princípio arquitetural (valores entram via argumento do
 *   caller) — default espelha COLORS.ink (#171411) pra callers que não passam
 *   explicitamente (ex: chamadas diretas em teste).
 */
export function buildMensalStyleBlock(_reservedPageBg: string, darkCanvasBg: string = "#171411"): string {
  return `<style>
  /* #1918: empilha as imagens A/B do É IA? em telas estreitas, como na diária. */
  @media only screen and (max-width: 480px) {
    .mob-stack { display:block !important; width:100% !important; padding:0 0 12px 0 !important; }
  }
  /* #2645: dark theme — escurece o canvas externo ao card; conteúdo interno preservado. */
  @media (prefers-color-scheme: dark) {
    body, .ds-canvas { background:${darkCanvasBg} !important; }
  }
</style>`;
}
