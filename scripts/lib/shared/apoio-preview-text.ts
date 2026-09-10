/**
 * scripts/lib/shared/apoio-preview-text.ts (#7867 item 2)
 *
 * Preview text fixo dos DOIS canais pagos de apoio (Retrospectiva do Mês —
 * Mantenedor/Patrono, R$25+ — e Artigo Especial — Apoiador, R$10+). Decisão
 * do editor, 09/09/2026: nestes dois canais o `preview_text` deixa de ser
 * teaser derivado do conteúdo e passa a ser sinalização de exclusividade no
 * inbox — o assinante identifica a recompensa paga antes de abrir.
 *
 * Achado que motivou: em 2608-09 o preview derivado saiu
 * "Agentes atacaram sistemas reais, Brasil buscou infra e vagas cortadas
 * voltaram." e o editor o substituiu à mão no painel do Kit por esta string.
 * Substituição manual garantida a cada envio é exatamente o padrão que
 * "pergunta cuja resposta é sempre a mesma vira default automático" (CLAUDE.md)
 * cobre.
 *
 * Constante compartilhada (não chave em `platform.config.json`) porque é
 * copy fixa, não configuração de canal — os dois publishers importam o MESMO
 * valor em vez de cada um definir a própria string, o que evitaria os dois
 * divergirem em silêncio se algum dia a redação mudar.
 *
 * Fora de escopo (decisão do editor, issue #7867): a diária e a anual NÃO
 * são exclusivas de apoiador e continuam com preview derivado do conteúdo —
 * esta constante não deve ser usada nesses dois canais.
 */
export const APOIO_EXCLUSIVE_PREVIEW_TEXT = "Exclusivo para apoiadores";
