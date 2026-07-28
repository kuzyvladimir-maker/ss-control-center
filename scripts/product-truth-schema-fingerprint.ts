import { createHash } from "node:crypto";

import type { ResultSet } from "@libsql/client";

import type {
  ProductTruthSchemaFingerprint,
} from "./product-truth-migration-plan";

export interface ProductTruthSchemaFingerprintExecutor {
  execute(statement: string): Promise<ResultSet>;
}

interface ExactSchemaSnapshot {
  schemaRows: Array<Record<string, unknown>>;
  tableMetadata: Array<{
    table: string;
    xinfo: Array<Record<string, unknown>>;
    foreignKeys: Array<Record<string, unknown>>;
    indexes: Array<Record<string, unknown>>;
  }>;
  indexMetadata: Array<{
    index: string;
    xinfo: Array<Record<string, unknown>>;
  }>;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, "en-US"))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return value;
}

function normalizeResultRows(
  rows: ResultSet["rows"],
): Array<Record<string, unknown>> {
  return rows.map((row) => stableValue({ ...row }) as Record<string, unknown>)
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right), "en-US"));
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function stripSqlComments(sql: string): string {
  let output = "";
  let quote: "'" | '"' | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += "\n";
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        output += " ";
        index += 1;
      } else if (character === "\n") {
        output += "\n";
      }
      continue;
    }
    if (quote) {
      output += character;
      if (character === quote && next === quote) {
        output += next;
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      output += character;
    } else if (character === "-" && next === "-") {
      lineComment = true;
      output += " ";
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      output += " ";
      index += 1;
    } else {
      output += character;
    }
  }
  if (blockComment) {
    throw new Error("PRODUCT_TRUTH_SCHEMA_SQL_COMMENT_UNCLOSED");
  }
  return output;
}

function normalizeSqlDefinition(sql: string): string {
  const input = stripSqlComments(sql).trim().replace(/;\s*$/, "");
  let output = "";
  let quote: "'" | '"' | "`" | "]" | null = null;
  let pendingWhitespace = false;
  const punctuation = new Set(["(", ")", ",", "="]);
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    const next = input[index + 1];
    if (quote) {
      output += character;
      if (quote === "]") {
        if (character === "]") quote = null;
      } else if (character === quote && next === quote) {
        output += next;
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      if (pendingWhitespace && output && !punctuation.has(output.at(-1)!)) {
        output += " ";
      }
      pendingWhitespace = false;
      quote = character;
      output += character;
    } else if (character === "[") {
      if (pendingWhitespace && output && !punctuation.has(output.at(-1)!)) {
        output += " ";
      }
      pendingWhitespace = false;
      quote = "]";
      output += character;
    } else if (/\s/.test(character)) {
      pendingWhitespace = true;
    } else if (punctuation.has(character)) {
      output = output.trimEnd();
      output += character;
      pendingWhitespace = false;
    } else {
      if (pendingWhitespace && output && !punctuation.has(output.at(-1)!)) {
        output += " ";
      }
      pendingWhitespace = false;
      output += character;
    }
  }
  return output.trim();
}

export async function inspectProductTruthSchemaFingerprint(
  executor: ProductTruthSchemaFingerprintExecutor,
): Promise<ProductTruthSchemaFingerprint> {
  const master = await executor.execute(
    `SELECT type, name, tbl_name, sql
     FROM sqlite_schema
     WHERE type IN ('table','trigger','index','view')
     ORDER BY type, name`,
  );
  const schemaRows = normalizeResultRows(master.rows);
  const tables = schemaRows
    .filter((row) => row.type === "table")
    .map((row) => String(row.name))
    .sort((left, right) => left.localeCompare(right, "en-US"));
  const indexes = schemaRows
    .filter((row) => row.type === "index")
    .map((row) => String(row.name))
    .sort((left, right) => left.localeCompare(right, "en-US"));
  const tableMetadata: ExactSchemaSnapshot["tableMetadata"] = [];
  for (const table of tables) {
    const xinfo = await executor.execute(`PRAGMA table_xinfo(${quoteIdentifier(table)})`);
    const foreignKeys = await executor.execute(
      `PRAGMA foreign_key_list(${quoteIdentifier(table)})`,
    );
    const tableIndexes = await executor.execute(
      `PRAGMA index_list(${quoteIdentifier(table)})`,
    );
    tableMetadata.push({
      table,
      xinfo: normalizeResultRows(xinfo.rows),
      foreignKeys: normalizeResultRows(foreignKeys.rows),
      indexes: normalizeResultRows(tableIndexes.rows),
    });
  }
  const indexMetadata: ExactSchemaSnapshot["indexMetadata"] = [];
  for (const index of indexes) {
    const xinfo = await executor.execute(`PRAGMA index_xinfo(${quoteIdentifier(index)})`);
    indexMetadata.push({ index, xinfo: normalizeResultRows(xinfo.rows) });
  }
  const exact: ExactSchemaSnapshot = {
    schemaRows,
    tableMetadata,
    indexMetadata,
  };
  const objects = schemaRows.map((row) => ({
    type: String(row.type ?? ""),
    name: String(row.name ?? ""),
    tableName: String(row.tbl_name ?? ""),
    sqlSha256: sha256(
      row.sql == null ? "<null>" : normalizeSqlDefinition(String(row.sql)),
    ),
  }));
  return {
    sha256: sha256(JSON.stringify(stableValue(exact))),
    objectCount: schemaRows.length,
    tableCount: tables.length,
    triggerCount: schemaRows.filter((row) => row.type === "trigger").length,
    indexCount: indexes.length,
    objects,
  };
}
