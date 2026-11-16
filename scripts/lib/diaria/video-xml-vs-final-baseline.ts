/**
 * scripts/lib/diaria/video-xml-vs-final-baseline.ts (#13197)
 *
 * Os resultados da análise única da #11670 (261028–261103), normalizados no
 * formato de registro da #13196. A #13197 pede para reaproveitar, sem refazer:
 * os números abaixo são os dos dois comentários de análise da #11670 (01/11 e
 * 03/11/2026), transcritos campo a campo. O que a análise não mediu fica de
 * fora do `summary` (o agregado lê ausência como "não medido", nunca zero).
 *
 * Fontes:
 *   - https://github.com/vjpixel/diaria-studio/issues/11670 (comentário
 *     "Análise XML × final (rodada overnight, 01/11/2026)": durações, pausas
 *     internas e tomadas da 261029/261030);
 *   - mesmo issue, "Análise XML × final ampliada até a 261103": 261028 inteira,
 *     261103 (3 vídeos), cabeças aparadas da 261103 (#12089).
 *
 * 261029 YouTube não tem par (o XML não tinha a sequência, #11552): entra em
 * `skipped`, como na tabela de cobertura da #11670.
 */

import { XML_FINAL_SCHEMA, type EditionRecord, type SequenceRecord } from "./video-xml-vs-final.ts";

const AT = "2026-11-03T00:00:00.000Z";
const SOURCE = "https://github.com/vjpixel/diaria-studio/issues/11670";

function seq(key: string, target: string, xmlDurationS: number, finalDurationS: number, summary: SequenceRecord["summary"], loudnessI: number | null, notes: string[] = []): SequenceRecord {
  return {
    key,
    target,
    finalFile: null,
    xmlVersion: null,
    xmlDurationS,
    finalDurationS,
    coverage: null,
    summary,
    loudness: loudnessI === null ? null : { inputI: loudnessI, inputTp: null },
    framing: null,
    captions: null,
    ...(notes.length ? { notes } : {}),
  };
}

/** Uma entrada por edição analisada na #11670. */
export const BASELINE_11670: readonly EditionRecord[] = [
  {
    schema: XML_FINAL_SCHEMA,
    edition: "261028",
    method: "11670-manual",
    generatedAt: AT,
    source: SOURCE,
    sequences: [
      seq("youtube", "youtube", 269.1, 198.9, { clips: 49, clipsRemoved: 15, takeSwaps: 1, orderInversions: 1 }, -18.0, [
        "frases inteiras fora: 814,9–818,9; 969,1–989,9; 998,2–1010,3; 1112,0–1135,7 s",
        "título trocado de tomada (220,9 → 256,1 s); tomada anterior escolhida em 660,8 s → 622,7 s",
      ]),
      seq("instagram", "instagram", 211.4, 75.3, { clips: 41, clipsRemoved: 25, internalPausesRemoved: 2 }, -18.0, ["vertical = Instagram = Outras redes (mesmo arquivo)"]),
    ],
    skipped: [],
  },
  {
    schema: XML_FINAL_SCHEMA,
    edition: "261029",
    method: "11670-manual",
    generatedAt: AT,
    source: SOURCE,
    sequences: [seq("instagram", "instagram", 77.5, 74.8, { internalPausesRemoved: 13 }, -13.2)],
    skipped: [{ key: "youtube", reason: "sem sequência YouTube no XML (bruto só de áudio no início, #11552)" }],
  },
  {
    schema: XML_FINAL_SCHEMA,
    edition: "261030",
    method: "11670-manual",
    generatedAt: AT,
    source: SOURCE,
    sequences: [
      seq("youtube", "youtube", 263.1, 214.5, { internalPausesRemoved: 14, takeSwaps: 3, orderInversions: 1, wordsRecovered: 1 }, -13.5, [
        "palavra recolocada num corte em plena fala: \"anticonvulsionante.\" (187,33–188,00 s)",
      ]),
      seq("outras-redes", "outras-redes", 102.3, 83.6, { internalPausesRemoved: 6 }, -13.5, ["vertical em Editado/, sem vertical em Final/"]),
    ],
    skipped: [],
  },
  {
    schema: XML_FINAL_SCHEMA,
    edition: "261103",
    method: "11670-manual",
    generatedAt: AT,
    source: SOURCE,
    sequences: [
      seq("youtube", "youtube", 340.2, 323.9, { clipsRemoved: 0, internalPausesRemoved: 12, headMeanMs: -500, wordsRecovered: 7 }, -13.75, [
        "cabeças aparadas em 24–27 clipes por vídeo, mediana 0,5 s (#12089): headMeanMs é a mediana, não a média",
        "trecho recolocado: 411,73–413,27 s estendido até 415,47 s (\"Bom, eu acho que essa é a pronúncia.\")",
      ]),
      seq("outras-redes", "outras-redes", 92.3, 88.8, { clipsRemoved: 0 }, -13.75),
      seq("soberana", "outras-redes", 89.2, 82.0, { clipsRemoved: 0 }, -13.75, ["vertical extra (corte soberana)"]),
    ],
    skipped: [],
  },
];
