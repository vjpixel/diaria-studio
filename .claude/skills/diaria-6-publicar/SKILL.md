---
name: diaria-6-publicar
description: Roda os Stages 5 e 6 — cria rascunho no Beehiiv + email de teste (S5) e publica 6 posts sociais como rascunho/agendado (S6). Uso — `/diaria-6-publicar [all|newsletter|social] AAMMDD`.
---

# /diaria-6-publicar

Dispara os Stages 5 e 6 da edição Diar.ia: cria a newsletter no Beehiiv como rascunho + envia email de teste, e publica os 6 posts sociais (LinkedIn × 3 + Facebook × 3) como rascunho ou agendados.

## Argumentos

- `/diaria-6-publicar all AAMMDD` — roda Stage 5 e Stage 6 em sequência
- `/diaria-6-publicar newsletter AAMMDD` — só Stage 5 (Beehiiv)
- `/diaria-6-publicar social AAMMDD` — só Stage 6 (LinkedIn + Facebook)

Se não passar data, usa a data de hoje.

## Pré-requisitos

- Stages 1–5 completos: `02-reviewed.md`, `03-social.md`, `01-eai.md` + `01-eai.jpg`, `04-d{1,2,3}.jpg`
- Chrome com extensão **Claude in Chrome** ativa (ver `docs/browser-publish-setup.md`)
- Logado em Beehiiv, LinkedIn e Facebook (Meta Business Suite) no Chrome
- Bloco `publishing` em `platform.config.json` configurado

## O que faz

### Stage 5 — `publish-newsletter`

1. Abre Beehiiv no Chrome, cria novo post com template configurado.
2. Preenche título, subtítulo, corpo (imagens dos destaques + bloco "É IA?"), cover.
3. **Salva como rascunho** + envia **email de teste** para `publishing.newsletter.test_email`.
4. Grava `05-published.json` com `draft_url` e `test_email_sent_at`.
5. **Gate humano**: URL do rascunho + confirmação do teste. Editor publica manualmente do Beehiiv.

### Stage 6 — `publish-social`

1. Itera por LinkedIn × (d1, d2, d3) + Facebook × (d1, d2, d3).
2. Tenta rascunho; se não suportar, agenda no horário em `fallback_schedule`.
3. Append imediato em `06-social-published.json` após cada post (resume-aware).
4. **Gate humano**: 6 URLs + status + horários.

## Output

- `05-published.json` — `draft_url`, `test_email_sent_at`, `template_used`
- `06-social-published.json` — 6 posts com `platform`, `destaque`, `url`, `status`, `scheduled_at`

## Notas

- **Nada é publicado automaticamente.** Newsletter vira rascunho + teste; social vira rascunho ou agendado. Editor dispara manualmente.
- **Resume-aware**: re-rodar pula posts já publicados.
- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
