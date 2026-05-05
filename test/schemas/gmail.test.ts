import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseGmailThread,
  parseGmailThreadsList,
} from "../../scripts/lib/schemas/gmail.ts";

const validThread = {
  id: "thread-1",
  messages: [
    {
      id: "msg-1",
      internalDate: "1717180800000",
      payload: {
        mimeType: "multipart/alternative",
        headers: [
          { name: "From", value: "vjpixel@gmail.com" },
          { name: "Subject", value: "test" },
          { name: "Date", value: "Wed, 5 May 2026 14:00:00 +0000" },
        ],
        parts: [
          {
            mimeType: "text/plain",
            body: { data: "aGVsbG8gd29ybGQ", size: 11 },
          },
          {
            mimeType: "text/html",
            body: { data: "PGgxPmhpPC9oMT4", size: 14 },
          },
        ],
      },
    },
  ],
};

describe("gmail schemas (#649 Tier B)", () => {
  describe("parseGmailThread", () => {
    it("parse válido sem erro", () => {
      const result = parseGmailThread(validThread);
      assert.equal(result.id, "thread-1");
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].payload.headers.length, 3);
    });

    it("rejeita mensagem sem payload.headers", () => {
      const bad = {
        id: "thread-1",
        messages: [
          {
            id: "msg-1",
            internalDate: "1717180800000",
            payload: { mimeType: "text/plain" },
          },
        ],
      };
      assert.throws(() => parseGmailThread(bad), /headers|invalid/i);
    });

    it("rejeita mensagem sem id", () => {
      const bad = {
        id: "thread-1",
        messages: [
          {
            internalDate: "1717180800000",
            payload: { mimeType: "text/plain", headers: [] },
          },
        ],
      };
      assert.throws(() => parseGmailThread(bad), /id|invalid/i);
    });

    it("aceita parts recursivos (multipart aninhado)", () => {
      const nested = {
        id: "t",
        messages: [
          {
            id: "m",
            internalDate: "1",
            payload: {
              mimeType: "multipart/mixed",
              headers: [],
              parts: [
                {
                  mimeType: "multipart/alternative",
                  parts: [
                    { mimeType: "text/plain", body: { data: "x" } },
                  ],
                },
              ],
            },
          },
        ],
      };
      const result = parseGmailThread(nested);
      const inner = result.messages[0].payload.parts?.[0]?.parts?.[0];
      assert.equal(inner?.mimeType, "text/plain");
    });

    it("aceita campos extras (passthrough)", () => {
      const extra = { ...validThread, _custom: "x" };
      const result = parseGmailThread(extra);
      assert.equal((result as Record<string, unknown>)._custom, "x");
    });
  });

  describe("parseGmailThreadsList", () => {
    it("parse válido com threads array", () => {
      const result = parseGmailThreadsList({
        threads: [{ id: "t1" }, { id: "t2", snippet: "preview" }],
        resultSizeEstimate: 2,
      });
      assert.equal(result.threads?.length, 2);
    });

    it("aceita response sem threads (Gmail retorna {} se vazio)", () => {
      const result = parseGmailThreadsList({});
      assert.equal(result.threads, undefined);
    });

    it("rejeita threads com id ausente", () => {
      assert.throws(
        () => parseGmailThreadsList({ threads: [{ snippet: "x" }] }),
        /id|invalid/i,
      );
    });
  });
});
