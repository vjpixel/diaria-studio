/**
 * clarice-name.ts (#5200)
 *
 * `firstName()` extraído de `clarice-build-segment.ts` (sanitização de
 * U+FFFD adicionada em #5199) — estava DUPLICADO em mais 4 scripts
 * (`clarice-schedule-ramp.ts`, `clarice-build-edition-sends.ts`,
 * `clarice-build-wave-260812-especial.ts`, `weekly-send-plan-audience.ts`),
 * todos com a MESMA cópia pré-#5199 (sem a sanitização). Achado ao vivo em
 * #5184 item 3: 22 contatos no store têm `name` com U+FFFD (replacement
 * character — sinal de encoding corrompido upstream, ex: CSV do Stripe lido
 * como UTF-8 quando a fonte real era Latin-1/Windows-1252; "Gonçalo" virou
 * "Gon�alo"). A Brevo aceita o import inteiro (`processId` "completed") mas
 * descarta essa 1 linha em silêncio — sem sanitizar, o guard de
 * reconciliação existente (contagem CSV-enviado vs Brevo-confirmado) já
 * pega o caso, mas só depois de abortar 1x pra cada contato afetado. Perder
 * o acento é preferível a perder o contato inteiro do envio. Não tenta
 * recuperar o caractere original (irrecuperável a partir do byte já
 * substituído) — só impede o byte inválido de chegar ao CSV exportado pra
 * Brevo.
 *
 * Um único helper compartilhado evita que os 5 call sites divirjam de novo
 * silenciosamente da próxima vez que alguém tocar a lógica de sanitização.
 */

/**
 * Extrai o primeiro nome de `name` (ex: "Azevedo, Ana" → "Azevedo"),
 * sanitizando U+FFFD (replacement character) antes de particionar por
 * espaço/vírgula. `null`/`undefined`/vazio → "".
 */
export function firstName(name: string | null | undefined): string {
  return (name ?? "")
    .replace(/�/g, "")
    .trim()
    .split(/[\s,]+/)[0] || "";
}
