/** Typed node:sqlite reads. Callers own the correspondence between SQL and T.
 * This is a type assertion boundary, not runtime schema validation.
 */
import type { SQLInputValue, StatementSync } from "node:sqlite";

type Bindings = SQLInputValue[] | [Record<string, SQLInputValue>, ...SQLInputValue[]];

export function allRows<T>(stmt: StatementSync, ...params: Bindings): T[] {
  // SQLite accepts both overloads; the assertion only forwards their union.
  return stmt.all(...params as SQLInputValue[]) as unknown as T[];
}

export function getRow<T>(stmt: StatementSync, ...params: Bindings): T | undefined {
  return stmt.get(...params as SQLInputValue[]) as unknown as T | undefined;
}
