/**
 * instagram-test-override.ts (#8681)
 *
 * Override de TESTE do Instagram, por edição, sem mexer nas constantes
 * globais (`INSTAGRAM_CTA_LINE`, `DAILY_CAROUSEL_CTA_KICKER`). Caso que
 * motivou (260922): o editor quis testar, só numa edição, uma legenda com
 * outra chamada e um card final sem a faixa "Assine grátis" — e o único
 * caminho era editar a constante (PR #8675, fechada: era teste) ou contornar
 * pela seção legada `# Instagram` e sobrescrever a arte depois do carimbo.
 *
 * Arquivo: `{edição}/_internal/instagram-test.json`
 *
 *   {
 *     "caption": "texto completo da legenda (substitui corpo + CTA + tags)",
 *     "cta_slide": { "title": "título do card final", "kicker": "" }
 *   }
 *
 * Todos os campos são opcionais; `kicker: ""` remove a faixa. Consumidores:
 *   - `publish-instagram.ts` — legenda (e marca o post como teste no
 *     `06-social-published.json`, `instagram_test_override: true`);
 *   - `gen-carousel-cards.ts` — texto do slide `cta`;
 *   - invariantes `carousel-cards-stale`/`carousel-text-overflow` — o override
 *     entra no carimbo de frescor, então mudar o override regera a arte e
 *     nunca dispara falso "stale".
 *
 * Ausente → `null` (comportamento de sempre). Presente mas malformado →
 * LANÇA: é uma instrução editorial explícita, e publicar ignorando-a em
 * silêncio seria pior que parar.
 *
 * **Guard "promessa de comentário" (#8681, rebaixado a warning no #8848):**
 * o repo não tem nenhum mecanismo que responda a comentários do Instagram —
 * `caption`, `cta_slide.title` e `cta_slide.kicker` são checados contra
 * `scripts/lib/comment-delivery-promise.ts` (invariante de Stage 4
 * `instagram-comment-delivery-promise`, severity "warning" + aviso não-
 * bloqueante em `publish-instagram.ts`) quando parecem prometer entregar
 * link/edição/material a quem comentar. Não bloqueia — é heurística de
 * regex com falsos positivos/negativos conhecidos (#8848); o editor decide.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const INSTAGRAM_TEST_OVERRIDE_FILENAME = "instagram-test.json";

export interface CarouselCtaOverride {
  title?: string;
  kicker?: string;
}

export interface InstagramTestOverride {
  caption?: string;
  cta_slide?: CarouselCtaOverride;
}

export function instagramTestOverridePath(editionDir: string): string {
  return resolve(editionDir, "_internal", INSTAGRAM_TEST_OVERRIDE_FILENAME);
}

/** Pure: valida o JSON já parseado. Lança com mensagem acionável. */
export function parseInstagramTestOverride(data: unknown, source = INSTAGRAM_TEST_OVERRIDE_FILENAME): InstagramTestOverride {
  const fail = (why: string): never => {
    throw new Error(`[instagram-test-override] ${source} inválido: ${why} (#8681)`);
  };
  if (!data || typeof data !== "object" || Array.isArray(data)) fail("esperado um objeto JSON");
  const obj = data as Record<string, unknown>;
  const out: InstagramTestOverride = {};
  if (obj.caption !== undefined) {
    if (typeof obj.caption !== "string" || !obj.caption.trim()) fail("`caption` precisa ser string não-vazia");
    out.caption = (obj.caption as string).trim();
  }
  if (obj.cta_slide !== undefined) {
    const cta = obj.cta_slide;
    if (!cta || typeof cta !== "object" || Array.isArray(cta)) fail("`cta_slide` precisa ser objeto");
    const c = cta as Record<string, unknown>;
    const slide: CarouselCtaOverride = {};
    if (c.title !== undefined) {
      if (typeof c.title !== "string" || !c.title.trim()) fail("`cta_slide.title` precisa ser string não-vazia");
      slide.title = (c.title as string).trim();
    }
    if (c.kicker !== undefined) {
      if (typeof c.kicker !== "string") fail("`cta_slide.kicker` precisa ser string (\"\" remove a faixa)");
      slide.kicker = c.kicker as string;
    }
    out.cta_slide = slide;
  }
  return out;
}

export function readInstagramTestOverride(editionDir: string): InstagramTestOverride | null {
  const path = instagramTestOverridePath(editionDir);
  if (!existsSync(path)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`[instagram-test-override] ${path} não é JSON válido: ${(e as Error).message} (#8681)`);
  }
  return parseInstagramTestOverride(data, path);
}
