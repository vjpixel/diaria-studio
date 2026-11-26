/**
 * scripts/lib/cloudflare-kv-key.ts
 *
 * Convenção de chave do KV de imagens públicas (#1119, #1584). Módulo-folha,
 * sem imports: extraído de `scripts/upload-images-public.ts` no #13997 para
 * que os módulos de lib que só precisam da chave (`weekly-flat-card.ts`,
 * `weekly-instagram-ondemand-card.ts`) não importem o CLI de topo (#14001) e,
 * por ele, a cadeia inteira da edição diária (fronteira mensal/diária, #13998).
 */

/**
 * Constrói KV key única por edição + filename. Convenção #1119: `img-{AAMMDD}-{filename}`.
 * Extrai AAMMDD do path da edição (ex: `data/editions/260512/` → `260512`).
 *
 * #1584: quando `md5Hex` é passado, anexa sufixo `-{md5short}` antes da extensão
 * (`img-{AAMMDD}-{base}-{md5short}.{ext}`). Cache-busts re-uploads — Cloudflare
 * serve com `Cache-Control: max-age=1ano, immutable`, então sem suffix o browser
 * nunca pega imagem regenerada (caso 260529: D1 regen 3 vezes, sempre mesma URL
 * → editor via imagem antiga).
 */
export function cloudflareKvKey(
  editionDir: string,
  filename: string,
  md5Hex?: string,
): string {
  const match = editionDir.replace(/[\\/]+$/, "").match(/(\d{6})$/);
  const aammdd = match?.[1] ?? "unknown";
  if (!md5Hex) return `img-${aammdd}-${filename}`;
  const md5short = md5Hex.slice(0, 8);
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return `img-${aammdd}-${filename}-${md5short}`;
  const base = filename.slice(0, dot);
  const ext = filename.slice(dot);
  return `img-${aammdd}-${base}-${md5short}${ext}`;
}
