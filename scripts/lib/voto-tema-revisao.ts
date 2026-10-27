/**
 * scripts/lib/voto-tema-revisao.ts (#11199)
 *
 * Marcador de revisão de texto da cédula da votação de tema. Pedido do editor
 * (ciclo 2611, 26/10/2026): o rascunho do e-mail da votação sempre passa por
 * Humanizador + Clarice ANTES de ir pro Kit. No 2611 a passada foi feita à mão
 * depois do rascunho criado, o que obrigou a regravar a cédula no KV
 * (`voto-tema-open.ts --force`) e o HTML do broadcast.
 *
 * A regra não depende do prompt (lição do #6439): `ballot.json` ganha
 *
 *   "revisado": { "humanizador": true, "clarice": true, "em": "<ISO>", "hash": "<sha256>" }
 *
 * gravado por `scripts/voto-tema-marcar-revisado.ts`, e
 * `publish-voto-tema-kit.ts --push` recusa criar o rascunho sem ele.
 *
 * "Gravado depois da última edição da cédula" é medido por CONTEÚDO, não por
 * relógio: `hash` é o sha256 do texto que chega ao leitor (título, prazo e
 * `n`/`titulo`/`descricao`/`proponente` de cada opção). Qualquer edição
 * posterior ao marcador muda o hash e invalida a revisão. Comparar `em` com o
 * mtime do arquivo não serviria: gravar o próprio marcador atualiza o mtime, e
 * o OneDrive reescreve mtime ao sincronizar entre máquinas.
 *
 * A checagem compara o hash com a cédula LOCAL e com a cédula do KV (a que de
 * fato é renderizada no e-mail). Cédula revisada localmente mas não regravada
 * no KV também é recusada, com a instrução de reabrir com `--force`.
 */
import { createHash } from "node:crypto";
import type { CandidatoTema } from "../../workers/artigos/src/voto-tema-core.ts";

/** Campos da cédula que viram texto no e-mail. */
export interface CedulaTexto {
  titulo: string;
  opcoes: CandidatoTema[];
  prazo?: string;
}

export interface RevisaoMarker {
  humanizador: true;
  clarice: true;
  /** ISO 8601 do momento em que o marcador foi gravado (informativo). */
  em: string;
  /** `cedulaTextoHash` da cédula no momento da revisão. */
  hash: string;
}

export type RevisaoCheck = { ok: true; marker: RevisaoMarker } | { ok: false; reason: string };

/** Comando que grava o marcador — citado nas mensagens de recusa. */
export const MARCAR_REVISADO_COMMAND = "npx tsx scripts/voto-tema-marcar-revisado.ts --ciclo AAMM --humanizador --clarice";

/** sha256 hex do texto da cédula, canônico (ordem fixa de chaves, ordem das
 *  opções preservada porque é a ordem do e-mail). @pure */
export function cedulaTextoHash(cedula: CedulaTexto): string {
  const canonical = {
    titulo: cedula.titulo,
    prazo: cedula.prazo ?? null,
    opcoes: (cedula.opcoes ?? []).map((o) => ({
      n: o.n,
      titulo: o.titulo,
      descricao: o.descricao,
      proponente: o.proponente ?? null,
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

/** Marcador para a cédula como está agora. @pure */
export function buildRevisaoMarker(cedula: CedulaTexto, now: Date): RevisaoMarker {
  return { humanizador: true, clarice: true, em: now.toISOString(), hash: cedulaTextoHash(cedula) };
}

function isMarker(v: unknown): v is RevisaoMarker {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    m.humanizador === true &&
    m.clarice === true &&
    typeof m.em === "string" &&
    !Number.isNaN(Date.parse(m.em)) &&
    typeof m.hash === "string" &&
    /^[0-9a-f]{64}$/.test(m.hash)
  );
}

/**
 * Confere o marcador de `ballot.json` contra o texto da própria cédula local
 * e, se dado, contra a cédula gravada no KV. @pure
 */
export function checkRevisao(
  ballotJson: (CedulaTexto & { revisado?: unknown }) | null,
  kvCedula: CedulaTexto | null,
): RevisaoCheck {
  if (!ballotJson) {
    return { ok: false, reason: "ballot.json ausente — não há como conferir a revisão de texto da cédula." };
  }
  const raw = ballotJson.revisado;
  if (raw === undefined || raw === null) {
    return {
      ok: false,
      reason: `ballot.json sem marcador "revisado" — passe Humanizador e Clarice no texto da cédula e rode '${MARCAR_REVISADO_COMMAND}'.`,
    };
  }
  if (!isMarker(raw)) {
    return {
      ok: false,
      reason:
        `marcador "revisado" inválido em ballot.json (${JSON.stringify(raw)}) — precisa de humanizador: true, ` +
        `clarice: true, em (ISO) e hash; grave com '${MARCAR_REVISADO_COMMAND}'.`,
    };
  }
  const localHash = cedulaTextoHash(ballotJson);
  if (raw.hash !== localHash) {
    return {
      ok: false,
      reason:
        `a cédula em ballot.json mudou depois da revisão de ${raw.em} — passe Humanizador e Clarice de novo ` +
        `no texto editado e regrave o marcador ('${MARCAR_REVISADO_COMMAND}').`,
    };
  }
  if (kvCedula && cedulaTextoHash(kvCedula) !== raw.hash) {
    return {
      ok: false,
      reason:
        "a cédula gravada no KV difere da cédula revisada em ballot.json — o e-mail sairia com o texto não revisado. " +
        "Regrave a cédula com 'npx tsx scripts/voto-tema-open.ts --ciclo AAMM --push --force' e rode este comando de novo.",
    };
  }
  return { ok: true, marker: raw };
}
