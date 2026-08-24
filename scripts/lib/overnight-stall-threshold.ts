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
 * **Por que um módulo próprio, e não dentro de `overnight-watchdog.ts`
 * (dono "natural" do conceito, que já hospeda `detectStall`):** o outro
 * consumidor é `scripts/lib/overnight-fallback-wake.ts`, e
 * `test/lib-boundary.test.ts` (#2747) proíbe `scripts/lib/` de importar de
 * `scripts/*`. A constante precisava de um lar dentro de `lib/` — não é
 * preferência de estilo, é a fronteira lint-enforced que decide.
 *
 * **Valor: 45 min (17/08/2026, decisão do editor — antes 60).** O pedido foi
 * "encurtar o tempo que o sistema leva pra perceber que o overnight parou".
 * O piso não é arbitrário: `CI_WAIT_TIMEOUT_MIN` abaixo é o teto do silêncio
 * LEGÍTIMO — durante uma espera de CI o coordenador não escreve nem em
 * `plan.json` nem no run-log, que são exatamente as duas fontes de "última
 * atividade" medidas por `resolveRunActivity`. Um limiar de 30 min
 * dispararia halt banner + push por e-mail em TODA espera de CI saudável; o
 * alarme viraria ruído e seria ignorado — a mesma degradação que motivou o
 * #5390 a tirar o kind `continuo` do watchdog em vez de conviver com falso
 * positivo garantido. 45 é o menor valor estritamente acima desse silêncio
 * legítimo máximo, com 15 min de folga.
 *
 * **Pra baixar mais que isso**, o timeout de CI tem que cair junto — não
 * adianta mexer só nesta constante: 30 min de espera de CI continuariam
 * produzindo silêncio legítimo acima de qualquer limiar < 30. `parseArgs`
 * (`scripts/overnight-watchdog.ts`) avisa em stderr quando um override de
 * runtime cruza esse piso, em vez de obedecer calado.
 *
 * **Efeito colateral consciente no dedup (achado do review do #5568):** a
 * janela de dedup de alarme do watchdog é `max(limiar/2, 15 min)`, então
 * encurtar o limiar encurtou também o intervalo entre alarmes repetidos do
 * MESMO stall — de 30 min (com 60) pra 22,5 min (com 45). Numa rodada
 * travada por horas isso significa ~26% mais e-mails. Aceito: o vínculo
 * `limiar/2` é preexistente e a intenção dele (dedup proporcional ao que se
 * considera "parado") continua coerente com o limiar novo.
 *
 * **Unidade em minutos, não `_MS` como a maioria das constantes de tempo do
 * repo:** a interface pública deste número é humana e já era em minutos —
 * env `OVERNIGHT_WATCHDOG_STALL_MIN`, flag `--threshold <min>`, e os
 * parâmetros `thresholdMin` de `detectStall`/`shouldWakeCheck`, todos
 * anteriores a esta extração. Converter aqui obrigaria a desconverter nos
 * três. Os call sites que precisam de ms multiplicam por `60_000` no ponto
 * de uso.
 *
 * Não confundir com a CADÊNCIA do watchdog (systemd timer, a cada 10 min,
 * `scripts/lib/watchdog-systemd-units.ts`) nem com o delay do fallback wake
 * (~1200s, `.claude/skills/diaria-overnight/SKILL.md`): as duas são "de
 * quanto em quanto tempo alguém olha", esta constante é "a partir de quanto
 * tempo parado isso conta como travado". A cadência precisa ser MENOR que o
 * limiar pra detecção ser pontual — com 10 min e 20 min contra 45, ambas
 * seguem folgadas após esta mudança.
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

/**
 * Teto do silêncio LEGÍTIMO de uma rodada overnight: o timeout de espera de
 * CI declarado em `.claude/skills/diaria-overnight/SKILL.md` ("Timeout por
 * espera de CI = **30 min**; estourou → tratar como CI vermelho").
 *
 * Vive aqui, e não só na prosa, porque é o PISO de
 * `OVERNIGHT_STALL_THRESHOLD_MIN` — sem ele em código, a relação entre os
 * dois números só existiria em texto, e baixar o limiar abaixo do piso
 * passaria sem nenhum sinal. `parseArgs` usa pra avisar em runtime e
 * `test/overnight-stall-threshold.test.ts` usa pra travar em CI, checando
 * também que este valor continua batendo com a prosa da SKILL (a regra de
 * CI é executada pelo coordenador lendo o texto, então o texto é a fonte —
 * este export é a cópia que precisa ser mantida em sincronia com ela).
 */
export const CI_WAIT_TIMEOUT_MIN = 30;
