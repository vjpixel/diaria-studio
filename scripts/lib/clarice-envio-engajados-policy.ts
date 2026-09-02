/**
 * clarice-envio-engajados-policy.ts (#6945)
 *
 * Motor de volume PURO da automação diária do grupo `engajados` (retenção —
 * `send_eligible=1 AND sends_count>0 AND priority_points>0`, ordenado por
 * `priority_points DESC`, `isEngajados`/`segmentEngajados` em
 * `clarice-segment.ts`). A SELEÇÃO em si (quem entra, em que ordem, exclusão
 * de quem já recebeu neste mês de envio) já está implementada e correta —
 * achado da investigação da issue (comentário 01/09/2026): o que faltava era
 * o GATILHO (nenhuma task chamava `--group engajados`) e um teto mecânico
 * que substitua o editor como gate de "volume inesperado" (`clarice-build-
 * segment.ts:405-420` nomeia esse gate humano — automatizar precisa de um
 * substituto).
 *
 * DELIBERADAMENTE MAIS SIMPLES que `clarice-envio-policy.ts` (o motor do
 * `ramp-warm`): não há freio de risco de ISP nem escalada condicionada a
 * risco pra replicar aqui — `decideBrake` daquele módulo já é HARDCODED
 * "ok" desde #6793, e `adaptiveStep` já é incondicional (`FIXED_DAILY_STEP`)
 * desde #6888 — ou seja, hoje NADA no motor do ramp-warm reage a métrica de
 * risco além de relatório. Reusar `FIXED_DAILY_STEP` aqui (mesma taxa,
 * mesma constante, "no molde de clarice-envio-policy.ts" — pedido explícito
 * do editor) preserva paridade sem precisar importar `RiskMetrics`/
 * `SpamSignalLike`/`decideBrake`, que não têm papel nenhum nesta automação
 * (o grupo `engajados` é audiência JÁ ENGAJADA — o risco de ISP relevante é
 * o mesmo risco AGREGADO da conta inteira, já coberto pelo freio do
 * `ramp-warm`; duplicar o cálculo aqui seria 2 leituras do mesmo fato,
 * exatamente a classe de bug que o #4658 já corrigiu uma vez).
 *
 * `proposeEngajadosVolume` NÃO recebe `queueAvailable` — ao contrário de
 * `proposeNextVolume` (ramp-warm), que corta pela fila porque a fila do 1º
 * envio pode ser genuinamente pequena num dia ruim. Aqui o corte por fila
 * insuficiente é DELEGADO pro `--budget` de `clarice-build-segment.ts`
 * (semântica já documentada como TETO: "pega o TOPO da ordem" — se a fila
 * real for menor que o volume proposto, a escrita real seleciona só o que
 * existe, sem erro) — replicar esse corte aqui seria a 2ª fonte da mesma
 * verdade, e a primeira (a escrita real) é quem manda.
 */

/**
 * Volume da 1ª rodada — nunca houve baseline PRÓPRIA do grupo `engajados`
 * na era automatizada (o último envio manual foi 06/08/2026, ciclo
 * `2607-08`, 817 contatos — dado velho demais pra servir de base de
 * escalada). Ponto de partida CONSERVADOR — automação nova, nunca rodou
 * desassistida, kill switch nasce DESLIGADO (ver
 * `clarice-envio-engajados-enabled.ts`) então mesmo este número só passa a
 * valer depois que o editor ligar a automação explicitamente e revisar a
 * 1ª rodada. Tunável — não é uma medição, é um chute conservador
 * documentado; o editor pode ajustar a constante se quiser começar maior.
 */
export const ENGAJADOS_BOOTSTRAP_VOLUME = 1500;

/**
 * Teto ABSOLUTO de volume por rodada — o "teto de volume" que a issue pede
 * como substituto mecânico do gate humano que a automação remove
 * (`clarice-build-segment.ts:405-420`). Nunca é excedido, independente de
 * quanto a escalada (`ENGAJADOS_DAILY_GROWTH_STEP`) proponha. 8.000/dia
 * drena o backlog conhecido (37,9k em 01/09/2026) em ~5 dias UMA VEZ que a
 * escalada atinja o teto (~18 dias de crescimento a partir do bootstrap,
 * ver `proposeEngajadosVolume`) — nunca um "tudo de uma vez" mesmo com a
 * fila represada. Mesma disciplina de número tunável do bootstrap acima.
 */
export const ENGAJADOS_MAX_DAILY_VOLUME = 8000;

/**
 * Taxa de crescimento diário — mesma constante de `clarice-envio-policy.ts`
 * (`FIXED_DAILY_STEP`, decisão do editor #6888: 10%/dia, incondicional).
 * Redeclarada aqui (não importada) de propósito: importar acoplaria este
 * módulo ao motor do `ramp-warm` por um valor que hoje é só uma coincidência
 * de escolha, não uma relação estrutural — se o editor um dia quiser taxas
 * diferentes por grupo, as duas constantes já vivem em módulos separados,
 * sem precisar quebrar o acoplamento primeiro.
 */
export const ENGAJADOS_DAILY_GROWTH_STEP = 0.1;

/**
 * Volume proposto pra rodada de hoje. `lastVolume` é o volume da ÚLTIMA
 * rodada CONFIRMADA (`clarice-envio-engajados-state.ts` — só avança em
 * disparo confirmado, nunca em rodada pulada/abortada) — `null`/inválido
 * (não-finito, ≤0) cai no bootstrap, tratando "sem histórico" e "histórico
 * corrompido" da mesma forma seg (nunca escala sobre uma base inválida).
 *
 * Ordem: bootstrap-ou-base → crescimento de `ENGAJADOS_DAILY_GROWTH_STEP` →
 * teto absoluto. Nunca devolve um valor não-finito nem negativo — a base
 * inválida já cai no bootstrap antes de qualquer aritmética.
 */
export function proposeEngajadosVolume(lastVolume: number | null | undefined): number {
  const base =
    typeof lastVolume === "number" && Number.isFinite(lastVolume) && lastVolume > 0
      ? Math.floor(lastVolume)
      : ENGAJADOS_BOOTSTRAP_VOLUME;
  const grown = Math.round(base * (1 + ENGAJADOS_DAILY_GROWTH_STEP));
  return Math.min(grown, ENGAJADOS_MAX_DAILY_VOLUME);
}
