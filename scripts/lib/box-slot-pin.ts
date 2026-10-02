/**
 * scripts/lib/box-slot-pin.ts (#9474 — extraído de `update-artigo-especial-box.ts`, #5979/#9256)
 *
 * Pin/unpin de um box de divulgação num slot de `platform.config.json`
 * (`boxes_divulgacao.slot{N}` + `boxes_divulgacao_auto.pinned_slots`) e a
 * serialização cirúrgica do arquivo. Compartilhado pelos dois boxes que hoje
 * disputam o slot 2:
 *
 *   - `artigo-especial-apoiadores.md` (`update-artigo-especial-box.ts`,
 *     `/diaria-artigo-especial`);
 *   - `retrospectiva-apoiadores.md` (`update-retrospectiva-box.ts`,
 *     `/diaria-mensal-apoiadores`).
 *
 * ## Alternância no slot 2 (decisão do editor, 02/10/2026, #9474)
 *
 * "Os dois se ALTERNAM no slot 2 (não competem nem se sobrescrevem)." O
 * mecanismo implementado é **last-writer-wins + unpin condicional ao dono**:
 *
 *   - `pin: true` → o slot passa a apontar pro arquivo de quem publicou por
 *     último (sobrescreve o outro de propósito — é a alternância: o box do
 *     produto mais recente ocupa o slot).
 *   - `pin: false` (`--unpin`) → só solta o slot (remove `N` de
 *     `pinned_slots`) se `boxes_divulgacao.slot{N}` AINDA aponta pro arquivo
 *     de quem pede. Se o outro box já assumiu o slot depois, o `--unpin`
 *     atrasado é no-op: nunca derruba o pin do outro. Antes do #9474 o unpin
 *     era incondicional — um `--unpin` do Artigo Especial dias depois de a
 *     Retrospectiva ter pinado devolveria o slot ao auto-select por cliques
 *     (#4626) e tiraria a Retrospectiva do ar em silêncio.
 *
 * Em nenhum dos dois casos `boxes_divulgacao.slot{N}` é apagado no unpin: o
 * valor configurado volta a ser candidato normal do auto-select (#4626).
 *
 * Trade-off herdado do #6748: o slot 2 só existe no gap D2/D3 — em edição de
 * 2 destaques nenhum dos dois boxes aparece, mesmo pinado.
 */

/** Arquivo do box do Artigo Especial — parceiro de alternância da Retrospectiva no slot 2. */
export const ARTIGO_ESPECIAL_BOX_FILENAME = "artigo-especial-apoiadores.md";

export interface BoxesDivulgacaoConfig {
  boxes_divulgacao?: Record<string, unknown>;
  boxes_divulgacao_auto?: { enabled?: boolean; pinned_slots?: number[]; note?: string };
  [key: string]: unknown;
}

export interface PinBoxInput {
  slot: number;
  filename: string;
  pin: boolean;
}

/** Pura: `boxes_divulgacao.slot{N}` aponta hoje pro `filename`? */
export function isBoxSlotOwnedBy(config: BoxesDivulgacaoConfig, slot: number, filename: string): boolean {
  return config.boxes_divulgacao?.[`slot${slot}`] === filename;
}

/**
 * Pura/imutável: aplica pin/unpin. `pin: true` seta `boxes_divulgacao.slot{N}`
 * = filename (idempotente — sobrescreve sempre, last-writer-wins) e garante
 * `N` em `pinned_slots` (dedup + ordenado). `pin: false` (--unpin) só REMOVE
 * `N` de `pinned_slots` quando o slot ainda aponta pro `filename` (ver
 * docstring do módulo) — e nunca mexe em `boxes_divulgacao.slot{N}`.
 */
export function applyBoxPin(config: BoxesDivulgacaoConfig, input: PinBoxInput): BoxesDivulgacaoConfig {
  const slotKey = `slot${input.slot}`;
  const currentPinned = config.boxes_divulgacao_auto?.pinned_slots ?? [];

  if (!input.pin) {
    // #9474: unpin de quem não é mais dono do slot é no-op — o outro box
    // (Artigo Especial × Retrospectiva) assumiu depois e continua pinado.
    if (!isBoxSlotOwnedBy(config, input.slot, input.filename)) return config;
    return {
      ...config,
      boxes_divulgacao_auto: {
        ...(config.boxes_divulgacao_auto ?? {}),
        pinned_slots: currentPinned.filter((s) => s !== input.slot),
      },
    };
  }

  const nextPinned = Array.from(new Set([...currentPinned, input.slot])).sort((a, b) => a - b);
  return {
    ...config,
    boxes_divulgacao: {
      ...(config.boxes_divulgacao ?? {}),
      [slotKey]: input.filename,
    },
    boxes_divulgacao_auto: {
      ...(config.boxes_divulgacao_auto ?? {}),
      pinned_slots: nextPinned,
    },
  };
}

/**
 * #9256 — serializa `nextConfig` preservando a formatação ORIGINAL do arquivo.
 *
 * `JSON.stringify(nextConfig, null, 2)` expandia todo array inline do
 * `platform.config.json` (dezenas de linhas não relacionadas no diff). Aqui a
 * troca é cirúrgica (#495): só a linha `"slot{N}": ...` dentro do objeto
 * `boxes_divulgacao` e a linha `"pinned_slots": [...]` dentro de
 * `boxes_divulgacao_auto` são substituídas. Validação de segurança: o texto
 * resultante precisa parsear para EXATAMENTE `nextConfig`; se a chave não
 * existir no texto (bootstrap) ou a validação falhar, cai no
 * `JSON.stringify` completo — correto, só mais ruidoso.
 */
export function serializeConfigSurgically(
  originalText: string,
  nextConfig: BoxesDivulgacaoConfig,
  slot: number,
): string {
  const fallback = JSON.stringify(nextConfig, null, 2) + "\n";
  let text = originalText;

  const replaceInBlock = (blockKey: string, innerKey: string, value: unknown): boolean => {
    const blockRe = new RegExp(`"${blockKey}"\\s*:\\s*\\{`);
    const m = blockRe.exec(text);
    if (!m) return false;
    const start = m.index + m[0].length;
    // fim do bloco: primeira "}" de fechamento respeitando strings/aninhamento
    let depth = 1;
    let inStr = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (c === "\\") i++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) return false;
    const block = text.slice(start, end);
    const keyRe = new RegExp(`("${innerKey}"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|null|true|false|-?\\d+(?:\\.\\d+)?|\\[[^\\[\\]]*\\])`);
    const km = keyRe.exec(block);
    if (!km) return false;
    const rendered = Array.isArray(value) ? `[${value.map((v) => JSON.stringify(v)).join(", ")}]` : JSON.stringify(value);
    const newBlock = block.slice(0, km.index) + km[1] + rendered + block.slice(km.index + km[0].length);
    text = text.slice(0, start) + newBlock + text.slice(end);
    return true;
  };

  const slotKey = `slot${slot}`;
  const nextSlotValue = nextConfig.boxes_divulgacao?.[slotKey];
  let original: unknown;
  try {
    original = JSON.parse(originalText);
  } catch {
    return fallback;
  }
  const origSlotValue = (original as BoxesDivulgacaoConfig).boxes_divulgacao?.[slotKey];
  if (nextSlotValue !== origSlotValue) {
    if (!replaceInBlock("boxes_divulgacao", slotKey, nextSlotValue)) return fallback;
  }
  if (!replaceInBlock("boxes_divulgacao_auto", "pinned_slots", nextConfig.boxes_divulgacao_auto?.pinned_slots ?? [])) {
    return fallback;
  }
  try {
    if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(nextConfig)) return fallback;
  } catch {
    return fallback;
  }
  return text;
}
