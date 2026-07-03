/**
 * `csvCell` — CSV formula-injection neutralization. These tests encode the WHY: an attacker-controllable token
 * symbol written raw into the export executes as a formula when the victim opens it in a spreadsheet (#99), so
 * every dangerous leading char MUST be neutralized — while normal values (incl. legitimate negative numbers)
 * stay untouched and RFC-4180 quoting of structural chars is preserved.
 */
import { describe, expect, it } from 'vitest';
import { csvCell } from './csv';

describe('csvCell — formula-injection neutralization (#99)', () => {
  it('neutralizes every dangerous leading char with a single-quote prefix', () => {
    // The classic payload from the review — must NOT reach the spreadsheet as a live formula.
    expect(csvCell('=HYPERLINK("//evil","x")')).toBe('"\'=HYPERLINK(""//evil"",""x"")"');
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+1+1')).toBe("'+1+1"); // '+' with a trailing operator is a formula, not a number
    expect(csvCell('-1+1')).toBe("'-1+1"); // '-' with a trailing operator is a formula, not a number
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)"); // neutralized; no structural char → not quoted
    expect(csvCell('\ttab-lead')).toBe('"\'\ttab-lead"'); // leading tab neutralized AND quoted
    expect(csvCell('\rcr-lead')).toBe('"\'\rcr-lead"'); // leading CR neutralized AND quoted
  });

  it('leaves normal values untouched (incl. legitimate negative/positive numbers)', () => {
    expect(csvCell('SOL/USDC')).toBe('SOL/USDC');
    expect(csvCell('Spot')).toBe('Spot');
    expect(csvCell(-5.3)).toBe('-5.3'); // a negative PnL is a NUMBER, not a formula — do not corrupt the column
    expect(csvCell('-5.3')).toBe('-5.3');
    expect(csvCell('+42')).toBe('+42');
    expect(csvCell('1.2e-7')).toBe('1.2e-7'); // scientific notation is still a plain number
    expect(csvCell(0)).toBe('0');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('preserves RFC-4180 quoting of structural chars (", comma, newline, CR, tab)', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""'); // embedded quote is doubled
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('mid\ttab')).toBe('"mid\ttab"'); // tab NOT leading → quoted, not prefixed
  });
});
