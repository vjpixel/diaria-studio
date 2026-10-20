# onboarding-form (#10605): stub, não implantado

Formulário de perfil/interesses do onboarding (decisão do editor, 20/10/2026:
form próprio num Worker nosso). O executor `scripts/onboarding-followup-run.ts`
lê as respostas daqui (`GET /api/respostas`) e marca "preencheu" no store
(`data/onboarding/store.json` → `followup.people[id].form_filled_at`), o que
para os lembretes na hora.

Contrato: `scripts/lib/onboarding-form-contract.ts`.

## Falta para publicar

1. Perguntas do formulário (`FORM_QUESTIONS`), que dependem do editor.
2. KV `ONBOARDING_FORM` + secret `RESPONSES_TOKEN` (ver `wrangler.toml`).
3. Workflow de deploy + rota pública.
4. `onboarding.followup.form_url` / `form_responses_url` no `platform.config.json`
   e `ONBOARDING_FORM_TOKEN` no `.env` do servidor.

Enquanto isso, o envio dos e-mails do formulário fica travado
(`formContentGate` → `form_nao_configurado` / `texto_pendente`).
