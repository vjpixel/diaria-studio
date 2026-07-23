// shared-event-source.js (#3891, item 4) — decide se uma página deve abrir
// uma NOVA conexão SSE a /api/events ou reusar a que já existe.
//
// Achado #3891/#3866: toda página do Studio abre 2 conexões ao mesmo
// endpoint — a da PRÓPRIA tela (app.js/edicao.js/rodada.js, pro
// dot/timeline/log ao vivo) E uma segunda aberta por `chat-drawer.js`
// (injetado em TODAS as 8 páginas, só pro contador do badge global,
// #3888) — dobrando fs.watch/polling no server por aba aberta.
//
// `chat-drawer.js` é sempre o ÚLTIMO `<script type="module">` de cada HTML
// (ver index/edicao/rodada/triagem/apoios/integracoes/relatorios/revisao —
// todos carregam `nav.js` → script da própria página → `chat-drawer.js`,
// nessa ordem), e módulos `<script type="module">` executam em ordem de
// documento — então quando o topo de `chat-drawer.js` roda, a página host
// (se tiver EventSource próprio) já terminou de criar o dela. As 3 páginas
// com EventSource próprio (`app.js`/`edicao.js`/`rodada.js`) publicam a
// instância em `window.__studioEvents` logo após criá-la; `chat-drawer.js`
// checa esse global primeiro e só abre uma conexão nova se não achar nada —
// nas 5 páginas sem EventSource próprio (triagem/apoios/caixas/integracoes/
// relatorios), o próprio drawer cria a conexão compartilhada.
//
// `resolveSharedEventSource` é pura (testável sem browser/EventSource real):
// se `existing` já é um valor truthy, retorna ele mesmo sem invocar
// `factory`; senão chama `factory()` (que de fato abre a conexão) e retorna
// o resultado. O CALLER é quem lê/escreve `window.__studioEvents` — esta
// função só decide "reusa ou abre", pra poder ser exercida em Node puro.
//
// Trade-off aceito (documentado, não coberto por este fix): o retry manual
// de `app.js`/`edicao.js` (`connect()` fecha + recria a própria instância
// quando o editor clica "reconectar" após um erro persistente) atualiza
// `window.__studioEvents` para a NOVA instância, mas os listeners que o
// `chat-drawer.js` registrou na instância ANTIGA (capturada uma única vez,
// ao montar) não migram — o badge global fica sem atualizar até o próximo
// reload de página. Cenário estreito (exige queda persistente + clique
// manual de retry, o reconnect nativo do browser em quedas transitórias
// preserva a MESMA instância/listeners) e preferível a manter as 2 conexões
// permanentes que este fix elimina.
export function resolveSharedEventSource(existing, factory) {
  return existing ?? factory();
}
