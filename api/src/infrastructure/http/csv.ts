/**
 * CSV cell rendering with formula-injection neutralization (pure — unit-tested in `csv.test.ts`).
 *
 * A spreadsheet (Excel / Google Sheets / LibreOffice) interprets a cell whose FIRST character is a formula
 * trigger (`=`, `+`, `-`, `@`) or a control char (tab, CR) as a formula when the export is opened — so an
 * attacker-controllable value like `=HYPERLINK("//evil","x")` (token symbols come from SPL metadata, not us)
 * executes on the victim's machine. The standard neutralizer is to prefix such a cell with a single quote,
 * which forces the spreadsheet to treat the whole cell as text (CSV-injection / OWASP guidance).
 *
 * Structural chars (`"`, `,`, CR, LF, tab) still force RFC-4180 quoting so a value can't break the row/column
 * layout; the quote char inside a quoted field is doubled.
 */

/** Leading chars a spreadsheet treats as the start of a formula → must be neutralized. Tab/CR included per the review. */
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/** Chars that force RFC-4180 quoting: double-quote, comma, LF, CR, tab (CR/tab added so control chars stay contained). */
const CSV_QUOTE_RE = /["\n,\r\t]/;

/**
 * A plain numeric literal is a NORMAL value, not a formula — a lone number (e.g. a negative PnL like `-5.3`)
 * can never execute, so we must NOT prefix it (that would turn the numeric column into text and break analysis).
 * Only a leading-trigger value that is NOT a plain number (a real formula payload) gets neutralized.
 */
function isNumericLiteral(s: string): boolean {
  return s.trim() !== '' && Number.isFinite(Number(s));
}

/** Render one value as a safe CSV cell: neutralize formula injection, then RFC-4180 quote if needed. */
export function csvCell(value: unknown): string {
  const raw = value == null ? '' : String(value);
  const startsWithTrigger = raw.length > 0 && FORMULA_TRIGGERS.has(raw[0]!);
  const cell = startsWithTrigger && !isNumericLiteral(raw) ? `'${raw}` : raw;
  return CSV_QUOTE_RE.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}
