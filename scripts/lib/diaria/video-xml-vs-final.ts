/**
 * scripts/lib/diaria/video-xml-vs-final.ts (#13196, #13197)
 *
 * Comparação recorrente entre o XML que o `/diaria-video-montagem` gera e o
 * vídeo que o editor exporta do Premiere para `{AAMMDD}/Final/`. Transforma o
 * método da análise única da #11670 (scripts descartáveis, fora do repo) em
 * código: o CLI `scripts/video-xml-vs-final.ts` decodifica os áudios e chama
 * o alinhamento por envelope que já existe (`alignEnvelopes`, #11504); aqui
 * fica a parte pura.
 *
 *   1. `finalSpansFromRuns`: os trechos do final com par no bruto, cada um com
 *      o tempo no bruto (o `offset` do alinhamento é bruto − final).
 *   2. `compareSequence`: cruza os clipes do `plan.json` (a verdade do XML, em
 *      segundos do bruto) com esses trechos e classifica cada diferença:
 *      clipe removido, ponta aparada ou estendida (ms, por lado), pausa
 *      interna removida, trecho acrescentado, tomada trocada (o acrescentado
 *      tem o texto de um clipe removido), ordem. As palavras do
 *      `transcript.json` do bruto dão "palavras recuperadas pelo editor" (no
 *      final, nas pontas estendidas fora de todo clipe do XML: o sinal da
 *      #13194; a fala da outra tomada e a dos trechos acrescentados fica de
 *      fora) e "palavras tiradas". `alignWithReorder` dá os trechos mesmo
 *      com a ordem trocada; quando ele cobre pouco do final, o
 *      `alignFinalToBruto` cai no `alignGuidedByClips` (os deslocamentos
 *      vêm dos clipes do XML, na ordem dele, #12089).
 *   3. `aggregateRecords` + `detectPatterns`: o agregado ao longo do tempo e os
 *      padrões que se repetem em N edições, cada um com a evidência e o corpo
 *      de issue pronto (marcador `video-xml-final-pattern: {id}` para não
 *      duplicar).
 *
 * Fora do escopo (o registro diz `null`, nunca um número inventado):
 * enquadramento (faceX/eyeY/escala) e legenda queimada. A #11670 conferiu os
 * dois em frames, à mão, e não achou mudança; medir exige detecção de rosto e
 * OCR no final, que ficam para quando um padrão pedir.
 */

import {
  ALIGN_DEFAULTS,
  alignEnvelopes,
  clampFloor,
  gainUnder,
  labelRuns,
  pearsonAt,
  prefix,
  refineCuts,
  stats,
  type AlignOptions,
  type AlignRun,
} from "./video-audio-align.ts";
import type { Word } from "./video-montage.ts";

export const XML_FINAL_SCHEMA = 1;

/**
 * Vão do final sem par a partir do qual a 2ª passada procura o trecho no bruto
 * inteiro (s). Era 2; desde o #13417 o trecho inserido pelo editor de 1–2 s
 * sai sem par (`RUN_MIN_SCORE`) e precisa da busca para virar acrescentado.
 */
export const REORDER_MIN_GAP_S = 1;

/**
 * Alinhamento final × bruto que aguenta trecho reordenado (self-review da PR
 * #13205). `alignEnvelopes` é monótono (o deslocamento só cresce, pensado para
 * pausa cortada): o trecho que o editor levou para trás fica sem par, os clipes
 * dele sairiam como removidos e a ordem trocada, invisível. Aqui, como a #11670
 * fazia ("busca global quando o trecho muda"), cada vão sem par de pelo menos
 * `minGapS` é alinhado de novo sozinho contra o bruto inteiro, e os runs
 * achados entram na posição dele. Puro.
 */
export function alignWithReorder(
  finalDb: ArrayLike<number>,
  brutoDb: ArrayLike<number>,
  hopS: number,
  opts: AlignOptions = {},
  minGapS = REORDER_MIN_GAP_S,
  clips: readonly Pick<XmlClip, "srcIn" | "srcOut">[] = [],
): { runs: AlignRun[]; coverage: number; reordered: number; guide: "monotonic" | "plan-clips"; cleanup: AlignCleanupStats | null } {
  // Montagem picotada (#13197, 261104: 42 clipes em 127 s, a ordem do bruto
  // trocada desde o 2º clipe): nenhuma janela de 10 s do final é um trecho
  // contínuo do bruto, a passada monótona acha 0% e a busca dos vãos também
  // falha. Com os clipes do plan.json, os deslocamentos candidatos saem de
  // cada clipe; fica a base que cobre mais.
  const mono = alignEnvelopes(finalDb, brutoDb, hopS, opts);
  const guided = clips.length ? alignByPlanClips(finalDb, brutoDb, hopS, clips, opts) : null;
  const useGuided = guided !== null && guided.coverage > mono.coverage;
  const base = useGuided ? guided : mono;
  const durF = finalDb.length * hopS;
  const gaps: Iv[] = [];
  let cur = 0;
  for (const r of base.runs) {
    if (r.audioStart - cur >= minGapS) gaps.push({ start: cur, end: r.audioStart });
    cur = Math.max(cur, r.audioEnd);
  }
  if (durF - cur >= minGapS) gaps.push({ start: cur, end: durF });
  const extra: AlignRun[] = [];
  const floorDb = opts.floorDb ?? ALIGN_DEFAULTS.floorDb;
  for (const g of gaps) {
    const a = Math.round(g.start / hopS);
    const b = Math.min(finalDb.length, Math.round(g.end / hopS));
    if (b - a < 2) continue;
    const slice = Array.prototype.slice.call(finalDb, a, b) as number[];
    // Busca no bruto inteiro: o trecho pode estar antes do ponto onde a 1ª passada parou.
    const sub = alignEnvelopes(slice, brutoDb, hopS, { ...opts, minOffsetS: -(b - a) * hopS, maxOffsetS: brutoDb.length * hopS });
    const t0 = a * hopS;
    for (const r of sub.runs) {
      const s = r3(Math.max(g.start, r.audioStart + t0));
      const e = r3(Math.min(g.end, r.audioEnd + t0));
      const run = { audioStart: s, audioEnd: e, offset: r3(r.offset - t0) };
      // O par da busca global precisa bater com o bruto no trecho inteiro (#13417): vinheta, música ou som de fora
      // do bruto num vão de 1–2 s achava um par falso e virava "acrescentado".
      const score = e > s ? runMatchScore(finalDb, brutoDb, run, hopS, floorDb) : null;
      if (e > s && score !== null && score >= RUN_MIN_SCORE) extra.push(run);
    }
  }
  const runs = [...base.runs, ...extra].sort((x, y) => x.audioStart - y.audioStart);
  const covered = runs.reduce((n, r) => n + (r.audioEnd - r.audioStart), 0);
  return { runs, coverage: durF > 0 ? covered / durF : 0, reordered: extra.length, guide: useGuided ? "plan-clips" : "monotonic", cleanup: useGuided ? guided.cleanup : null };
}

/** Clipe do XML mais curto que isto (s) não gera deslocamento candidato: o envelope é curto demais para correlacionar. */
export const PLAN_CLIP_MIN_S = 0.4;
/** Ponta de cada lado (s) que fica fora da busca do clipe, quando ele é longo o bastante (#13417). */
export const PLAN_CLIP_INSET_S = 0.25;
/** Correlação mínima do clipe do bruto num ponto do final para virar deslocamento candidato. */
export const PLAN_CLIP_MIN_SCORE = 0.8;

/**
 * Alinhamento guiado pelos clipes do `plan.json` (#13197). Cada clipe do XML
 * (o trecho `[srcIn, srcOut)` do bruto) é procurado no final inteiro, quadro a
 * quadro (#13417: a busca grossa com refino só nos 3 maiores picos perdia o
 * clipe curto, de 0,8–1,8 s, cujo pico grosso é ambíguo, e o trecho dele no
 * final ganhava o deslocamento de outro clipe); onde ele casa, `srcIn − posição`
 * vira um deslocamento candidato. Os sub-trechos do final são rotulados entre
 * esses candidatos sem exigir ordem (o editor pode reordenar, e o próprio XML
 * já sai fora da ordem do bruto), com custo de troca para não pular por
 * ruído. A ponta que o editor estendeu fica no deslocamento do clipe (o bruto
 * continua), e o trecho de fora do XML fica sem par para a busca dos vãos.
 * Mesma saída de `alignEnvelopes` (final = "áudio", bruto = "vídeo"). Puro.
 */
export function alignByPlanClips(
  finalDb: ArrayLike<number>,
  brutoDb: ArrayLike<number>,
  hopS: number,
  clips: readonly Pick<XmlClip, "srcIn" | "srcOut">[],
  opts: AlignOptions = {},
): { runs: AlignRun[]; coverage: number; offsets: number[]; cleanup: AlignCleanupStats } {
  const o = { ...ALIGN_DEFAULTS, ...opts };
  const F = clampFloor(finalDb, o.floorDb);
  const B = clampFloor(brutoDb, o.floorDb);
  const pF = prefix(F);
  const pB = prefix(B);
  const durF = F.length * hopS;

  const found: number[] = [];
  /** O clipe que deu cada deslocamento achado: o trecho com esse deslocamento só se explica perto dele. */
  const owners: Array<{ off: number; srcIn: number; srcOut: number }> = [];
  for (const c of clips) {
    // O miolo do clipe (#13417): a ponta é onde o editor apara e onde o export põe piso (0,16 s no começo do V10 da
    // 261117), e a ponta diferente derrubava a correlação do clipe inteiro abaixo do mínimo.
    const len = c.srcOut - c.srcIn;
    const inset = len >= 2 * PLAN_CLIP_INSET_S + PLAN_CLIP_MIN_S ? PLAN_CLIP_INSET_S : 0;
    const b0 = Math.round((c.srcIn + inset) / hopS);
    const n = Math.round((len - 2 * inset) / hopS);
    if (n * hopS < PLAN_CLIP_MIN_S || b0 < 0 || b0 + n > B.length || n > F.length) continue;
    if (stats(pB, b0, n).std < o.flatStdDb) continue;
    let best = -1;
    let bestPos = -1;
    for (let f = 0; f + n <= F.length; f++) {
      const r = pearsonAt(B, pB, b0, F, pF, f, n);
      if (r > best) {
        best = r;
        bestPos = f;
      }
    }
    if (bestPos >= 0 && best >= PLAN_CLIP_MIN_SCORE) {
      const off = r3((b0 - bestPos) * hopS);
      found.push(off);
      owners.push({ off, srcIn: c.srcIn, srcOut: c.srcOut });
    }
  }
  found.sort((x, y) => x - y);
  const offsets: number[] = [];
  for (const off of found) if (!offsets.length || off - offsets[offsets.length - 1] > o.sameOffsetS) offsets.push(off);
  if (offsets.length === 0) return { runs: [], coverage: 0, offsets, cleanup: { dropped: { count: 0, s: 0 }, snappedUndecided: 0 } };

  // Rotulagem dos sub-trechos, sem ordem: dp[t][j] = s(t, j) + max(dp[t−1][j], max_i dp[t−1][i] − troca).
  const step = Math.max(1, Math.round(o.stepS / hopS));
  const sub = Math.max(2, Math.round(o.subWinS / hopS));
  const T = Math.max(1, Math.ceil(F.length / step));
  const K = offsets.length;
  const score = new Float64Array(T * K);
  const flat = new Uint8Array(T);
  for (let t = 0; t < T; t++) {
    const c = t * step;
    const a = Math.max(0, Math.min(F.length - sub, c - (sub >> 1)));
    const n = Math.min(sub, F.length - a);
    if (n < 2 || stats(pF, a, n).std < o.flatStdDb) {
      flat[t] = 1;
      continue;
    }
    for (let j = 0; j < K; j++) score[t * K + j] = pearsonAt(F, pF, a, B, pB, a + Math.round(offsets[j] / hopS), n);
  }
  const dp = new Float64Array(T * K);
  const from = new Int32Array(T * K);
  for (let j = 0; j < K; j++) dp[j] = flat[0] ? 0 : score[j];
  for (let t = 1; t < T; t++) {
    let pm = -Infinity;
    let pmJ = 0;
    for (let i = 0; i < K; i++) {
      if (dp[(t - 1) * K + i] > pm) {
        pm = dp[(t - 1) * K + i];
        pmJ = i;
      }
    }
    for (let j = 0; j < K; j++) {
      const stay = dp[(t - 1) * K + j];
      const sw = pm - o.switchPenalty;
      const s = flat[t] ? 0 : score[t * K + j];
      if (stay >= sw) {
        dp[t * K + j] = stay + s;
        from[t * K + j] = j;
      } else {
        dp[t * K + j] = sw + s;
        from[t * K + j] = pmJ;
      }
    }
  }
  let j = 0;
  for (let q = 1; q < K; q++) if (dp[(T - 1) * K + q] > dp[(T - 1) * K + j]) j = q;
  const label = new Int32Array(T);
  for (let t = T - 1; t >= 0; t--) {
    label[t] = j;
    if (t > 0) j = from[t * K + j];
  }
  const runs: AlignRun[] = [];
  const ok = (u: number) => flat[u] === 1 || score[u * K + label[u]] >= o.minSubScore;
  for (let t = 0; t < T; ) {
    if (!ok(t)) {
      t++;
      continue;
    }
    let u = t;
    while (u + 1 < T && label[u + 1] === label[t] && ok(u + 1)) u++;
    const audioStart = r3(t === 0 ? 0 : (t * step - step / 2) * hopS);
    const audioEnd = r3(u === T - 1 ? durF : ((u + 1) * step - step / 2) * hopS);
    runs.push({ audioStart, audioEnd, offset: offsets[label[t]] });
    t = u + 1;
  }
  // #13417: silêncio digital nas pontas soltas dos trechos (vinheta, card, fim do export) sai do par; lascas da
  // rotulagem saem; corte na borda do clipe quando o som não decide. O que sai e o que encaixa vai para o registro.
  const trimmed = trimDigitalSilenceEdges(runs, F, hopS, o.floorDb);
  refineCuts(trimmed, F, B, hopS, o.subWinS, o.floorDb);
  const dropped = { count: 0, s: 0 };
  const strong = (r: AlignRun) => {
    const a = Math.round(r.audioStart / hopS);
    const n = Math.round((r.audioEnd - r.audioStart) / hopS);
    return pearsonAt(F, pF, a, B, pB, a + Math.round(r.offset / hopS), n) >= STRAY_KEEP_SCORE;
  };
  // A lasca tirada solta a ponta do vizinho, que pode ter ficado sobre o piso: apara de novo.
  const clean = trimDigitalSilenceEdges(dropSlivers(trimmed, clips, { strong, dropped }), F, hopS, o.floorDb);
  refineCuts(clean, F, B, hopS, o.subWinS, o.floorDb);
  const snappedUndecided = snapCutsToClipEdges(clean, F, B, hopS, clips, o.subWinS, o.floorDb);
  // Trecho que cai quase todo fora do(s) clipe(s) que deram o deslocamento dele e cujo som não bate bem com o bruto sob o deslocamento dele é par falso
  // (#13417): a rotulagem aceita sub-trecho a partir de r 0,5, e um trecho inserido pelo editor, de fora dos clipes,
  // ganhava o deslocamento de um clipe qualquer e virava ponta estendida dele. Sem par, ele vai para a busca global
  // dos vãos. Dentro dos clipes a correlação sozinha não decide (trecho certo do V10 da 261117 deu 0,82).
  const insideShare = (r: AlignRun) => {
    const iv = { start: r.audioStart + r.offset, end: r.audioEnd + r.offset };
    const own = owners.filter((w) => Math.abs(w.off - r.offset) <= 2 * o.sameOffsetS + 1e-9).map((w) => ({ start: w.srcIn, end: w.srcOut }));
    return union(own).reduce((n, c) => n + overlap(c, iv), 0) / Math.max(1e-9, iv.end - iv.start);
  };
  const kept = clean.filter((r) => {
    if (r.audioEnd <= r.audioStart) return false;
    if (insideShare(r) >= 0.5) return true;
    const score = runMatchScore(F, B, r, hopS, o.floorDb);
    if (score === null || score >= RUN_MIN_SCORE) return true;
    dropped.count++;
    dropped.s += r.audioEnd - r.audioStart;
    return false;
  });
  const covered = kept.reduce((acc, r) => acc + (r.audioEnd - r.audioStart), 0);
  return { runs: kept, coverage: durF > 0 ? covered / durF : 0, offsets, cleanup: { dropped: { count: dropped.count, s: r3(dropped.s) }, snappedUndecided } };
}

/** Correlação mínima do trecho que cai quase todo fora dos clipes, sob o deslocamento dele (o mesmo som exportado dá perto de 1). */
export const RUN_MIN_SCORE = 0.9;

/**
 * Pura — correlação do trecho do final com o bruto sob o deslocamento dele,
 * só nos quadros com som no final (o piso digital do export não é do bruto e
 * derrubaria a correlação de um trecho certo). `null` = som de menos para
 * julgar (menos de 0,3 s, ou constante).
 */
export function runMatchScore(F: ArrayLike<number>, B: ArrayLike<number>, r: AlignRun, hopS: number, floorDb: number): number | null {
  const a = Math.round(r.audioStart / hopS);
  const b = Math.round(r.audioEnd / hopS);
  const d = Math.round(r.offset / hopS);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let n = Math.max(0, a); n < Math.min(F.length, b); n++) {
    const m = n + d;
    if (m < 0 || m >= B.length || F[n] <= floorDb) continue;
    xs.push(F[n]);
    ys.push(Math.max(floorDb, B[m]));
  }
  if (xs.length * hopS < 0.3) return null;
  return pearsonSlice(xs, 0, ys, 0, xs.length);
}

/** O que a limpeza do alinhamento plan-clips mexeu (#13417), para o registro da sequência. */
export interface AlignCleanupStats {
  /** Trechos tirados como lasca ou par falso (quantos e quantos segundos do final). */
  dropped: { count: number; s: number };
  /** Cortes encaixados na borda do clipe porque o som não decidia. */
  snappedUndecided: number;
}

const touches = (a: AlignRun | undefined, t: number) => a !== undefined && Math.abs(a.audioEnd - t) < 1e-6;
const touchesStart = (b: AlignRun | undefined, t: number) => b !== undefined && Math.abs(b.audioStart - t) < 1e-6;

/** Piso mais curto que isto (s) no começo do final fica no trecho (atraso do codificador no começo do export). */
export const DIGITAL_SILENCE_MIN_S = 0.5;

/**
 * Tira das pontas soltas de cada trecho (as que não encostam em outro trecho)
 * os quadros de silêncio digital do final (envelope no piso, #13417). A
 * rotulagem trata sub-trecho sem variação como neutro e o deixa no rótulo
 * vizinho: os 4 s de fim mudo do V10 da 261117 viravam 4 s do bruto
 * "acrescentados". O bruto da câmera sempre tem ruído de sala, então o piso
 * numa ponta solta (encostada num vão ou no começo/fim do final) é trecho de
 * fora do bruto; o piso no meio de um trecho, ou entre dois trechos que se
 * encostam, fica com eles (o corte entre os dois é do `refineCuts`). Exceção: o piso de menos de `minS` no
 * começo do final fica (o export da 261117 abre com 0,16 s de piso sobre o
 * 1º clipe, atraso do codificador, não corte do editor). Trecho todo mudo sai
 * inteiro. Devolve os que sobram, em ordem. Puro.
 */
export function trimDigitalSilenceEdges(runs: readonly AlignRun[], F: Float64Array, hopS: number, floorDb: number, minS = DIGITAL_SILENCE_MIN_S): AlignRun[] {
  const silent = (n: number) => n < 0 || n >= F.length || F[n] <= floorDb;
  const out: AlignRun[] = [];
  for (const [i, r0] of runs.entries()) {
    const r = { ...r0 };
    const a = Math.round(r.audioStart / hopS);
    const b = Math.round(r.audioEnd / hopS);
    let s = a;
    while (s < b && silent(s)) s++;
    let e = b;
    while (e > s && silent(e - 1)) e--;
    if (s >= e) continue; // trecho todo mudo: nenhum som para parear
    if (!touches(runs[i - 1], r.audioStart) && (a > 0 || (s - a) * hopS >= minS)) r.audioStart = r3(s * hopS);
    // O piso curto do começo do export que a rotulagem deixou sem par também é do 1º trecho.
    if (out.length === 0 && a > 0 && s * hopS < minS && Array.from({ length: a }, (_, n) => n).every(silent)) r.audioStart = 0;
    if (!touchesStart(runs[i + 1], r.audioEnd)) r.audioEnd = r3(e * hopS);
    out.push(r);
  }
  return out;
}

/** Trecho mais curto que isto (s) é lasca da rotulagem: sai sempre. */
export const SLIVER_S = 0.15;
/** Trecho mais curto que isto (s) cujo bruto não toca clipe do XML: par falso, sai (salvo correlação forte). */
export const STRAY_MAX_S = 0.5;
/** Correlação do trecho curto fora dos clipes a partir da qual ele fica: inserção curta de verdade, não par falso. */
export const STRAY_KEEP_SCORE = 0.9;

/**
 * Tira as lascas da rotulagem (#13417): trecho de poucos centésimos com o
 * deslocamento de outro clipe (o `refineCuts` espreme o rótulo errado de um
 * sub-trecho até quase nada, mas ele fica), e trecho curto cujo bruto não
 * encosta em nenhum clipe do XML (par falso numa respiração). Num final
 * idêntico ao XML, essas lascas davam inversão de ordem, trecho acrescentado e
 * deixavam o corte vizinho fora da borda do clipe. Os vizinhos que se
 * encostavam na lasca passam a se encostar no meio dela (o corte é refeito
 * depois); vizinhos de mesmo deslocamento viram um trecho só. O trecho curto
 * fora dos clipes com correlação forte (`opts.strong`) fica: é inserção curta
 * do editor. `opts.dropped` soma o que saiu. Puro (fora o contador).
 */
export function dropSlivers(
  runs: readonly AlignRun[],
  clips: readonly Pick<XmlClip, "srcIn" | "srcOut">[],
  opts: { sliverS?: number; strayMaxS?: number; strong?: (r: AlignRun) => boolean; dropped?: { count: number; s: number } } = {},
): AlignRun[] {
  const sliverS = opts.sliverS ?? SLIVER_S;
  const strayMaxS = opts.strayMaxS ?? STRAY_MAX_S;
  const stray = (r: AlignRun) => {
    const s = r.audioStart + r.offset;
    const e = r.audioEnd + r.offset;
    return !clips.some((c) => Math.min(e, c.srcOut + XML_FINAL_TOLERANCE_S) - Math.max(s, c.srcIn - XML_FINAL_TOLERANCE_S) > 0);
  };
  const src = runs.map((r) => ({ ...r }));
  const out: AlignRun[] = [];
  for (const [i, r0] of src.entries()) {
    const d = r0.audioEnd - r0.audioStart;
    if (d < sliverS || (d < strayMaxS && stray(r0) && !(opts.strong?.(r0) ?? false))) {
      if (opts.dropped) {
        opts.dropped.count++;
        opts.dropped.s += d;
      }
      const prev = out[out.length - 1];
      const next = src[i + 1];
      if (touches(prev, r0.audioStart) && touchesStart(next, r0.audioEnd)) {
        const mid = r3((r0.audioStart + r0.audioEnd) / 2);
        prev.audioEnd = mid;
        next.audioStart = mid;
      }
      continue;
    }
    const r = r0;
    const prev = out[out.length - 1];
    if (prev && prev.offset === r.offset && touches(prev, r.audioStart)) prev.audioEnd = r.audioEnd;
    else out.push(r);
  }
  return out;
}

/** Erro máximo por quadro (dB) no custo do corte, o mesmo teto do `refineCuts`. */
const SNAP_ERR_MAX = 30;
/**
 * Folga do encaixe na borda do clipe (dB por quadro de distância): o corte vai
 * para a borda do XML quando o erro a mais lá, somado, fica abaixo disto por
 * quadro deslocado. Na pausa os dois deslocamentos explicam o som (erro a mais
 * ≈ 0); na fala o deslocamento errado erra 10–30 dB por quadro.
 */
export const SNAP_DB_PER_FRAME = 6;
/**
 * Erro a mais máximo de UM quadro entre o corte e a borda (dB): um único
 * quadro de fala sob o deslocamento errado já barra o encaixe, mesmo que a
 * média caiba em `SNAP_DB_PER_FRAME`.
 */
export const SNAP_FRAME_MAX_DB = 15;

/**
 * Encaixa cada corte entre dois trechos na borda de um clipe do XML quando o
 * som não decide (#13417). O `refineCuts` põe o corte no mínimo do erro, mas
 * na pausa entre dois clipes os dois deslocamentos explicam o som igualmente e
 * o mínimo cai em qualquer ponto dela: o trecho de um clipe avança até 0,3 s
 * sobre o bruto vizinho, e a comparação lê ponta estendida, palavra
 * recuperada e trecho acrescentado num final idêntico ao XML. Aqui, entre as
 * bordas dos clipes que caem na janela do corte (fim de clipe sob o
 * deslocamento de antes, início sob o de depois), vale a de menor erro, se o
 * erro a mais em relação ao do corte do `refineCuts` couber em `dbPerFrame`
 * por quadro de distância E nenhum quadro entre o corte e a borda passar de
 * `frameMaxDb` a mais; fala de verdade do outro lado (ponta que o editor
 * estendeu) erra muito mais e mantém o corte do `refineCuts`. Muta só `runs`
 * (não muta `F`/`B`); trecho que fica sem duração sai depois, em quem chama.
 * Devolve quantos cortes encaixou.
 */
export function snapCutsToClipEdges(
  runs: AlignRun[],
  F: Float64Array,
  B: Float64Array,
  hopS: number,
  clips: readonly Pick<XmlClip, "srcIn" | "srcOut">[],
  subWinS: number,
  floorDb: number,
  dbPerFrame = SNAP_DB_PER_FRAME,
  frameMaxDb = SNAP_FRAME_MAX_DB,
): number {
  let snapped = 0;
  for (let i = 0; i + 1 < runs.length; i++) {
    const r1 = runs[i];
    const r2 = runs[i + 1];
    if (r1.offset === r2.offset || Math.abs(r1.audioEnd - r2.audioStart) > 1e-6) continue;
    const cut = Math.round(r1.audioEnd / hopS);
    const a = Math.max(Math.round(r1.audioStart / hopS), cut - Math.round(subWinS / hopS));
    const b = Math.min(Math.round(r2.audioEnd / hopS), cut + Math.round(subWinS / hopS));
    if (b - a < 2) continue;
    const d1 = Math.round(r1.offset / hopS);
    const d2 = Math.round(r2.offset / hopS);
    const g1 = gainUnder(F, B, Math.round(r1.audioStart / hopS), Math.round(r1.audioEnd / hopS), d1, floorDb);
    const g2 = gainUnder(F, B, Math.round(r2.audioStart / hopS), Math.round(r2.audioEnd / hopS), d2, floorDb);
    const err = (n: number, d: number, g: number) => {
      const m = n + d;
      return m < 0 || m >= B.length || n < 0 || n >= F.length ? SNAP_ERR_MAX : Math.min(SNAP_ERR_MAX, Math.abs(F[n] - B[m] - g));
    };
    // cost[c - a] = Σ_{a≤n<c} e1(n) + Σ_{c≤n<b} e2(n), para c em [a, b].
    const cost = new Float64Array(b - a + 1);
    let acc = 0;
    for (let n = a; n < b; n++) acc += err(n, d2, g2);
    cost[0] = acc;
    for (let c = a + 1; c <= b; c++) {
      acc += err(c - 1, d1, g1) - err(c - 1, d2, g2);
      cost[c - a] = acc;
    }
    const atCut = cost[cut - a];
    // O quadro que muda de lado entre o corte e a borda: erro sob o deslocamento novo menos o do antigo.
    const frameExtra = (n: number, toFirst: boolean) => (toFirst ? err(n, d1, g1) - err(n, d2, g2) : err(n, d2, g2) - err(n, d1, g1));
    const maxFrameExtra = (e: number) => {
      let m = -Infinity;
      if (e > cut) for (let n = cut; n < e; n++) m = Math.max(m, frameExtra(n, true));
      else for (let n = e; n < cut; n++) m = Math.max(m, frameExtra(n, false));
      return m;
    };
    const edges = new Set<number>();
    for (const c of clips) {
      const end = Math.round((c.srcOut - r1.offset) / hopS);
      const start = Math.round((c.srcIn - r2.offset) / hopS);
      if (end > a && end < b) edges.add(end);
      if (start > a && start < b) edges.add(start);
    }
    let snap: number | null = null;
    let snapCost = Infinity;
    for (const e of edges) {
      const extra = cost[e - a] - atCut;
      if (extra <= dbPerFrame * Math.abs(e - cut) + 1e-9 && maxFrameExtra(e) <= frameMaxDb && cost[e - a] < snapCost) {
        snap = e;
        snapCost = cost[e - a];
      }
    }
    if (snap === null || snap === cut) continue;
    const t = r3(snap * hopS);
    r1.audioEnd = Math.max(r1.audioStart, t);
    r2.audioStart = Math.min(r2.audioEnd, t);
    snapped++;
  }
  return snapped;
}

export const CLIP_GUIDE_DEFAULTS = {
  /** Pedaço máximo de clipe procurado sozinho (s): pausa tirada no meio do clipe muda o deslocamento. */
  pieceS: 1.0,
  /** Pedaço mais curto que isto não é procurado (s): envelope curto acha par falso em qualquer lugar. */
  minPieceS: 0.6,
  /** Correlação mínima de um candidato. */
  minScore: 0.75,
  /** Candidatos por pedaço (os maiores picos de correlação no final inteiro). */
  candidates: 6,
  /** Picos a menos disto (s) são o mesmo candidato. */
  peakSepS: 0.5,
  /** Folga sem custo entre o fim de um pedaço e o começo do seguinte no final (s): ponta aparada, pausa tirada, vinheta. */
  gapFreeS: 1.5,
  /** Custo por segundo de vão além da folga (clipes tirados pelo editor custam pouco; salto falso, muito). */
  gapCostPerS: 0.05,
  /** Sobreposição tolerada (s): o pedaço seguinte começando antes do fim do anterior. */
  overlapFreeS: 0.3,
  /** Custo de uma sobreposição maior: ordem trocada no final é rara, par falso é comum. */
  overlapCost: 3,
  /** Custo de deixar um pedaço sem par (o editor tirou o clipe, ou nenhum candidato serve). */
  skipCost: 0.4,
  /** Desvio-padrão (dB) abaixo do qual o pedaço é silêncio (não procurado). */
  flatStdDb: 3,
  floorDb: -80,
  /** Deslocamentos a menos disto (s) são o mesmo. */
  sameOffsetS: 0.05,
} as const;

export type ClipGuideOptions = Partial<{ [K in keyof typeof CLIP_GUIDE_DEFAULTS]: number }>;

/** Pearson entre `a[ia..ia+n)` e `b[ib..ib+n)` (já cortados no piso); `null` fora dos vetores ou com um lado constante. */
function pearsonSlice(a: ArrayLike<number>, ia: number, b: ArrayLike<number>, ib: number, n: number): number | null {
  if (n < 2 || ia < 0 || ib < 0 || ia + n > a.length || ib + n > b.length) return null;
  let sa = 0, sb = 0, qa = 0, qb = 0, d = 0;
  for (let i = 0; i < n; i++) {
    const x = a[ia + i];
    const y = b[ib + i];
    sa += x;
    sb += y;
    qa += x * x;
    qb += y * y;
    d += x * y;
  }
  const ma = sa / n;
  const mb = sb / n;
  const va = qa / n - ma * ma;
  const vb = qb / n - mb * mb;
  if (va <= 0 || vb <= 0) return null;
  return (d / n - ma * mb) / Math.sqrt(va * vb);
}

/**
 * Deslocamentos (bruto − final, s) na ordem do final, guiados pelos clipes do
 * XML (#12089). O `alignEnvelopes` acha os deslocamentos por janelas de
 * `windowS` sobre o final e supõe que eles só crescem (pausa cortada). Nenhuma
 * das duas premissas vale no XML da montagem: ele pula para frente e para trás
 * no bruto (a 261116 vai de 1427 s para 617 s e de 1705 s para 699 s) e tem
 * clipes de ~3 s, menores que a janela, que então mistura 3 ou 4 deslocamentos
 * e não acha par (23% de cobertura no horizontal da 261116, 35% na vertical).
 *
 * Aqui cada clipe vira pedaços de até `pieceS` (pausa interna tirada pelo
 * editor = pedaço seguinte com outro deslocamento), cada pedaço ganha os
 * maiores picos de correlação no final inteiro como candidatos, e uma
 * programação dinâmica escolhe um candidato (ou nenhum) por pedaço, na ordem
 * do XML: soma das correlações menos o custo dos vãos e das sobreposições
 * entre pedaços seguidos. Escolher pedaço a pedaço, pelo mais perto, não
 * serve: um par falso de clipe curto (fala parecida 19 s adiante, r 0,86)
 * levava o cursor e perdia todos os clipes seguintes. A rotulagem e o corte
 * fino ficam com o `labelRuns`. Puro.
 */
export function clipGuidedOffsets(
  finalDb: ArrayLike<number>,
  brutoDb: ArrayLike<number>,
  hopS: number,
  clips: readonly XmlClip[],
  opts: ClipGuideOptions = {},
): number[] {
  const o = { ...CLIP_GUIDE_DEFAULTS, ...opts };
  const F = Float64Array.from(finalDb, (v) => Math.max(o.floorDb, v));
  const B = Float64Array.from(brutoDb, (v) => Math.max(o.floorDb, v));
  const fr = (s: number) => Math.round(s / hopS);
  const flat = (x: Float64Array, a: number, n: number) => {
    let s = 0, q = 0;
    for (let i = a; i < a + n; i++) {
      s += x[i];
      q += x[i] * x[i];
    }
    const m = s / n;
    return Math.sqrt(Math.max(0, q / n - m * m)) < o.flatStdDb;
  };

  // Pedaços, na ordem do XML, cada um com os candidatos (início no final, quadros).
  type Cand = { t: number; r: number };
  const pieces: Array<{ ib: number; n: number; cands: Cand[] }> = [];
  for (const c of clips) {
    const dur = c.srcOut - c.srcIn;
    if (dur < o.minPieceS) continue;
    const nPieces = Math.max(1, Math.round(dur / o.pieceS));
    const len = dur / nPieces;
    for (let k = 0; k < nPieces; k++) {
      const ib = fr(c.srcIn + k * len);
      const n = fr(len);
      if (n < 2 || ib < 0 || ib + n > B.length || n > F.length || flat(B, ib, n)) continue;
      const r = new Float64Array(F.length - n + 1);
      for (let t = 0; t < r.length; t++) r[t] = pearsonSlice(B, ib, F, t, n) ?? -1;
      const peaks: Cand[] = [];
      for (let t = 0; t < r.length; t++) {
        if (r[t] < o.minScore || (t > 0 && r[t - 1] > r[t]) || (t + 1 < r.length && r[t + 1] >= r[t])) continue;
        peaks.push({ t, r: r[t] });
      }
      peaks.sort((x, y) => y.r - x.r);
      const cands: Cand[] = [];
      for (const p of peaks) {
        if (cands.length >= o.candidates) break;
        if (cands.every((q) => Math.abs(q.t - p.t) * hopS >= o.peakSepS)) cands.push(p);
      }
      if (cands.length) pieces.push({ ib, n, cands });
    }
  }
  if (pieces.length === 0) return [];

  // dp[i][c]: melhor caminho que termina com o pedaço i no candidato c (os pedaços entre o anterior escolhido e i ficam sem par).
  const trans = (prevEnd: number, t: number) => {
    const gapS = (t - prevEnd) * hopS;
    if (gapS < -o.overlapFreeS) return -o.overlapCost;
    return -o.gapCostPerS * Math.max(0, gapS - o.gapFreeS);
  };
  const dp: number[][] = [];
  const back: Array<Array<[number, number] | null>> = [];
  let bestEnd: [number, number] | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < pieces.length; i++) {
    dp.push([]);
    back.push([]);
    for (const [ci, c] of pieces[i].cands.entries()) {
      let s = c.r - o.skipCost * i; // começar aqui: os i pedaços anteriores sem par
      let from: [number, number] | null = null;
      for (let j = 0; j < i; j++) {
        const skipped = o.skipCost * (i - j - 1);
        for (const [cj, pc] of pieces[j].cands.entries()) {
          const v = dp[j][cj] - skipped + trans(pc.t + pieces[j].n, c.t) + c.r;
          if (v > s) {
            s = v;
            from = [j, cj];
          }
        }
      }
      dp[i].push(s);
      back[i].push(from);
      const total = s - o.skipCost * (pieces.length - 1 - i);
      if (total > bestScore) {
        bestScore = total;
        bestEnd = [i, ci];
      }
    }
  }
  const chosen: Array<{ ib: number; t: number }> = [];
  for (let at = bestEnd; at; at = back[at[0]][at[1]]) chosen.push({ ib: pieces[at[0]].ib, t: pieces[at[0]].cands[at[1]].t });
  chosen.reverse();

  const offsets: number[] = [];
  for (const { ib, t } of chosen) {
    const off = (ib - t) * hopS;
    const last = offsets[offsets.length - 1];
    if (last === undefined || Math.abs(off - last) > o.sameOffsetS) offsets.push(r3(off));
  }
  return offsets;
}

/**
 * Alinhamento final × bruto guiado pelo XML (#12089): `clipGuidedOffsets` dá
 * os deslocamentos na ordem do final e o `labelRuns` dá os trechos. Mesmo
 * formato do `alignWithReorder` (o `reordered` é 0: a ordem do XML já está nos
 * candidatos).
 */
export function alignGuidedByClips(
  finalDb: ArrayLike<number>,
  brutoDb: ArrayLike<number>,
  hopS: number,
  clips: readonly XmlClip[],
  opts: AlignOptions = {},
  guide: ClipGuideOptions = {},
): { runs: AlignRun[]; coverage: number; reordered: number } {
  const offsets = clipGuidedOffsets(finalDb, brutoDb, hopS, clips, guide);
  const { runs, coverage } = labelRuns(finalDb, brutoDb, hopS, offsets, opts);
  return { runs, coverage, reordered: 0 };
}

/**
 * O alinhamento que a comparação usa (#12089, #13197), em duas camadas, na
 * ordem mais barata primeiro:
 *   1. `alignWithReorder` com os clipes do XML: o por janela (monótono) e o
 *      `alignByPlanClips` (#13197) competem e fica a base que cobre mais; os
 *      vãos sem par vão para a busca global. `guide` diz qual base valeu.
 *   2. Só se essa camada cobrir menos que `minCoverage` do final, o
 *      `alignGuidedByClips` (#12089: pedaços de clipe + programação dinâmica na
 *      ordem do XML + `labelRuns`); fica o de maior cobertura.
 * `method` diz qual camada valeu ("janela" = a 1ª, inclusive quando a base
 * dela foi a dos clipes do plan.json) e `windowCoverage` guarda a cobertura da
 * 1ª camada, para o registro explicar a troca.
 */
export function alignFinalToBruto(
  finalDb: ArrayLike<number>,
  brutoDb: ArrayLike<number>,
  hopS: number,
  clips: readonly XmlClip[],
  opts: AlignOptions,
  minCoverage: number,
): {
  runs: AlignRun[];
  coverage: number;
  reordered: number;
  method: "janela" | "guiado-xml";
  guide: "monotonic" | "plan-clips";
  windowCoverage: number;
  /** Limpeza do plan-clips (#13417); `null` quando a base não foi a dos clipes do plan.json. */
  cleanup: AlignCleanupStats | null;
} {
  const win = alignWithReorder(finalDb, brutoDb, hopS, opts, REORDER_MIN_GAP_S, clips);
  const first = { runs: win.runs, coverage: win.coverage, reordered: win.reordered, guide: win.guide, method: "janela" as const, windowCoverage: win.coverage, cleanup: win.cleanup };
  if (win.coverage >= minCoverage || clips.length === 0) return first;
  const guided = alignGuidedByClips(finalDb, brutoDb, hopS, clips, opts);
  return guided.coverage > win.coverage
    ? { ...guided, method: "guiado-xml", guide: win.guide, windowCoverage: win.coverage, cleanup: null }
    : first;
}

/** Abaixo disto (s) a diferença é ruído do alinhamento (a #11670 media ±0,05–0,08 s). */
export const XML_FINAL_TOLERANCE_S = 0.1;
/** Clipe com menos que esta fração no final conta como removido. */
export const REMOVED_CLIP_MAX_FRACTION = 0.2;
/** Token mínimo de semelhança (Jaccard) para um trecho acrescentado ser a outra tomada de um clipe removido. */
export const TAKE_SWAP_MIN_JACCARD = 0.5;
/**
 * Posição do clipe no final (#13417): conta o trecho que leva pelo menos
 * min(isto, metade do maior pedaço do clipe) segundos dele. Lasca do
 * alinhamento fica de fora; clipe curto, partido em dois por pausa tirada,
 * ainda conta os dois pedaços.
 */
export const ORDER_MIN_SHARE_S = 0.3;

export interface XmlClip {
  /** Posição do clipe na sequência do XML (0 = primeiro). */
  index: number;
  /** No bruto, segundos. */
  srcIn: number;
  srcOut: number;
}

/** Um trecho do final com par no bruto: `[finalStart, finalEnd)` no final = `[brutoStart, brutoEnd)` no bruto. */
export interface FinalSpan {
  finalStart: number;
  finalEnd: number;
  brutoStart: number;
  brutoEnd: number;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const ms = (s: number) => Math.round(s * 1000);

/** Os runs do alinhamento (final = "áudio", bruto = "vídeo") como trechos no bruto. */
export function finalSpansFromRuns(runs: readonly AlignRun[]): FinalSpan[] {
  return runs
    .filter((r) => r.audioEnd > r.audioStart)
    .map((r) => ({ finalStart: r3(r.audioStart), finalEnd: r3(r.audioEnd), brutoStart: r3(r.audioStart + r.offset), brutoEnd: r3(r.audioEnd + r.offset) }));
}

interface Iv {
  start: number;
  end: number;
}

function union(ivs: readonly Iv[]): Iv[] {
  const s = [...ivs].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Iv[] = [];
  for (const i of s) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

function overlap(a: Iv, b: Iv): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/** `a` menos a união de `cut`, pedaços em ordem. */
function subtract(a: readonly Iv[], cut: readonly Iv[]): Iv[] {
  const c = union(cut);
  const out: Iv[] = [];
  for (const iv of union(a)) {
    let cur = iv.start;
    for (const x of c) {
      if (x.end <= cur || x.start >= iv.end) continue;
      if (x.start > cur) out.push({ start: cur, end: x.start });
      cur = Math.max(cur, x.end);
    }
    if (cur < iv.end) out.push({ start: cur, end: iv.end });
  }
  return out;
}

const within = (t: number, ivs: readonly Iv[]) => ivs.some((i) => t >= i.start && t < i.end);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1),
  );
}

export function jaccard(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

function wordsIn(words: readonly Word[], iv: Iv): Word[] {
  return words.filter((w) => {
    const mid = (w.start + w.end) / 2;
    return mid >= iv.start && mid < iv.end;
  });
}

const textOf = (ws: readonly Word[]) => ws.map((w) => w.text.trim()).filter(Boolean).join(" ");

export interface ClipComparison {
  index: number;
  srcIn: number;
  srcOut: number;
  status: "kept" | "removed";
  /** Positivo = o editor estendeu a ponta (usou mais bruto), negativo = aparou. `null` no removido. */
  headMs: number | null;
  tailMs: number | null;
  /** Pausas do bruto dentro do clipe que o final pulou. */
  internalPauses: Array<{ start: number; end: number; ms: number }>;
  /** A ponta encostou no clipe vizinho do XML: o editor juntou os dois. */
  joinedHead?: true;
  joinedTail?: true;
  /** Início do clipe no final (s), para a ordem. */
  finalStart: number | null;
  touched: boolean;
}

export interface AddedSpan {
  brutoStart: number;
  brutoEnd: number;
  text: string;
  /** Mesma fala de um clipe removido do XML: a outra tomada. */
  swapOf?: number;
}

export interface SequenceComparison {
  clips: ClipComparison[];
  added: AddedSpan[];
  takeSwaps: Array<{ clip: number; xml: { start: number; end: number }; final: { start: number; end: number }; similarity: number }>;
  /** Pares de clipes mantidos em ordem trocada no final. */
  orderInversions: number;
  wordsRecovered: Array<{ text: string; start: number; end: number }>;
  wordsRemoved: number;
  /** Segundos do final sem par no bruto (vinheta, cards, capa, ou trecho fora do alinhamento). */
  finalUnpairedS: number;
  summary: SequenceSummary;
}

export interface SequenceSummary {
  clips: number;
  clipsRemoved: number;
  clipsTouched: number;
  /** Médias sobre os clipes mantidos (ms), sem as pontas emendadas ao vizinho; `null` sem nenhuma. */
  headMeanMs: number | null;
  tailMeanMs: number | null;
  headExtended: number;
  headTrimmed: number;
  tailExtended: number;
  tailTrimmed: number;
  /** Emendas: clipes que o editor juntou ao seguinte do XML (a ponta deles fica fora das médias). */
  joins: number;
  internalPausesRemoved: number;
  internalPausesMs: number;
  added: number;
  takeSwaps: number;
  orderInversions: number;
  wordsRecovered: number;
  wordsRemoved: number;
}

/**
 * Compara os clipes do XML com os trechos do final no tempo do bruto. Puro.
 * `durationFinalS` só entra no `finalUnpairedS`.
 */
export function compareSequence(input: {
  clips: readonly XmlClip[];
  spans: readonly FinalSpan[];
  words?: readonly Word[];
  finalDurationS: number;
  toleranceS?: number;
}): SequenceComparison {
  const tol = input.toleranceS ?? XML_FINAL_TOLERANCE_S;
  const words = input.words ?? [];
  const clips = [...input.clips].sort((a, b) => a.index - b.index);
  const xmlIvs = clips.map((c) => ({ start: c.srcIn, end: c.srcOut }));
  const used = union(input.spans.map((s) => ({ start: s.brutoStart, end: s.brutoEnd })));
  const byBruto = [...clips].sort((a, b) => a.srcIn - b.srcIn);

  const out: ClipComparison[] = [];
  for (const c of clips) {
    const iv = { start: c.srcIn, end: c.srcOut };
    const len = iv.end - iv.start;
    const touching = input.spans.filter((s) => overlap({ start: s.brutoStart, end: s.brutoEnd }, iv) > 0);
    const covered = used.reduce((n, u) => n + overlap(u, iv), 0);
    if (len <= 0 || touching.length === 0 || covered < Math.max(REMOVED_CLIP_MAX_FRACTION * len, tol)) {
      out.push({ index: c.index, srcIn: c.srcIn, srcOut: c.srcOut, status: "removed", headMs: null, tailMs: null, internalPauses: [], finalStart: null, touched: true });
      continue;
    }
    const pos = byBruto.indexOf(c);
    const prevBound = pos > 0 ? byBruto[pos - 1].srcOut : -Infinity;
    const nextBound = pos < byBruto.length - 1 ? byBruto[pos + 1].srcIn : Infinity;
    const usedHere = used.filter((u) => overlap(u, iv) > 0);
    const lo = usedHere[0].start;
    const hi = usedHere[usedHere.length - 1].end;
    const headStart = Math.max(lo, prevBound);
    const tailEnd = Math.min(hi, nextBound);
    const headS = c.srcIn - headStart;
    const tailS = tailEnd - c.srcOut;
    const internalPauses = subtract([iv], used)
      .filter((g) => g.start > iv.start + 1e-9 && g.end < iv.end - 1e-9 && g.end - g.start > tol)
      .map((g) => ({ start: r3(g.start), end: r3(g.end), ms: ms(g.end - g.start) }));
    const headMs = Math.abs(headS) > tol ? ms(headS) : 0;
    const tailMs = Math.abs(tailS) > tol ? ms(tailS) : 0;
    // Início no final pelos trechos que levam uma parte real do clipe (#13417): uma lasca de alinhamento de poucos
    // centésimos em outro ponto do final puxava o mínimo para lá e virava inversão de ordem num final idêntico.
    const share = (s: FinalSpan) => overlap({ start: s.brutoStart, end: s.brutoEnd }, iv);
    const main = touching.filter((s) => share(s) >= Math.min(ORDER_MIN_SHARE_S, 0.5 * Math.max(...touching.map(share))));
    const finalStart = Math.min(...main.map((s) => s.finalStart + Math.max(0, c.srcIn - s.brutoStart)));
    out.push({
      index: c.index,
      srcIn: c.srcIn,
      srcOut: c.srcOut,
      status: "kept",
      headMs,
      tailMs,
      internalPauses,
      ...(lo < prevBound - 1e-9 && pos > 0 ? { joinedHead: true as const } : {}),
      ...(hi > nextBound + 1e-9 && pos < byBruto.length - 1 ? { joinedTail: true as const } : {}),
      finalStart: r3(finalStart),
      touched: headMs !== 0 || tailMs !== 0 || internalPauses.length > 0,
    });
  }

  // O que o final usa fora de todo clipe e longe das pontas: trecho acrescentado.
  const xmlGrown = union(xmlIvs.map((i) => ({ start: i.start - tol, end: i.end + tol })));
  const extras = subtract(used, xmlIvs).filter((p) => p.end - p.start > tol);
  const added: AddedSpan[] = [];
  const takeSwaps: SequenceComparison["takeSwaps"] = [];
  const removed = out.filter((c) => c.status === "removed");
  for (const p of extras) {
    const adjacent = xmlGrown.some((g) => (p.start >= g.start && p.start <= g.end) || (p.end >= g.start && p.end <= g.end));
    if (adjacent) continue; // ponta estendida: já está no headMs/tailMs
    const text = textOf(wordsIn(words, p));
    let best: { clip: ClipComparison; sim: number } | null = null;
    for (const rc of removed) {
      const sim = jaccard(text, textOf(wordsIn(words, { start: rc.srcIn, end: rc.srcOut })));
      if (sim >= TAKE_SWAP_MIN_JACCARD && (!best || sim > best.sim)) best = { clip: rc, sim };
    }
    added.push({ brutoStart: r3(p.start), brutoEnd: r3(p.end), text, ...(best ? { swapOf: best.clip.index } : {}) });
    if (best) takeSwaps.push({ clip: best.clip.index, xml: { start: best.clip.srcIn, end: best.clip.srcOut }, final: { start: r3(p.start), end: r3(p.end) }, similarity: Math.round(best.sim * 100) / 100 });
  }

  const kept = out.filter((c) => c.status === "kept" && c.finalStart !== null);
  let orderInversions = 0;
  for (let i = 0; i < kept.length; i++) for (let j = i + 1; j < kept.length; j++) if ((kept[i].finalStart as number) > (kept[j].finalStart as number)) orderInversions++;

  // Só a palavra das pontas estendidas conta como recuperada (o sinal da #13194): a fala da outra tomada e a dos
  // trechos acrescentados já sai em `takeSwaps`/`added` e não é palavra comida pelo corte (self-review da PR #13205).
  const addedIvs = added.map((a) => ({ start: a.brutoStart, end: a.brutoEnd }));
  const wordsRecovered = words
    .filter((w) => {
      const mid = (w.start + w.end) / 2;
      return within(mid, used) && !within(mid, xmlIvs) && !within(mid, addedIvs) && w.text.trim() !== "";
    })
    .map((w) => ({ text: w.text.trim(), start: r3(w.start), end: r3(w.end) }));
  const wordsRemoved = words.filter((w) => {
    const mid = (w.start + w.end) / 2;
    return within(mid, xmlIvs) && !within(mid, used) && w.text.trim() !== "";
  }).length;

  const pairedS = input.spans.reduce((n, s) => n + Math.max(0, s.finalEnd - s.finalStart), 0);
  const keptClips = out.filter((c) => c.status === "kept");
  // Ponta emendada ao clipe vizinho mede o vão inteiro até ele, não padding: fica fora da média e das contagens de
  // ponta, e entra à parte em `joins` (self-review da PR #13205).
  const heads = keptClips.filter((c) => !c.joinedHead).map((c) => c.headMs as number);
  const tails = keptClips.filter((c) => !c.joinedTail).map((c) => c.tailMs as number);
  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const summary: SequenceSummary = {
    clips: out.length,
    clipsRemoved: out.length - keptClips.length,
    clipsTouched: out.filter((c) => c.touched).length,
    headMeanMs: mean(heads),
    tailMeanMs: mean(tails),
    headExtended: heads.filter((x) => x > 0).length,
    headTrimmed: heads.filter((x) => x < 0).length,
    tailExtended: tails.filter((x) => x > 0).length,
    tailTrimmed: tails.filter((x) => x < 0).length,
    joins: keptClips.filter((c) => c.joinedTail).length,
    internalPausesRemoved: keptClips.reduce((n, c) => n + c.internalPauses.length, 0),
    internalPausesMs: keptClips.reduce((n, c) => n + c.internalPauses.reduce((m, p) => m + p.ms, 0), 0),
    added: added.filter((a) => a.swapOf === undefined).length,
    takeSwaps: takeSwaps.length,
    orderInversions,
    wordsRecovered: wordsRecovered.length,
    wordsRemoved,
  };
  return { clips: out, added, takeSwaps, orderInversions, wordsRecovered, wordsRemoved, finalUnpairedS: r3(Math.max(0, input.finalDurationS - pairedS)), summary };
}

// ── Registro por edição ──────────────────────────────────────────────────

/**
 * `v2` (#13417): alinhamento plan-clips com busca quadro a quadro, limpeza de
 * lascas e de silêncio digital e encaixe do corte na borda do clipe. Registro
 * `v1` é ruído do alinhamento antigo e volta a ser medido (`currentDoneSequences`).
 */
export type RecordMethod = "audio-envelope-align-v1" | "audio-envelope-align-v2" | "11670-manual";
/** Método das medições automáticas de agora. */
export const CURRENT_METHOD: RecordMethod = "audio-envelope-align-v2";

export interface LoudnessSnapshot {
  inputI: number;
  /** `null` quando a fonte não mediu (registro importado da #11670). */
  inputTp: number | null;
}

/** Uma sequência comparada. Campos `null` = não medido (nunca zero inventado). */
export interface SequenceRecord {
  key: string;
  /** Método desta sequência; ausente = o do registro (`EditionRecord.method`). */
  method?: RecordMethod;
  target: string | null;
  finalFile: string | null;
  /** `<sequence id>` versionado do XML (`xmlVersions`, `_V{n}`), quando o plan.json o tem. */
  xmlVersion: string | null;
  xmlDurationS: number | null;
  finalDurationS: number | null;
  /** Fração do final com par no bruto. */
  coverage: number | null;
  summary: Partial<SequenceSummary>;
  loudness: LoudnessSnapshot | null;
  /** Fora do escopo do v1 (ver docstring do módulo). */
  framing: null;
  captions: null;
  /** Detalhe (clipes, acrescentados, palavras); ausente no registro importado da #11670. */
  detail?: Omit<SequenceComparison, "summary">;
  notes?: string[];
  /** Trechos que a limpeza do alinhamento tirou (#13417): quantos e quantos segundos do final. */
  alignDropped?: { count: number; s: number };
  /** Cortes encaixados na borda do clipe porque o som não decidia (#13417). */
  snappedUndecided?: number;
  /** Medição de método anterior cuja remedição falhou (a sequência fica com os números antigos), #13417. */
  remeasureFailed?: RemeasureFailure;
}

export interface EditionRecord {
  schema: typeof XML_FINAL_SCHEMA;
  edition: string;
  method: RecordMethod;
  generatedAt: string;
  sequences: SequenceRecord[];
  /** Sequências do plano sem par (sem final, sem bruto local, alinhamento ruim). */
  skipped: Array<{ key: string; reason: string }>;
  source?: string;
}

/**
 * Junta um registro novo ao anterior da mesma edição: sequência medida de
 * novo substitui a antiga, as outras ficam. Registro importado da #11670 nunca
 * substitui uma medição automática. Puro.
 */
export function mergeEditionRecord(prev: EditionRecord | null, next: EditionRecord): EditionRecord {
  const stamp = (r: EditionRecord) => r.sequences.map((s) => ({ ...s, method: s.method ?? r.method }));
  if (!prev) return { ...next, sequences: stamp(next) };
  const prevSeqs = stamp(prev);
  // Sequência medida automaticamente nunca é substituída pelo importado da #11670.
  const nextSeqs = stamp(next).filter((s) => !(s.method === "11670-manual" && prevSeqs.some((p) => p.key === s.key && p.method !== "11670-manual")));
  const keys = new Set(nextSeqs.map((s) => s.key));
  // Remedição (#13417): sequência de método automático anterior que a rodada nova pulou guarda o motivo e a contagem.
  for (const ps of prevSeqs) {
    if (keys.has(ps.key) || ps.method === CURRENT_METHOD || ps.method === "11670-manual") continue;
    const sk = next.skipped.find((x) => x.key === ps.key);
    if (sk) ps.remeasureFailed = { at: next.generatedAt, reason: sk.reason, count: (ps.remeasureFailed?.count ?? 0) + 1 };
  }
  const sequences = [...prevSeqs.filter((s) => !keys.has(s.key)), ...nextSeqs].sort((a, b) => a.key.localeCompare(b.key));
  const measured = new Set(sequences.map((s) => s.key));
  const skipped = [...prev.skipped.filter((s) => !keys.has(s.key) && !next.skipped.some((n) => n.key === s.key)), ...next.skipped].filter((s) => !measured.has(s.key));
  // Sem nenhuma sequência medida, o método é o do registro novo: a rodada automática que só pulou não vira "#11670".
  const auto: RecordMethod[] = sequences.map((s) => s.method).filter((m) => m !== "11670-manual");
  const method: RecordMethod =
    sequences.length === 0 ? next.method : auto.length === 0 ? "11670-manual" : auto.includes(CURRENT_METHOD) ? CURRENT_METHOD : (auto[0] as RecordMethod);
  return { ...next, method, generatedAt: next.method === method ? next.generatedAt : prev.generatedAt, sequences, skipped };
}

// ── Agregado e padrões ───────────────────────────────────────────────────

export interface AggregateRow {
  edition: string;
  key: string;
  method: RecordMethod;
  xmlDurationS: number | null;
  finalDurationS: number | null;
  clips: number | null;
  clipsRemoved: number | null;
  touchedPct: number | null;
  headMeanMs: number | null;
  tailMeanMs: number | null;
  internalPausesRemoved: number | null;
  takeSwaps: number | null;
  orderInversions: number | null;
  wordsRecovered: number | null;
  loudnessI: number | null;
}

export interface Aggregate {
  rows: AggregateRow[];
  editions: number;
  /** Médias ao longo do tempo (sobre as linhas que mediram o campo). */
  totals: {
    headMeanMs: number | null;
    tailMeanMs: number | null;
    touchedPct: number | null;
    wordsRecovered: number;
    wordsRecoveredPerSequence: number | null;
    internalPausesPerSequence: number | null;
  };
}

const num = (x: number | null | undefined): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

export function aggregateRecords(records: readonly EditionRecord[]): Aggregate {
  const rows: AggregateRow[] = [];
  for (const r of [...records].sort((a, b) => a.edition.localeCompare(b.edition))) {
    for (const s of r.sequences) {
      const clips = num(s.summary.clips);
      const touched = num(s.summary.clipsTouched);
      rows.push({
        edition: r.edition,
        key: s.key,
        method: s.method ?? r.method,
        xmlDurationS: num(s.xmlDurationS),
        finalDurationS: num(s.finalDurationS),
        clips,
        clipsRemoved: num(s.summary.clipsRemoved),
        touchedPct: clips && touched !== null ? Math.round((touched / clips) * 100) : null,
        headMeanMs: num(s.summary.headMeanMs),
        tailMeanMs: num(s.summary.tailMeanMs),
        internalPausesRemoved: num(s.summary.internalPausesRemoved),
        takeSwaps: num(s.summary.takeSwaps),
        orderInversions: num(s.summary.orderInversions),
        wordsRecovered: num(s.summary.wordsRecovered),
        loudnessI: num(s.loudness?.inputI),
      });
    }
  }
  const avg = (xs: Array<number | null>) => {
    const v = xs.filter((x): x is number => x !== null);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const recovered = rows.map((r) => r.wordsRecovered).filter((x): x is number => x !== null);
  const pauses = rows.map((r) => r.internalPausesRemoved).filter((x): x is number => x !== null);
  return {
    rows,
    editions: new Set(rows.map((r) => r.edition)).size,
    totals: {
      headMeanMs: avg(rows.map((r) => r.headMeanMs)),
      tailMeanMs: avg(rows.map((r) => r.tailMeanMs)),
      touchedPct: avg(rows.map((r) => r.touchedPct)),
      wordsRecovered: recovered.reduce((a, b) => a + b, 0),
      wordsRecoveredPerSequence: recovered.length ? Math.round((recovered.reduce((a, b) => a + b, 0) / recovered.length) * 10) / 10 : null,
      internalPausesPerSequence: pauses.length ? Math.round((pauses.reduce((a, b) => a + b, 0) / pauses.length) * 10) / 10 : null,
    },
  };
}

export interface PatternRule {
  id: string;
  title: string;
  priority: "P1" | "P2" | "P3";
  /** Edições distintas em que a regra precisa bater. */
  minEditions: number;
  /** A linha conta para o padrão; `null` = a linha não mediu o campo. */
  hit(row: AggregateRow): boolean | null;
  /** Valor mostrado na evidência. */
  value(row: AggregateRow): string;
  /** O que mudar no gerador (vai no corpo da issue). */
  suggestion: string;
  /**
   * Issue que já acompanha o padrão: enquanto aberta, a evidência vai como
   * comentário nela em vez de abrir outra (não duplicar a #13194, a #12089).
   */
  trackingIssue?: number;
}

const fmt = (x: number | null, unit = "") => (x === null ? "n/d" : `${x > 0 ? "+" : ""}${x}${unit}`);

/**
 * Padrões vigiados. Limiares conservadores de propósito: a issue sai só com o
 * mesmo sinal em várias edições (a #11670 abria issue com 2+). Ajuste de
 * limiar é decisão a registrar aqui, com a medição que a motivou.
 */
export const PATTERN_RULES: readonly PatternRule[] = [
  {
    id: "palavras-recuperadas",
    title: "video-montagem: o editor recupera palavras que o XML cortou",
    priority: "P1",
    minEditions: 2,
    hit: (r) => (r.wordsRecovered === null ? null : r.wordsRecovered >= 1),
    value: (r) => `${r.wordsRecovered} palavra(s)`,
    suggestion: "Rever a folga e o refino das pontas dos clipes (#13194): a palavra que o editor recoloca estava fora do corte do XML.",
    trackingIssue: 13194,
  },
  {
    id: "ponta-saida-estendida",
    title: "video-montagem: o editor estende a ponta da saída dos clipes",
    priority: "P3",
    minEditions: 3,
    hit: (r) => (r.tailMeanMs === null ? null : r.tailMeanMs >= 80),
    value: (r) => fmt(r.tailMeanMs, " ms"),
    suggestion: "Aumentar o padding da saída do clipe no build pela média medida (parâmetro com critério mecânico).",
  },
  {
    id: "ponta-entrada-estendida",
    title: "video-montagem: o editor estende a ponta da entrada dos clipes",
    priority: "P3",
    minEditions: 3,
    hit: (r) => (r.headMeanMs === null ? null : r.headMeanMs >= 80),
    value: (r) => fmt(r.headMeanMs, " ms"),
    suggestion: "Aumentar o padding da entrada do clipe no build pela média medida.",
  },
  {
    id: "cabeca-aparada",
    title: "video-montagem: o editor apara a cabeça dos clipes",
    priority: "P3",
    minEditions: 3,
    hit: (r) => (r.headMeanMs === null ? null : r.headMeanMs <= -150),
    value: (r) => fmt(r.headMeanMs, " ms"),
    suggestion: "Reduzir a folga da entrada (respiração/hesitação antes da fala), como na #12089.",
    trackingIssue: 12089,
  },
  {
    id: "pausa-interna-removida",
    title: "video-montagem: o editor remove pausas dentro dos clipes",
    priority: "P3",
    minEditions: 3,
    hit: (r) => (r.internalPausesRemoved === null ? null : r.internalPausesRemoved >= 3),
    value: (r) => `${r.internalPausesRemoved} pausa(s)`,
    suggestion: "Rever o limiar de pausa interna do corte por fala (#11753/#12089).",
    trackingIssue: 12089,
  },
  {
    id: "clipes-removidos",
    title: "video-montagem: o editor tira frases inteiras do XML",
    priority: "P3",
    minEditions: 2,
    hit: (r) => (r.clips === null || r.clipsRemoved === null || r.clips === 0 ? null : r.clipsRemoved / r.clips >= 0.2),
    value: (r) => `${r.clipsRemoved}/${r.clips} clipes`,
    suggestion: "Duração-alvo por sequência ou critério de corte de frase (#11757). Mudança de comportamento: issue, não PR automático.",
  },
  {
    id: "tomada-trocada",
    title: "video-montagem: o editor troca a tomada escolhida pelo XML",
    priority: "P3",
    minEditions: 2,
    hit: (r) => (r.takeSwaps === null ? null : r.takeSwaps >= 1),
    value: (r) => `${r.takeSwaps} troca(s)`,
    suggestion: "Rever o critério de tomada (#11754). Mudança de comportamento: issue, não PR automático.",
  },
];

export interface DetectedPattern {
  id: string;
  title: string;
  priority: PatternRule["priority"];
  editions: string[];
  evidence: Array<{ edition: string; key: string; value: string }>;
  suggestion: string;
  trackingIssue?: number;
  /** Hash estável da evidência: comentar de novo só quando ela muda. */
  evidenceHash: string;
}

/** FNV-1a 32 bits, hex: hash curto e determinístico, sem depender de crypto. */
export function stableHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * `requireAuto` (default `true`): o padrão só sai com pelo menos uma edição
 * medida pela tarefa. Os números importados da #11670 reforçam a evidência,
 * mas sozinhos não reabrem o que a própria #11670 já triou (ela abriu as
 * issues dos padrões dela e registrou o resto sem issue).
 */
export function detectPatterns(agg: Aggregate, rules: readonly PatternRule[] = PATTERN_RULES, opts: { requireAuto?: boolean } = {}): DetectedPattern[] {
  const requireAuto = opts.requireAuto ?? true;
  const out: DetectedPattern[] = [];
  for (const rule of rules) {
    const hits = agg.rows.filter((r) => rule.hit(r) === true);
    const editions = [...new Set(hits.map((r) => r.edition))].sort();
    if (editions.length < rule.minEditions) continue;
    if (requireAuto && !hits.some((r) => r.method !== "11670-manual")) continue;
    const evidence = hits.map((r) => ({ edition: r.edition, key: r.key, value: rule.value(r) }));
    out.push({
      id: rule.id,
      title: rule.title,
      priority: rule.priority,
      editions,
      evidence,
      suggestion: rule.suggestion,
      ...(rule.trackingIssue ? { trackingIssue: rule.trackingIssue } : {}),
      evidenceHash: stableHash(JSON.stringify(evidence)),
    });
  }
  return out;
}

export const PATTERN_MARKER = (id: string) => `<!-- video-xml-final-pattern: ${id} -->`;

export function patternIssueBody(p: DetectedPattern, extra: { details?: Map<string, string[]> } = {}): string {
  const lines = [
    PATTERN_MARKER(p.id),
    "## Padrão",
    "",
    `Achado da comparação recorrente XML gerado × vídeo publicado (#13196): aparece em ${p.editions.length} edição(ões) (${p.editions.join(", ")}).`,
    "",
    "| Edição | Sequência | Medida |",
    "|---|---|---|",
    ...p.evidence.map((e) => `| ${e.edition} | ${e.key} | ${e.value} |`),
    "",
  ];
  const details = extra.details?.get(p.id);
  if (details?.length) lines.push("## Exemplos (tempo no bruto)", "", ...details.map((d) => `- ${d}`), "");
  lines.push(
    "## O que mudar",
    "",
    p.suggestion,
    "",
    `Prioridade ${p.priority}: sugerida pela regra \`${p.id}\` de \`scripts/lib/diaria/video-xml-vs-final.ts\` (PATTERN_RULES).`,
    "",
    "Registros por edição em `data/video-xml-vs-final/`; agregado em `data/video-xml-vs-final/aggregate.json`.",
  );
  return lines.join("\n");
}

export function patternCommentBody(p: DetectedPattern): string {
  return [
    `<!-- video-xml-final-evidence: ${p.evidenceHash} -->`,
    `Evidência atualizada pela comparação recorrente (#13196): ${p.editions.length} edição(ões).`,
    "",
    "| Edição | Sequência | Medida |",
    "|---|---|---|",
    ...p.evidence.map((e) => `| ${e.edition} | ${e.key} | ${e.value} |`),
  ].join("\n");
}

/** Exemplos com tempo no bruto, por padrão, tirados do detalhe dos registros. */
export function patternExamples(records: readonly EditionRecord[], max = 8): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const push = (id: string, line: string) => {
    const xs = out.get(id) ?? [];
    if (xs.length < max) xs.push(line);
    out.set(id, xs);
  };
  for (const r of records) {
    for (const s of r.sequences) {
      const d = s.detail;
      if (!d) continue;
      for (const w of d.wordsRecovered) push("palavras-recuperadas", `${r.edition} ${s.key}: "${w.text}" em ${w.start.toFixed(2)}–${w.end.toFixed(2)} s`);
      for (const t of d.takeSwaps) push("tomada-trocada", `${r.edition} ${s.key}: clipe ${t.clip} (${t.xml.start}–${t.xml.end} s) trocado por ${t.final.start}–${t.final.end} s`);
      for (const c of d.clips) {
        if (c.status === "removed") push("clipes-removidos", `${r.edition} ${s.key}: clipe ${c.index} (${c.srcIn}–${c.srcOut} s) fora do final`);
        else {
          if ((c.tailMs ?? 0) > 0) push("ponta-saida-estendida", `${r.edition} ${s.key}: clipe ${c.index} saída ${c.srcOut} s, +${c.tailMs} ms`);
          if ((c.headMs ?? 0) > 0) push("ponta-entrada-estendida", `${r.edition} ${s.key}: clipe ${c.index} entrada ${c.srcIn} s, +${c.headMs} ms`);
          if ((c.headMs ?? 0) < 0) push("cabeca-aparada", `${r.edition} ${s.key}: clipe ${c.index} entrada ${c.srcIn} s, ${c.headMs} ms`);
          for (const p of c.internalPauses) push("pausa-interna-removida", `${r.edition} ${s.key}: clipe ${c.index}, pausa ${p.start}–${p.end} s (${p.ms} ms)`);
        }
      }
    }
  }
  return out;
}

// ── Relatório ────────────────────────────────────────────────────────────

const cell = (x: number | null, suffix = "") => (x === null ? "n/d" : `${x}${suffix}`);

export function renderReport(input: {
  agg: Aggregate;
  patterns: readonly DetectedPattern[];
  skipped: ReadonlyArray<{ edition: string; key: string; reason: string }>;
  generatedAt: string;
  /** Remedições que desistiram (#13417): os números dessas sequências são do método anterior. */
  gaveUp?: ReturnType<typeof remeasureGaveUp>;
}): string {
  const { agg } = input;
  const lines = [
    `# Vídeo: XML gerado × final publicado`,
    "",
    `Gerado em ${input.generatedAt}. ${agg.editions} edição(ões), ${agg.rows.length} sequência(s) comparada(s) (#13196, #13197).`,
    "",
    "## Ao longo do tempo",
    "",
    `- Ponta da entrada, média: ${cell(agg.totals.headMeanMs, " ms")}; da saída: ${cell(agg.totals.tailMeanMs, " ms")} (positivo = o editor estendeu).`,
    `- Clipes mexidos: ${cell(agg.totals.touchedPct, "%")} em média.`,
    `- Palavras recuperadas pelo editor: ${agg.totals.wordsRecovered} no total, ${cell(agg.totals.wordsRecoveredPerSequence)} por sequência (deve cair com #13194).`,
    `- Pausas internas removidas: ${cell(agg.totals.internalPausesPerSequence)} por sequência.`,
    "",
    "## Por edição",
    "",
    "| Edição | Sequência | Método | XML | Final | Clipes fora | Mexidos | Entrada | Saída | Pausas | Tomadas | Palavras recuperadas | LUFS |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...agg.rows.map(
      (r) =>
        `| ${r.edition} | ${r.key} | ${r.method === "11670-manual" ? "#11670" : "auto"} | ${cell(r.xmlDurationS, " s")} | ${cell(r.finalDurationS, " s")} | ${r.clips === null ? "n/d" : `${cell(r.clipsRemoved)}/${r.clips}`} | ${cell(r.touchedPct, "%")} | ${cell(r.headMeanMs, " ms")} | ${cell(r.tailMeanMs, " ms")} | ${cell(r.internalPausesRemoved)} | ${cell(r.takeSwaps)} | ${cell(r.wordsRecovered)} | ${cell(r.loudnessI)} |`,
    ),
    "",
    "## Padrões",
    "",
    ...(input.patterns.length ? input.patterns.map((p) => `- **${p.id}** (${p.priority}): ${p.editions.length} edições (${p.editions.join(", ")})`) : ["Nenhum padrão acima dos limiares."]),
    "",
  ];
  if (input.skipped.length) {
    lines.push("## Sem par (puladas)", "", "| Edição | Sequência | Motivo |", "|---|---|---|", ...input.skipped.map((s) => `| ${s.edition} | ${s.key} | ${s.reason} |`), "");
  }
  if (input.gaveUp?.length) {
    lines.push(
      `## Remedição desistida (${REMEASURE_MAX_FAILURES} falhas, números do método anterior)`,
      "",
      "| Edição | Sequência | Método | Última falha | Motivo |",
      "|---|---|---|---|---|",
      ...input.gaveUp.map((g) => `| ${g.edition} | ${g.key} | ${g.method} | ${g.failure.at} | ${g.failure.reason} |`),
      "",
    );
  }
  lines.push("Enquadramento e legenda: fora da medição automática (v1); a #11670 conferiu à mão e não achou mudança.");
  return lines.join("\n") + "\n";
}

// ── Escolha dos finais e das edições ─────────────────────────────────────

export interface FinalCandidate {
  name: string;
  modifiedTime?: string | null;
}

/**
 * Um final por sequência: `.mp4` cujo nome resolve para uma sequência do
 * plano (`resolveKey`, o `reviewFinalSequence` do video-montagem), a maior
 * versão `_V{n}` e, no empate, o mais recente. Puro.
 */
export function pickFinalsPerSequence<F extends FinalCandidate>(
  files: readonly F[],
  resolveKey: (name: string) => string | null,
  versionOf: (name: string) => number | null,
): Map<string, F> {
  const out = new Map<string, F>();
  for (const f of files) {
    if (!/\.mp4$/i.test(f.name)) continue;
    const key = resolveKey(f.name);
    if (!key) continue;
    const prev = out.get(key);
    if (!prev) {
      out.set(key, f);
      continue;
    }
    const vp = versionOf(prev.name) ?? 0;
    const vf = versionOf(f.name) ?? 0;
    if (vf > vp || (vf === vp && (f.modifiedTime ?? "") > (prev.modifiedTime ?? ""))) out.set(key, f);
  }
  return out;
}

/** Estado da tarefa recorrente (`data/video-xml-vs-final/state.json`). */
export interface RecurringState {
  lastRunAt: string | null;
  /** Edições com pelo menos uma sequência comparada, e quando. */
  done: Record<string, { at: string; sequences: string[] }>;
  /** Padrão → issue aberta e o hash da última evidência comentada. */
  patterns: Record<string, { issue: number; evidenceHash: string }>;
}

export const EMPTY_STATE: RecurringState = { lastRunAt: null, done: {}, patterns: {} };

/**
 * Motivo de `skipped` quando a consulta ao Drive falhou (credencial, rede,
 * pasta duplicada): distinto de "sem final exportado", que é ausência real
 * (self-review da PR #13205).
 */
export const DRIVE_UNAVAILABLE_REASON = "drive-indisponivel";

export const driveUnavailableReason = (message: string) => `${DRIVE_UNAVAILABLE_REASON}: ${message.slice(0, 200)}`;

/** A edição não pôde ser consultada no Drive (todas as sequências puladas por isso). */
export function isDriveUnavailable(rec: EditionRecord): boolean {
  return rec.sequences.length === 0 && rec.skipped.length > 0 && rec.skipped.every((s) => s.reason.startsWith(`${DRIVE_UNAVAILABLE_REASON}:`));
}

/**
 * Alarme da rodada: nenhuma das edições consultadas chegou ao Drive. O CLI sai
 * `1` nesse caso, para a falha de acesso não passar por "nada a comparar" e a
 * edição sair da janela de 14 dias em silêncio. Puro.
 */
export function driveUnreachable(records: readonly EditionRecord[]): boolean {
  return records.length > 0 && records.every(isDriveUnavailable);
}

/** AAMMDD → Date UTC do dia (meio-dia, sem borda de fuso). */
export function editionDate(e: string): Date {
  return new Date(Date.UTC(2000 + Number(e.slice(0, 2)), Number(e.slice(2, 4)) - 1, Number(e.slice(4, 6)), 12));
}

/**
 * As edições a comparar nesta rodada: com plan.json, dentro da janela
 * (`days` para trás a partir de `today`), e ainda sem todas as sequências do
 * plano comparadas. Sem par hoje, volta na próxima rodada até sair da janela
 * (o editor exporta o final às vezes dias depois). Puro.
 */
export function editionsToCompare(input: {
  withPlan: ReadonlyArray<{ edition: string; sequences: string[] }>;
  state: RecurringState;
  today: string;
  days: number;
  /** Método gravado de cada sequência (dos registros no disco); sem ele, o `done` vale como está. */
  methodOf?: SequenceLookup;
}): string[] {
  const limit = editionDate(input.today).getTime() - input.days * 86_400_000;
  return input.withPlan
    .filter((e) => editionDate(e.edition).getTime() >= limit && editionDate(e.edition).getTime() <= editionDate(input.today).getTime())
    .filter((e) => {
      const done = currentDoneSequences(input.state, e.edition, input.methodOf);
      return e.sequences.some((k) => !done.has(k));
    })
    .map((e) => e.edition)
    .sort();
}

/**
 * Pura — as sequências da edição já medidas com o método de agora (#13417).
 * Medida com método automático anterior (ou sem método conhecido no registro)
 * volta a ser pendente, para a próxima rodada medir de novo; o importado da
 * #11670 fica (não há como refazer a análise manual).
 */
export function currentDoneSequences(state: RecurringState, edition: string, methodOf?: SequenceLookup): Set<string> {
  const keys = state.done[edition]?.sequences ?? [];
  if (!methodOf) return new Set(keys);
  return new Set(
    keys.filter((k) => {
      const seq = methodOf(edition, k);
      const m = seq?.method;
      // Remedição que já falhou REMEASURE_MAX_FAILURES vezes para de tentar: fica no relatório, não na fila.
      return m === CURRENT_METHOD || m === "11670-manual" || (seq?.remeasureFailed?.count ?? 0) >= REMEASURE_MAX_FAILURES;
    }),
  );
}

/** Método e falhas de remedição de uma sequência gravada (dos registros no disco). */
export type SequenceLookup = (edition: string, key: string) => { method?: RecordMethod; remeasureFailed?: RemeasureFailure } | undefined;

/** Remedições seguidas que falham antes de a sequência sair da fila (#13417). */
export const REMEASURE_MAX_FAILURES = 3;

export interface RemeasureFailure {
  at: string;
  reason: string;
  count: number;
}

/** Pura — as sequências cuja remedição desistiu (para o relatório da rodada). */
export function remeasureGaveUp(records: readonly EditionRecord[]): Array<{ edition: string; key: string; method: RecordMethod; failure: RemeasureFailure }> {
  return records.flatMap((r) =>
    r.sequences
      .filter((s) => (s.remeasureFailed?.count ?? 0) >= REMEASURE_MAX_FAILURES)
      .map((s) => ({ edition: r.edition, key: s.key, method: s.method ?? r.method, failure: s.remeasureFailed as RemeasureFailure })),
  );
}

// ── Bruto: onde achar cada arquivo e como montar a linha do tempo ───────────
//
// A 1ª rodada real (backfill de 16/11/2026) pulou todas as edições de 261104
// em diante: sem o `audio.wav` no cache da montagem, só o caminho gravado no
// `plan.json` era tentado (G:/I:, do Windows) e o bruto em vários arquivos não
// tinha fallback (#13225). O bruto, porém, está no HD do 300 depois do
// arquivamento semanal (#12548), no cache da montagem ou no Drive.

export interface BrutoPart {
  /** Nome do arquivo (sem a pasta), como o Drive e o arquivo do HD o guardam. */
  name: string;
  /** Caminho gravado no `plan.json` (pode ser de outra máquina). */
  originalPath: string;
  /** Duração na linha do tempo (frames/fps); `null` no bruto de um arquivo só. */
  durationS: number | null;
}

/** Fonte do `plan.json` no que interessa aqui (`SourceInfo` da montagem). */
export interface BrutoSourceLite {
  fps?: number;
  path?: string;
  files?: ReadonlyArray<{ id?: string; path?: string; frames?: number; offsetFrames?: number }>;
}

/** Nome do arquivo de um caminho de qualquer máquina (`/` ou `\`). */
export function brutoFileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * Pura — os arquivos do bruto na ordem da linha do tempo da montagem. Bruto em
 * vários arquivos (#12559) precisa de `fps` e `frames` de cada um: é a duração
 * que cada parte ocupa na linha do tempo global dos `srcIn`/`srcOut`. Sem
 * isso, o motivo do pulo (nunca uma concatenação com tempos errados).
 */
export function brutoParts(source: BrutoSourceLite): { parts: BrutoPart[] } | { parts: null; reason: string } {
  const files = source.files ?? [];
  if (files.length > 1) {
    const fps = source.fps;
    if (!fps || !(fps > 0)) return { parts: null, reason: "bruto em vários arquivos sem fps no plan.json" };
    const sorted = [...files].sort((a, b) => (a.offsetFrames ?? 0) - (b.offsetFrames ?? 0));
    const parts: BrutoPart[] = [];
    for (const f of sorted) {
      // Sem `path`, o nome sai do `id` do `source.json` (`{id}.mp4`, o nome no Drive, #12089).
      const name = f.path ? brutoFileName(f.path) : f.id ? `${f.id}.mp4` : "";
      if (!name || !(f.frames && f.frames > 0)) return { parts: null, reason: "bruto em vários arquivos sem caminho ou frames de algum arquivo no plan.json" };
      parts.push({ name, originalPath: f.path ?? "", durationS: f.frames / fps });
    }
    return { parts };
  }
  const path = files[0]?.path ?? source.path;
  if (!path) return { parts: null, reason: "plan.json sem o caminho do bruto" };
  return { parts: [{ name: brutoFileName(path), originalPath: path, durationS: null }] };
}

/**
 * Pura — as pastas locais onde procurar um arquivo do bruto, em ordem: as do
 * arquivo do HD do 300 cujo nome cobre a edição (`261105`, `261109-10`, mesmo
 * critério do `archive-video-brutos.ts`, #12548) e a do cache da montagem
 * (`{cache}/{AAMMDD}/bruto`, onde o modo API dela baixa). O caminho original
 * do `plan.json` é tentado antes, por quem chama.
 */
export function brutoSearchDirs(input: {
  edition: string;
  archiveRoot: string | null;
  archiveFolders: readonly string[];
  montageEditionCache: string | null;
  join: (...p: string[]) => string;
  editionsOfFolder: (name: string) => string[] | null;
}): string[] {
  const dirs: string[] = [];
  if (input.archiveRoot) {
    for (const f of [...input.archiveFolders].sort()) {
      if (input.editionsOfFolder(f)?.includes(input.edition)) dirs.push(input.join(input.archiveRoot, f));
    }
  }
  if (input.montageEditionCache) dirs.push(input.join(input.montageEditionCache, "bruto"));
  return dirs;
}

/**
 * Pura — a duração do áudio montado bate com a linha do tempo? Tolerância de
 * 1 quadro mais 1 amostra (mesmo critério do `audioDurationMatches` da
 * montagem, #12559): um áudio mais curto adiantaria todas as falas seguintes.
 */
export function brutoTimelineMatches(actualS: number, parts: readonly BrutoPart[], fps: number | undefined, sampleRate = 16000): boolean {
  if (parts.some((p) => p.durationS === null)) return true;
  const expect = parts.reduce((s, p) => s + (p.durationS ?? 0), 0);
  const tol = (fps && fps > 0 ? 1 / fps : 0) + 1 / sampleRate + 1e-6;
  return Number.isFinite(actualS) && Math.abs(actualS - expect) <= tol;
}

/**
 * Falta de áudio tolerada (s) na extração de um arquivo do bruto antes de
 * completar com silêncio (#13417). O `apad` existe para o áudio que termina
 * uns décimos antes do vídeo (#12559); falta maior é leitura interrompida.
 */
export const EXTRACT_SHORTFALL_TOL_S = 1;

/**
 * Pura — a extração parou cedo (#13417)? O ffmpeg sai 0 quando a leitura do
 * arquivo (17,9 GB pelo Drive for desktop na 261117) para no meio, e o `apad`
 * completava o resto com silêncio: 1415 s de zeros que passavam pela
 * conferência de duração e voltavam do cache em toda rodada.
 */
export function extractionTruncated(actualS: number, expectedS: number, tolS = EXTRACT_SHORTFALL_TOL_S): boolean {
  // Duração esperada ilegível (ffprobe sem número) não é "não truncado": falha explícita.
  if (!Number.isFinite(expectedS)) throw new Error(`duração esperada ilegível (${expectedS}): não dá para conferir a extração`);
  return !Number.isFinite(actualS) || expectedS - actualS > tolS;
}

/** Diferença (s) entre duas leituras com falta abaixo da qual a falta é do próprio arquivo, não da leitura. */
export const SAME_SHORTFALL_TOL_S = 0.1;

/** Leitura do arquivo interrompida (duas extrações com falta diferente, a 2ª ainda curta): nada é gravado. */
export class DriveReadInterruptedError extends Error {}

/**
 * Lê um arquivo do bruto conferindo a duração, com UMA releitura (#13417).
 * `read(n)` extrai (tentativa n) e devolve a duração real. Falta acima da
 * tolerância relê; a 2ª leitura dentro da tolerância vale; falta IGUAL nas
 * duas (±`SAME_SHORTFALL_TOL_S`) é do próprio arquivo (áudio mais curto que o
 * vídeo): vale, com `realShortfallS` para quem chama completar com silêncio e
 * avisar; falta diferente e ainda fora da tolerância é leitura interrompida:
 * `DriveReadInterruptedError`. Nunca aborta por falta real.
 */
export function readWithRetry(expectedS: number, read: (attempt: number) => number, label: string): { actualS: number; attempts: number; realShortfallS: number | null } {
  const first = read(1);
  if (!extractionTruncated(first, expectedS)) return { actualS: first, attempts: 1, realShortfallS: null };
  const second = read(2);
  if (!extractionTruncated(second, expectedS)) return { actualS: second, attempts: 2, realShortfallS: null };
  if (Number.isFinite(first) && Number.isFinite(second) && Math.abs(second - first) <= SAME_SHORTFALL_TOL_S) {
    return { actualS: second, attempts: 2, realShortfallS: r3(expectedS - second) };
  }
  throw new DriveReadInterruptedError(
    `leitura do Drive interrompida: ${label} deu ${first.toFixed(2)} s e ${second.toFixed(2)} s de áudio, esperado ${expectedS.toFixed(2)} s (nada gravado, rodar de novo, #13417)`,
  );
}

/**
 * Maior trecho de zeros digitais tolerado (s) num áudio do bruto, novo ou em
 * cache (#13417). O `apad` legítimo deixa menos de `EXTRACT_SHORTFALL_TOL_S`
 * por arquivo; mais que isto é leitura interrompida completada com silêncio.
 */
export const MAX_ZERO_RUN_S = 5;

/** Pura — o maior trecho seguido de amostras exatamente zero: duração e início, em segundos. */
export function longestZeroRun(samples: ArrayLike<number>, sampleRate: number): { durationS: number; startS: number } {
  let best = 0;
  let bestAt = 0;
  let cur = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] === 0) {
      cur++;
      if (cur > best) {
        best = cur;
        bestAt = i - cur + 1;
      }
    } else cur = 0;
  }
  return sampleRate > 0 ? { durationS: best / sampleRate, startS: bestAt / sampleRate } : { durationS: 0, startS: 0 };
}

/** Pura — o motivo (neutro) de um áudio com trecho de zeros acima do teto, ou `null` se ele serve. */
export function zeroRunProblem(samples: ArrayLike<number>, sampleRate: number, maxS = MAX_ZERO_RUN_S): string | null {
  const z = longestZeroRun(samples, sampleRate);
  return z.durationS > maxS ? `trecho de ${z.durationS.toFixed(1)} s de zeros digitais em ${z.startS.toFixed(1)} s` : null;
}

/** Motivo de pulo com no máximo `max` caracteres, preservando o fim (onde fica a dica do que fazer). */
export function clipReason(reason: string, max = 300): string {
  if (reason.length <= max) return reason;
  const tail = Math.floor(max / 2);
  return `${reason.slice(0, max - tail - 1)}…${reason.slice(reason.length - tail)}`;
}
