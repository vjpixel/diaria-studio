// rv-images-format.js (#6447 Fatia 4, achados 6 + 9) — formatação/decisão
// PURA (sem DOM) consumida por rv-images.js. Mesma convenção de
// rv-gate-format.js/rv-highlights-format.js: lógica sem `document` mora aqui
// pra ser testável direto (test/rv-images-format.test.ts).

/** Texto de status de UMA imagem — `entry` é um `ImageEntry`
 * (`studio-images.ts`): `{type, label, filename, exists}`. */
export function formatImageExistence(entry) {
  if (!entry) return "";
  return entry.exists ? "gerada" : "ainda não gerada — rode a Etapa 3 ou clique Regenerar";
}

/** `target` (`"d1"`/`"d2"`/`"d3"`/`"eia"`) está com job de regeneração
 * `running` nesta galeria? `gallery` é o payload de
 * `GET /api/editions/:aammdd/images` (`ImagesGallery`, `studio-images.ts`).
 * `false` (nunca lança) pra galeria indisponível/shape inesperado. */
export function isTargetRegenerating(gallery, target) {
  if (!gallery || gallery.available !== true) return false;
  if (target === "eia") return !!(gallery.eia && gallery.eia.regenerating);
  const m = /^d(\d+)$/.exec(target);
  if (!m) return false;
  const n = Number(m[1]);
  const destaques = Array.isArray(gallery.destaques) ? gallery.destaques : [];
  const found = destaques.find((d) => d && d.n === n);
  return !!(found && found.regenerating);
}

/** Algum job de regeneração (qualquer destaque ou É IA?) está `running`
 * nesta galeria? Usado por `rv-images.js` pra decidir se continua fazendo
 * polling (#6447 — long-running work, ver docstring de `studio-images.ts`). */
export function anyTargetRegenerating(gallery) {
  if (!gallery || gallery.available !== true) return false;
  const destaques = Array.isArray(gallery.destaques) ? gallery.destaques : [];
  if (destaques.some((d) => d && d.regenerating)) return true;
  return !!(gallery.eia && gallery.eia.regenerating);
}

/** Texto do botão "Regenerar" por destaque/eia — reflete o estado do job em
 * progresso, pra o editor nunca achar que o clique não registrou. */
export function formatRegenerateButtonLabel(regenerating) {
  return regenerating ? "Regenerando…" : "Regenerar";
}
