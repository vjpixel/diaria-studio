/**
 * Mock HTTP do Kit para os testes do executor de PRODUÇÃO do onboarding
 * (`scripts/onboarding-kit-transport-run.ts --send`, #7922).
 *
 * Desde o fleet review da PR #10607 o lote de produção segue a sequência
 * segura do piloto: tag do lote → tagueia → confere a tag (busca por nome +
 * membros) → broadcast RASCUNHO → releitura do `subscriber_filter` → PATCH
 * (filtro + `send_at`) → releitura de novo. Este mock guarda o estado de
 * cada tag e broadcast pra que essas releituras reflitam o que foi escrito.
 */
import { createServer, type Server } from "node:http";

export interface SeedBroadcast {
  id: number;
  status: string;
  send_at: string | null;
  subscriber_filter?: unknown;
}

export interface MockKitOnboardingOpts {
  /** Status de `POST /tags` (default 201). */
  tagCreateStatus?: number;
  /** Responde este status a QUALQUER rota (auth quebrada / Kit fora). */
  everything?: number;
  /** `GET /subscribers/{id}` devolve 404 e a busca por e-mail vem vazia. */
  subscriberMissing?: boolean;
  /** O PATCH de agendamento NÃO agenda (broadcast segue rascunho):
   *  "always", só o 1º PATCH, ou só o broadcast 4242 (o 1º criado). */
  patchNoSchedule?: "always" | "first" | "firstBroadcast";
  /** Releitura `GET /broadcasts/{id}` omite `send_at`. */
  rereadNoSendAt?: boolean;
  /** Status Kit devolvido na releitura (sobrepõe o estado guardado). */
  rereadStatus?: string;
  /** Releitura omite `subscriber_filter` (filtro não ecoado). */
  rereadNoFilter?: boolean;
  /** Status HTTP da releitura `GET /broadcasts/{id}` (default 200). */
  rereadHttpStatus?: number;
  /** Status HTTP do `DELETE /broadcasts/{id}` (default 204). */
  deleteHttpStatus?: number;
  /** Corpo do erro do `DELETE` quando `deleteHttpStatus` ≥ 400. */
  deleteErrorBody?: unknown;
  /** Chamado ao receber `POST /tags` (antes de responder). */
  onTagCreate?: () => void;
  /** #9487: `account.id` de `GET /account` (default 111); `null` = sem id. */
  accountId?: number | null;
  /** #9487: estes broadcasts dão 404 na releitura. */
  notFoundIds?: Set<number>;
  /** Broadcasts que já existem no Kit antes da rodada (lote de rodada anterior). */
  seedBroadcasts?: SeedBroadcast[];
  /** E-mail do assinante Kit `id` (membros da tag) — default `n{id}@example.com`. */
  emailForKitId?: (id: number) => string;
  /** `opened` devolvido por `/subscribers/{id}/stats` (default 2). */
  opened?: number;
}

export interface MockKitOnboarding {
  server: Server;
  url: string;
  hits: string[];
  /** `send_at` de cada `POST /broadcasts`, na ordem. */
  createdSendAt: (string | null)[];
}

export function startMockKitOnboarding(opts: MockKitOnboardingOpts = {}): Promise<MockKitOnboarding> {
  const hits: string[] = [];
  const createdSendAt: (string | null)[] = [];
  const broadcasts = new Map<number, { status: string; send_at: string | null; subscriber_filter?: unknown }>();
  for (const b of opts.seedBroadcasts ?? []) broadcasts.set(b.id, { status: b.status, send_at: b.send_at, subscriber_filter: b.subscriber_filter });
  const tags = new Map<string, number>();
  const members = new Map<number, Set<string>>();
  const emailFor = opts.emailForKitId ?? ((id: number) => `n${id}@example.com`);
  let nextId = Math.max(4241, ...(opts.seedBroadcasts ?? []).map((b) => b.id)) + 1;
  let nextTagId = 777;
  let patches = 0;
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const p = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        hits.push(`${req.method} ${p}`);
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (opts.everything) return send(opts.everything, { errors: ["mock"] });
        const pagination = { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 };
        const body = () => JSON.parse(raw || "{}") as Record<string, unknown>;
        let m: RegExpMatchArray | null;
        if (req.method === "GET" && (m = p.match(/^\/subscribers\/(\d+)\/stats$/))) {
          return send(200, { subscriber: { id: Number(m[1]), stats: { opened: opts.opened ?? 2 } } });
        }
        if (req.method === "GET" && (m = p.match(/^\/subscribers\/(\d+)$/))) {
          if (opts.subscriberMissing) return send(404, { errors: ["Not Found"] });
          const id = Number(m[1]);
          return send(200, { subscriber: { id, email_address: emailFor(id), state: "active", created_at: "2026-09-01T00:00:00Z" } });
        }
        if (req.method === "GET" && p === "/account") {
          const id = opts.accountId === undefined ? 111 : opts.accountId;
          return send(200, { account: { ...(id === null ? {} : { id }), name: "mock", plan_type: "creator" } });
        }
        if (req.method === "GET" && p === "/subscribers") return send(200, { subscribers: [], pagination });
        if (req.method === "GET" && p === "/tags") {
          return send(200, { tags: [...tags].map(([name, id]) => ({ id, name, created_at: "2026-10-20T00:00:00Z" })), pagination });
        }
        if (req.method === "POST" && p === "/tags") {
          opts.onTagCreate?.();
          const status = opts.tagCreateStatus ?? 201;
          if (status >= 400) return send(status, { errors: ["Name is invalid"] });
          const name = String(body().name);
          const id = tags.get(name) ?? nextTagId++;
          tags.set(name, id);
          return send(201, { tag: { id, name, created_at: "2026-10-20T00:00:00Z" } });
        }
        if (req.method === "POST" && (m = p.match(/^\/tags\/(\d+)\/subscribers\/(\d+)$/))) {
          const tagId = Number(m[1]);
          if (!members.has(tagId)) members.set(tagId, new Set());
          members.get(tagId)!.add(emailFor(Number(m[2])));
          return send(201, { subscriber: {} });
        }
        if (req.method === "GET" && (m = p.match(/^\/tags\/(\d+)\/subscribers$/))) {
          const list = [...(members.get(Number(m[1])) ?? [])].map((email, i) => ({ id: i + 1, email_address: email, state: "active" }));
          return send(200, { subscribers: list, pagination });
        }
        if (req.method === "POST" && p === "/broadcasts") {
          const b = body() as { send_at?: string | null; subscriber_filter?: unknown };
          const id = nextId++;
          createdSendAt.push(b.send_at ?? null);
          broadcasts.set(id, { status: b.send_at ? "scheduled" : "draft", send_at: b.send_at ?? null, subscriber_filter: b.subscriber_filter });
          return send(201, { broadcast: { id, status: b.send_at ? "scheduled" : "draft", send_at: b.send_at ?? null, public: false, subject: "s" } });
        }
        if ((m = p.match(/^\/broadcasts\/(\d+)$/))) {
          const id = Number(m[1]);
          const b = broadcasts.get(id);
          if (req.method === "PATCH") {
            if (!b) return send(404, { errors: ["Not Found"] });
            patches++;
            const patch = body() as { send_at?: string; subscriber_filter?: unknown };
            const noSchedule =
              opts.patchNoSchedule === "always" ||
              (opts.patchNoSchedule === "first" && patches === 1) ||
              (opts.patchNoSchedule === "firstBroadcast" && id === 4242);
            if (patch.subscriber_filter !== undefined) b.subscriber_filter = patch.subscriber_filter;
            if (noSchedule) {
              b.status = "draft";
              b.send_at = null;
            } else {
              b.status = "scheduled";
              b.send_at = patch.send_at ?? null;
            }
            return send(200, { broadcast: { id, status: b.status, send_at: b.send_at, public: false, subject: "s" } });
          }
          if (req.method === "GET") {
            if (opts.rereadHttpStatus && opts.rereadHttpStatus >= 400) return send(opts.rereadHttpStatus, { errors: ["mock"] });
            if (opts.notFoundIds?.has(id)) return send(404, { errors: ["Not Found"] });
            if (!b) return send(404, { errors: ["Not Found"] });
            return send(200, {
              broadcast: {
                id,
                status: opts.rereadStatus ?? b.status,
                send_at: opts.rereadNoSendAt ? null : b.send_at,
                ...(opts.rereadNoFilter ? {} : { subscriber_filter: b.subscriber_filter }),
                public: false,
                subject: "s",
              },
            });
          }
          if (req.method === "DELETE") {
            if (opts.deleteHttpStatus && opts.deleteHttpStatus >= 400) return send(opts.deleteHttpStatus, opts.deleteErrorBody ?? { errors: ["mock"] });
            if (!b) return send(404, { errors: ["Not Found"] });
            broadcasts.delete(id);
            res.writeHead(204);
            return res.end();
          }
        }
        send(404, { error: `unexpected ${req.method} ${p}` });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolvePromise({ server, url: `http://127.0.0.1:${port}`, hits, createdSendAt });
    });
  });
}

/** Lote de e-mail 1 de uma rodada ANTERIOR cujo agendamento não foi
 *  confirmado (`created`, sem `schedule_failed`) — o que `reconcileOpenLots`
 *  relê no início do `--send` seguinte (#9367 item 1). */
export function unverifiedEmail1Lot(over: Record<string, unknown> = {}) {
  return {
    lot_id: "email1-2026-10-19-01",
    kind: "email1",
    tag_name: "onboarding-email1-2026-10-19-01",
    tag_id: 700,
    broadcast_id: 4242,
    recipient_subscription_ids: ["501"],
    recipient_emails: ["n501@example.com"],
    status: "created",
    created_at: new Date(Date.now() - 86_400_000).toISOString(),
    send_at: null,
    last_reconciled_at: null,
    last_error: "releitura do broadcast 4242 falhou — agendamento NÃO confirmado",
    kit_account_id: "111",
    ...over,
  };
}
