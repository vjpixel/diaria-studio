/**
 * scripts/lib/permutation-test.ts (#7980, extraído de calibration-power-report.ts)
 *
 * Gerador pseudo-aleatório determinístico (mulberry32) + shuffle in-place
 * (Fisher-Yates) usados pelo baseline nulo por permutação de
 * `calibration-power-report.ts` (Track B) e `calibration-power-report-
 * track-a.ts` (Track A, #7980) — extraído pra um módulo próprio em vez de
 * duplicado nos dois arquivos: mesma lógica, mesmo requisito de
 * determinismo (mesma seed → mesmo resultado, sem depender de
 * `Math.random()` global), agora com 1 única fonte.
 */

/** Pseudo-random determinístico (mulberry32) — permite reproduzir um relatório exato com a mesma seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates in-place, usando o gerador determinístico fornecido. */
export function shuffleInPlace<T>(arr: T[], rand: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
