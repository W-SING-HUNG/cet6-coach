import type { DatabaseSync } from "node:sqlite";

/** node:sqlite 返回的行是弱类型；这里集中做窄化，避免各处散落 cast。 */
export type Row = Record<string, unknown>;

export function asRow(value: unknown): Row | null {
  if (value === null || value === undefined) return null;
  return value as Row;
}

export function asRows(value: unknown): Row[] {
  return (value ?? []) as Row[];
}

export function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

export function toNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length === 0 ? null : text;
}

export function toInt(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

export function toFloat(value: unknown, fallback = 0): number {
  return toInt(value, fallback);
}

export function toBool(value: unknown): boolean {
  return toInt(value, 0) === 1;
}

export function toJson<T>(value: unknown, fallback: T): T {
  const text = toText(value);
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function fromBool(value: boolean): number {
  return value ? 1 : 0;
}

export function fromNullable(value: string | null): string | null {
  return value === null || value === undefined ? null : value;
}

export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function firstRow(db: DatabaseSync, sql: string, params: unknown[]): Row | null {
  return asRow(db.prepare(sql).get(...(params as never[])));
}

export function allRows(db: DatabaseSync, sql: string, params: unknown[]): Row[] {
  return asRows(db.prepare(sql).all(...(params as never[])));
}
