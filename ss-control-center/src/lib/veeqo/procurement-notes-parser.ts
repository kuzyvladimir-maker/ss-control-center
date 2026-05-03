// Parser for the [PROCUREMENT] block embedded in Veeqo internal notes.
//
// Block format:
//
//   [PROCUREMENT]
//   12345 | Wings 2lb | bought
//   67890 | Sauce 16oz | remain:3
//   [/PROCUREMENT]
//
// Each line: `<lineItemId> | <shortName> | <status>` where status is either
// `bought` or `remain:<N>` with N a positive integer.

const BLOCK_START = "[PROCUREMENT]";
const BLOCK_END = "[/PROCUREMENT]";

export type LineItemStatus =
  | { kind: "bought" }
  | { kind: "remain"; remaining: number };

export interface ProcurementBlock {
  // lineItemId -> status
  items: Map<string, LineItemStatus>;
}

/**
 * Parse the [PROCUREMENT] block out of notes. Returns an empty Map when the
 * block is absent or malformed.
 */
export function parseProcurementBlock(notes: string): ProcurementBlock {
  const items = new Map<string, LineItemStatus>();
  if (!notes) return { items };

  const startIdx = notes.indexOf(BLOCK_START);
  const endIdx = notes.indexOf(BLOCK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return { items };
  }

  const blockContent = notes
    .slice(startIdx + BLOCK_START.length, endIdx)
    .trim();
  const lines = blockContent
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 3) continue;

    const lineItemId = parts[0];
    const statusRaw = parts[2];
    if (!lineItemId || !statusRaw) continue;

    if (statusRaw === "bought") {
      items.set(lineItemId, { kind: "bought" });
    } else if (statusRaw.startsWith("remain:")) {
      const num = parseInt(statusRaw.slice("remain:".length), 10);
      if (!Number.isNaN(num) && num > 0) {
        items.set(lineItemId, { kind: "remain", remaining: num });
      }
    }
  }

  return { items };
}

/**
 * Serialize a procurement block back to the canonical text form.
 * `shortNames` provides a human-readable label per lineItemId so the block
 * stays readable when Vladimir opens the order in Veeqo.
 */
export function serializeProcurementBlock(
  block: ProcurementBlock,
  shortNames: Map<string, string>
): string {
  if (block.items.size === 0) return "";
  const lines: string[] = [BLOCK_START];
  for (const [lineItemId, status] of block.items) {
    const name = shortNames.get(lineItemId) ?? "?";
    const statusStr =
      status.kind === "bought" ? "bought" : `remain:${status.remaining}`;
    lines.push(`${lineItemId} | ${name} | ${statusStr}`);
  }
  lines.push(BLOCK_END);
  return lines.join("\n");
}

/**
 * Replace (or insert/remove) the [PROCUREMENT] block in existing notes.
 *  - Block missing + new block empty → return notes unchanged.
 *  - Block missing + new block non-empty → append to end.
 *  - Block present + new block empty → drop the old block.
 *  - Block present + new block non-empty → swap.
 */
export function replaceProcurementBlockInNotes(
  notes: string,
  newBlockText: string
): string {
  const startIdx = notes.indexOf(BLOCK_START);
  const endIdx = notes.indexOf(BLOCK_END);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    if (!newBlockText) return notes;
    return notes.trimEnd() + "\n\n" + newBlockText + "\n";
  }

  const before = notes.slice(0, startIdx).trimEnd();
  const after = notes.slice(endIdx + BLOCK_END.length).trimStart();

  if (!newBlockText) {
    return [before, after].filter(Boolean).join("\n\n");
  }

  return [before, newBlockText, after].filter(Boolean).join("\n\n");
}
