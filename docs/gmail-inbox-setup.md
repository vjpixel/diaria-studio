# Setup: Gmail inbox para `diariaeditor@gmail.com`

O Claude Code usa o conector Gmail MCP da claude.ai para ler e-mails. Esse conector é autenticado a **uma conta Google por vez**. Como você provavelmente já tem o Gmail MCP conectado à sua conta pessoal (`vjpixel@gmail.com`), há duas formas de capturar os e-mails enviados para `diariaeditor@gmail.com`.

Escolha **uma** das opções abaixo. A **Opção A** é a recomendada — não precisa trocar a conta do Gmail MCP e funciona pra sempre.

---

## Opção A (recomendada) — forward + label na sua conta pessoal

Configure `diariaeditor@gmail.com` para encaminhar todos os e-mails pra `vjpixel@gmail.com`, e crie um filtro/label lá pra isolar as submissões da Diar.ia.

### Passos

**1. Habilitar forwarding em `diariaeditor@gmail.com`**

- Entre em `https://mail.google.com` logado como `diariaeditor@gmail.com`.
- Settings (engrenagem) → **See all settings** → aba **Forwarding and POP/IMAP**.
- Clicar em **Add a forwarding address** → digitar `vjpixel@gmail.com` → **Next** → **Proceed**.
- Google envia um e-mail de confirmação pra `vjpixel@gmail.com`. Abra e clique no link pra autorizar.
- Volte em Forwarding → selecione **"Forward a copy of incoming mail to"** → `vjpixel@gmail.com` → **"keep Gmail's copy in the Inbox"** (ou "delete Gmail's copy" se preferir deixar a caixa do editor limpa).
- **Save Changes** no rodapé.

**2. Criar filtro + label em `vjpixel@gmail.com`**

- Logado como `vjpixel@gmail.com`, Settings → **Filters and Blocked Addresses** → **Create a new filter**.
- Campo **To:** → `diariaeditor@gmail.com` (isto casa e-mails cujo `Delivered-To` original era o editor, mesmo após forward).
- Clicar em **Create filter**.
- Marcar:
  - ☑ **Apply the label:** → clicar em "Choose label…" → **New label…** → nome `Diaria` → **Create**.
  - ☑ **Skip the Inbox (Archive it)** (opcional — mantém sua caixa limpa; os e-mails ficam só no label).
  - ☑ **Also apply filter to matching conversations** (aplica retroativamente).
- **Create filter**.

**3. Testar**

- Envie um e-mail de teste pra `diariaeditor@gmail.com` com um link de teste no corpo (ex: `https://example.com/meu-artigo`).
- Aguarde ~1 min.
- Em `vjpixel@gmail.com`, confirme que o e-mail apareceu no label **Diaria**.

**4. Verificar no Claude Code**

Abra o Claude Code neste projeto e rode:

```
/diaria-inbox
```

Deve retornar `new_entries: 1` e anexar o link em `data/inbox.md`.

Se retornar erro de autenticação Gmail MCP → `/mcp` pra re-conectar.

---

## Opção B — Gmail MCP direto na conta `diariaeditor@gmail.com`

Só faz sentido se você **não** usa o Gmail MCP para a sua conta pessoal hoje, ou se topa trocar. O conector Gmail na claude.ai aceita uma conta por vez.

### Passos

1. Em `https://claude.ai/settings/connectors`, desconecte o Gmail atual (se houver).
2. Reconecte autenticando com `diariaeditor@gmail.com`.
3. Ajuste `platform.config.json`:
   ```json
   "inbox": {
     "address": "diariaeditor@gmail.com",
     "gmailQuery": "in:inbox",
     "enabled": true
   }
   ```
   (ou qualquer query que pegue só submissões relevantes — `in:inbox -from:me` por exemplo).
4. Rode `/diaria-inbox` pra validar.

---

## Opção C (futuro) — Gmail API via app password

Mais robusto mas exige mais setup: app password + script `node-imap` próprio, sem depender do MCP. Não está implementado no projeto. Se a Opção A virar limitante, abra uma issue.

---

## Troubleshooting

- **`/diaria-inbox` retorna `reason: "label_missing: ..."`** → o label não existe na conta autenticada (validação proativa do drain). O drainer já tentou criar — vá pro Gmail e configure o filtro (Opção A passo 2) que aplica o label.
- **`/diaria-inbox` retorna `reason: "inbox vazio em N drains consecutivos ..."`** → o label existe, mas nenhum e-mail foi marcado nele há ≥3 drains. Isso costuma indicar **filtro automático quebrado** (foi removido ou a regra está com `From:`/`To:` errado). Vá em Gmail → Filters → confira se a regra com `Apply label: Diaria` ainda existe e está ativa. Mande um e-mail de teste e re-rode `/diaria-inbox`.
- **`skipped: true, reason: "gmail_mcp_error"`** → Gmail MCP desconectado. `/mcp` no Claude Code pra reautenticar.
- **E-mails não chegam no label** → checar se o filtro está com `To: diariaeditor@gmail.com` exato; pode ser necessário usar `Delivered-To: diariaeditor@gmail.com` dependendo de como o Gmail reescreve headers em forwards. Ambos costumam funcionar — se não, abrir um e-mail encaminhado, ver original ("Show original") e confirmar qual header carrega o endereço do editor.
- **Editor não quer forwarding ligado o tempo todo** → Opção B é o caminho.
- **Quer revogar forwarding** → na conta `diariaeditor`, mesma tela de Forwarding, "Disable forwarding".

## Privacidade

- `data/inbox.md` e `data/inbox-cursor.json` ficam **gitignored** — eles podem conter PII (remetentes, trechos de e-mail) e nunca devem ir pro repositório. O drainer recria `inbox.md` a partir do template se o arquivo não existir.
- Se você ampliou a query manualmente (ex: removeu `label:Diaria` pra recuperar histórico), garanta que limpou `data/inbox.md` antes de rodar `git status` — entradas com PII podem ter caído ali.
