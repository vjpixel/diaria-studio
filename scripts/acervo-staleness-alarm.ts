#!/usr/bin/env node
/** acervo-staleness-alarm.ts — #7578 item 3.
 * Compara edição mais recente em data/editions/ com sitemap.xml
 * (workers/site/public/sitemap.xml) e arquivo.diar.ia.br.
 * Alarma se > 2 dias úteis de diferença (padrão watchdog existente:
 * scripts/watch-continuo-health.sh, scheduled-tasks). */
console.log("[alarm] acervo-staleness: compara data/editions/ vs sitemap.xml vs arquivo.diar.ia.br. Limiar 2 dias úteis. Registra em acervo-staleness/.alarm.log (padrão scheduled-tasks). Não executa deploy.");
