import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseDriveFileMetadata,
  parseDriveFileUploadResponse,
  parseDriveFileListResponse,
} from "../../scripts/lib/schemas/drive-api.ts";

describe("drive-api schemas (#649 Tier B, bug-driver #496)", () => {
  describe("parseDriveFileMetadata", () => {
    it("parse válido com modifiedTime ISO", () => {
      const result = parseDriveFileMetadata({
        id: "1abc",
        name: "01-categorized.md",
        modifiedTime: "2026-05-05T14:00:00.000Z",
        parents: ["folderId"],
      });
      assert.equal(result.id, "1abc");
      assert.equal(result.modifiedTime, "2026-05-05T14:00:00.000Z");
    });

    it("rejeita modifiedTime malformado (NaN ao parsear)", () => {
      assert.throws(
        () =>
          parseDriveFileMetadata({
            id: "1abc",
            name: "x",
            modifiedTime: "not-a-date",
          }),
        /modifiedTime/i,
      );
    });

    it("rejeita id vazio", () => {
      assert.throws(
        () =>
          parseDriveFileMetadata({
            id: "",
            name: "x",
            modifiedTime: "2026-05-05T14:00:00Z",
          }),
        /string|invalid/i,
      );
    });

    it("aceita parents ausente", () => {
      const result = parseDriveFileMetadata({
        id: "1abc",
        name: "x",
        modifiedTime: "2026-05-05T14:00:00Z",
      });
      assert.equal(result.parents, undefined);
    });
  });

  describe("parseDriveFileUploadResponse", () => {
    it("parse válido com mimeType", () => {
      const result = parseDriveFileUploadResponse({
        id: "1abc",
        modifiedTime: "2026-05-05T14:00:00Z",
        mimeType: "text/markdown",
      });
      assert.equal(result.mimeType, "text/markdown");
    });

    it("rejeita response sem mimeType (Drive sempre retorna)", () => {
      assert.throws(
        () =>
          parseDriveFileUploadResponse({
            id: "1abc",
            modifiedTime: "2026-05-05T14:00:00Z",
          }),
        /mimeType|invalid/i,
      );
    });

    it("rejeita modifiedTime malformado", () => {
      assert.throws(
        () =>
          parseDriveFileUploadResponse({
            id: "1abc",
            modifiedTime: "garbage",
            mimeType: "text/markdown",
          }),
        /modifiedTime/i,
      );
    });
  });

  describe("parseDriveFileListResponse", () => {
    it("parse com files array", () => {
      const result = parseDriveFileListResponse({
        files: [
          { id: "1", name: "a.md", modifiedTime: "2026-05-05T14:00:00Z" },
          { id: "2", name: "b.md" },
        ],
      });
      assert.equal(result.files?.length, 2);
    });

    it("aceita response vazio (sem files)", () => {
      const result = parseDriveFileListResponse({});
      assert.equal(result.files, undefined);
    });
  });
});
