import { readFileSync } from "node:fs";

// Committed research fixture (addendum R1): UTF-8 BOM, and items[] holds the
// unwrapped item-detail records. These records are research observations from
// 2026-09-19; they never count as a live run.
const FIXTURE_URL = new URL(
  "../../docs/research/FLIPP_DETAIL_PROBE_2026-09-19.json",
  import.meta.url,
);

const fixtureText = readFileSync(FIXTURE_URL, "utf8");

function parseFixture(): { items: Record<string, unknown>[] } {
  const text = fixtureText.startsWith("\uFEFF") ? fixtureText.slice(1) : fixtureText;
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" || parsed === null ||
    !Array.isArray((parsed as { items?: unknown }).items)
  ) {
    throw new Error("fixture: expected an object with items[]");
  }
  return parsed as { items: Record<string, unknown>[] };
}

/** Returns a fresh parse of the selected record, otherwise unchanged. */
export function item(id: number): Record<string, unknown> {
  const found = parseFixture().items.find((record) => record.id === id);
  if (!found) throw new Error(`fixture: no item ${id}`);
  return found;
}
