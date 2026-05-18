/**
 * publish-consent.ts (#1238)
 *
 * Helper puro pra montar/parsear o objeto de consent de Stage 4
 * (`_internal/05-publish-consent.json`).
 *
 * Source values:
 *   - "auto_approve_default" → vem de auto_approve=true (sem prompt)
 *   - "editor_response_{X}"  → editor respondeu no gate interativo
 *   - "default_manual"       → editor não respondeu, fallback manual
 */

export type Mode = "auto" | "manual" | "skipped";

export interface PublishConsent {
  newsletter: Mode;
  linkedin: Mode;
  facebook: Mode;
  /** Origem da decisão pra rastreabilidade no run-log. */
  source: string;
}

/**
 * Consent default pra `auto_approve = true`: tudo auto. Source registrado
 * pra auditoria post-edição.
 */
export function autoApproveConsent(): PublishConsent {
  return {
    newsletter: "auto",
    linkedin: "auto",
    facebook: "auto",
    source: "auto_approve_default",
  };
}

/**
 * Consent default quando editor não responde no gate interativo (#1326).
 * Tudo auto — Stage 4 é dispatch, editor já revisou nos gates 1-3.
 * `defaultManualConsent` (legacy) mantido pra retro-compat.
 */
export function defaultAutoConsent(): PublishConsent {
  return {
    newsletter: "auto",
    linkedin: "auto",
    facebook: "auto",
    source: "default_auto",
  };
}

/**
 * @deprecated Use `defaultAutoConsent` (#1326 invertu o default).
 * Mantido pra callers legacy + caso editor queira pedir manual explicitamente
 * (`--skip newsletter,linkedin,facebook` é equivalente).
 */
export function defaultManualConsent(): PublishConsent {
  return {
    newsletter: "manual",
    linkedin: "manual",
    facebook: "manual",
    source: "default_manual",
  };
}

/**
 * Parseia lista de canais via flag `--skip` (#1326). Cada canal listado
 * fica `manual` no consent; canais não-listados ficam `auto`.
 *
 * Aceita:
 *   - "" / "all" → todos auto (no-op)
 *   - "newsletter" → só newsletter manual
 *   - "linkedin,facebook" → linkedin + facebook manual
 *   - "newsletter,linkedin,facebook" → tudo manual
 *
 * Retorna null pra input inválido (tokens não reconhecidos).
 */
export function parseSkipFlag(input: string): PublishConsent | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    return { ...defaultAutoConsent(), source: "skip_flag_empty" };
  }
  const VALID = new Set(["newsletter", "linkedin", "facebook"]);
  const tokens = trimmed
    .split(/[,\s]+/)
    .filter(Boolean);
  if (tokens.some((t) => !VALID.has(t))) return null;
  const skipped = new Set(tokens);
  return {
    newsletter: skipped.has("newsletter") ? "manual" : "auto",
    linkedin: skipped.has("linkedin") ? "manual" : "auto",
    facebook: skipped.has("facebook") ? "manual" : "auto",
    source: `skip_flag_${[...skipped].sort().join("_")}`,
  };
}

/**
 * Parseia a resposta do editor no gate 4b. Aceita:
 *   - "all" → tudo auto
 *   - "none" → tudo skipped
 *   - Lista CSV de números 1-6:
 *     1=Beehiiv auto, 2=Beehiiv manual
 *     3=LinkedIn auto, 4=LinkedIn manual
 *     5=Facebook auto, 6=Facebook manual
 *
 * Números conflitantes (1 e 2 ambos, etc) usam o último que aparece.
 * Canais não-mencionados na resposta ficam manual (default conservador).
 * Retorna null se input é vazio/inválido.
 */
export function parseEditorResponse(input: string): PublishConsent | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  if (trimmed === "all") {
    return {
      newsletter: "auto",
      linkedin: "auto",
      facebook: "auto",
      source: "editor_response_all",
    };
  }
  if (trimmed === "none") {
    return {
      newsletter: "skipped",
      linkedin: "skipped",
      facebook: "skipped",
      source: "editor_response_none",
    };
  }

  // Parse lista CSV de números
  const nums = trimmed
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((s) => parseInt(s, 10));
  if (nums.length === 0 || nums.some((n) => isNaN(n) || n < 1 || n > 6)) {
    return null;
  }

  // Start com manual default; aplicar overrides na ordem
  const out: PublishConsent = {
    newsletter: "manual",
    linkedin: "manual",
    facebook: "manual",
    source: `editor_response_${nums.join("_")}`,
  };
  for (const n of nums) {
    if (n === 1) out.newsletter = "auto";
    else if (n === 2) out.newsletter = "manual";
    else if (n === 3) out.linkedin = "auto";
    else if (n === 4) out.linkedin = "manual";
    else if (n === 5) out.facebook = "auto";
    else if (n === 6) out.facebook = "manual";
  }
  return out;
}

/**
 * True se algum canal está auto — pra orchestrator saber se precisa
 * rodar `upload-images-public.ts` (pre-req do dispatch automático).
 */
export function hasAnyAutoChannel(consent: PublishConsent): boolean {
  return (
    consent.newsletter === "auto" ||
    consent.linkedin === "auto" ||
    consent.facebook === "auto"
  );
}

/**
 * True se TODOS canais skipped — orchestrator encerra Stage 4 sem
 * dispatch, grava `05-published.json` com `status: "skipped_by_editor"`.
 */
export function allChannelsSkipped(consent: PublishConsent): boolean {
  return (
    consent.newsletter === "skipped" &&
    consent.linkedin === "skipped" &&
    consent.facebook === "skipped"
  );
}
