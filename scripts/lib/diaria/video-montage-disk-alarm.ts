/**
 * scripts/lib/diaria/video-montage-disk-alarm.ts (#12931)
 *
 * Lógica PURA do alarme de disco da montagem do vídeo (I/O em
 * `scripts/video-montage-disk-alarm.ts`).
 *
 * Origem: em 12/11/2026 o `check-video-env.ts --montagem` reprovou o `300`
 * por disco (15,2 GB livres no disco do cache, a montagem precisa de 25 GB),
 * e isso só apareceu na hora de montar o vídeo. O alarme mede o mesmo disco
 * com o mesmo piso (`requiredFreeBytes(null)`, o que o check exige sem bruto
 * conhecido) uma vez por dia, de tarde, antes da montagem (que roda depois do
 * gate 4), e abre uma issue com o que liberar.
 */
import { MONTAGE_DISK_FIX, requiredFreeBytes } from "./video-montage-env.ts";

export const VIDEO_MONTAGE_DISK_ALARM_FINDING_KEY = "video-montage-disk-low";

export interface MontageDiskEvaluation {
  /** `null` = leitura impossível (statfs falhou ou nenhum ancestral existe). */
  freeBytes: number | null;
  requiredBytes: number;
  /** `true` quando o espaço livre é conhecido e fica abaixo do piso. */
  triggered: boolean;
  /** Leitura falhou: o chamador sai com erro (unit `failed`), nunca "ok". */
  unreadable: boolean;
}

/**
 * Pura. O piso é o mesmo do check da montagem sem bruto conhecido (25 GB):
 * um bruto maior que ~8,3 GB pede mais (3x), e esse caso o check do dia ainda
 * pega; o alarme cobre o piso, que é o que falta com mais frequência.
 */
export function evaluateMontageDisk(freeBytes: number | null, requiredBytes: number = requiredFreeBytes(null)): MontageDiskEvaluation {
  const readable = freeBytes !== null && Number.isFinite(freeBytes) && freeBytes >= 0;
  return {
    freeBytes: readable ? freeBytes : null,
    requiredBytes,
    triggered: readable && (freeBytes as number) < requiredBytes,
    unreadable: !readable,
  };
}

function gb(n: number): string {
  return (n / 1e9).toFixed(1);
}

export interface MontageDiskFinding {
  check: string;
  fingerprint: string;
  family: "estado";
  title: string;
  body: string;
  labels: string[];
  priority: "P2";
}

/** Pura: vazio quando não disparou. Uma issue "estado" só (o achado é o disco abaixo do piso). */
export function montageDiskFindings(ev: MontageDiskEvaluation, cacheRoot: string, closeAfterRuns: number): MontageDiskFinding[] {
  if (!ev.triggered || ev.freeBytes === null) return [];
  const free = gb(ev.freeBytes);
  const need = gb(ev.requiredBytes);
  return [
    {
      check: VIDEO_MONTAGE_DISK_ALARM_FINDING_KEY,
      fingerprint: VIDEO_MONTAGE_DISK_ALARM_FINDING_KEY,
      family: "estado",
      title: `[diar.ia.br] montagem do vídeo: ${free} GB livres no disco do cache, precisa ${need} GB`,
      body: [
        "Achado automático do alarme `Diaria-Video-Montage-Disk-Alarm` (`scripts/video-montage-disk-alarm.ts`, #12931).",
        "",
        `Disco do cache da montagem (${cacheRoot}): ${free} GB livres, abaixo dos ${need} GB que o ` +
          "`check-video-env.ts --montagem` exige sem bruto conhecido. Do jeito que está, o `/diaria-video-montagem` " +
          "NÃO roda nesta máquina no modo API.",
        "",
        `Resolver: ${MONTAGE_DISK_FIX}.`,
        "",
        "Esta issue é criada automaticamente pelo alarme e será comentada/fechada sozinha quando o espaço livre " +
          `voltar ao piso por ${closeAfterRuns} execuções consecutivas (mesmo padrão de #5112).`,
      ].join("\n"),
      labels: ["bug"],
      priority: "P2",
    },
  ];
}
