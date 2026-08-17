/**
 * overnight-stall-threshold.ts (#5568)
 *
 * Fonte ÚNICA do limiar de stall do overnight — quantos minutos sem
 * atividade caracterizam "a rodada travou".
 *
 * Existia como o literal `60` duplicado em três consumidores independentes
 * (o watchdog externo #2688, o fallback wake do coordenador #2896, e a prosa
 * das camadas (i)/(ii)/(iii) da SKILL). Encurtar o limiar exigia caçar os
 * três e acertar todos — se um ficasse pra trás, as camadas passariam a
 * discordar entre si em silêncio (o watchdog acusando stall que o
 * coordenador ainda considera progresso normal, ou vice-versa). Daqui em
 * diante o número vive num lugar só e os consumidores importam.
 *
 * **Valor: 45 min (17/08/2026, decisão do editor — antes 60).** O pedido foi
 * "encurtar o tempo que o sistema leva pra perceber que o overnight parou".
 * O piso não é arbitrário: a SKILL do overnight define **timeout de espera
 * de CI = 30 min** (`.claude/skills/diaria-overnight/SKILL.md`, "Stall
 * passivo é inaceitável"), e durante essa espera o coordenador fica
 * legitimamente em silêncio — nem `plan.json` nem run-log recebem escrita,
 * que são exatamente as duas fontes de "última atividade" medidas por
 * `resolveRunActivity`. Um limiar de 30 min dispararia halt banner + push
 * por e-mail em TODA espera de CI saudável; o alarme viraria ruído e seria
 * ignorado — a mesma degradação que motivou o #5390 a tirar o kind
 * `continuo` do watchdog em vez de conviver com falso positivo garantido.
 * 45 é o menor valor estritamente acima desse silêncio legítimo máximo,
 * com 15 min de folga.
 *
 * **Pra baixar mais que isso**, o timeout de CI tem que cair junto — não
 * adianta mexer só nesta constante: 30 min de espera de CI continuariam
 * produzindo silêncio legítimo acima de qualquer limiar < 30.
 *
 * Não confundir com a CADÊNCIA do watchdog (systemd timer, a cada 10 min,
 * `scripts/lib/watchdog-systemd-units.ts`) nem com o delay do fallback wake
 * (~1200s, `.claude/skills/diaria-overnight/SKILL.md`): as duas são "de
 * quanto em quanto tempo alguém olha", esta constante é "a partir de quanto
 * tempo parado isso conta como travado". A cadência precisa ser MENOR que o
 * limiar pra detecção ser pontual — com 10 min e 20 min contra 45, ambas
 * seguem folgadas após esta mudança.
 *
 * O kind `continuo` NÃO usa esta constante — `WATCHED_KINDS` do watchdog não
 * o inclui desde o #5390 (wake ocioso de 4h; ver rationale lá e em
 * `.claude/skills/diaria-continuo/SKILL.md`). Se um dia voltar a ser
 * vigiado, ganha o próprio limiar, nunca este.
 *
 * @see scripts/overnight-watchdog.ts (#2688 — camada (ii), watchdog externo)
 * @see scripts/lib/overnight-fallback-wake.ts (#2896 — camada (iii), fallback wake)
 * @see .claude/skills/diaria-overnight/SKILL.md § "Stall passivo — três camadas"
 */

/**
 * Minutos sem atividade a partir dos quais uma rodada overnight é tratada
 * como travada. Override em runtime: env `OVERNIGHT_WATCHDOG_STALL_MIN` ou
 * flag `--threshold <min>` do watchdog (ver `scripts/overnight-watchdog.ts`).
 */
export const OVERNIGHT_STALL_THRESHOLD_MIN = 45;
