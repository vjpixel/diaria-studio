// #8693 — durable disable verification (post-mortem, P2, from edition 260922)
// Source: discovery: tutorial IA para iniciantes sem precisar
// Failure pattern verified against data/sources/discovery-tutorial-ia-para-iniciantes-sem-precisar.jsonl:
//   2026-08-27 23:12 — 402 Usage limit exceeded (edition 260828, x2 attempts)
//   2026-08-27 23:14 — 402 Usage limit exceeded (edition 260828, 2nd attempt)
//   2026-08-29 20:55 — 402 Usage limit exceeded (edition 260830)
//   2026-08-31 18:21 — 402 Usage limit exceeded (edition 260901)
// Last success: 2026-08-17 (260818). External search-plan cap; do NOT restore
// without confirming quota recovery.
export const SOURCE_SLUG = "discovery-tutorial-ia-para-iniciantes-sem-precisar";
export const LAST_OK_EDITION = "260818";
export const FAILURES = 4;
export const DISABLE_REASON = "#8693: 4x consecutive 402 Usage limit exceeded (search-plan cap). Temporarily disabled until investigation.";
