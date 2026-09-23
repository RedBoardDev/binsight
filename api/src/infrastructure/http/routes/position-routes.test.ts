import { describe, expect, it } from 'vitest';
import { csvCell } from './position-routes';

describe('csvCell — CSV export cell (formula injection guard)', () => {
  it('prefixes text a spreadsheet would run as a formula with a quote', () => {
    // Token symbols (hence the Pair column) are chosen by whoever minted the token: a symbol like
    // `=HYPERLINK(...)` would otherwise execute when the owner opens the export in Excel/Sheets.
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+SUM(A1)')).toBe("'+SUM(A1)");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('still CSV-quotes a neutralised cell that contains a quote or comma', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
  });

  it('leaves negative numbers alone — a losing PnL must stay a number, not become text', () => {
    // The guard keys on typeof string: numbers are ours, never attacker-controlled.
    expect(csvCell(-1.5)).toBe('-1.5');
    expect(csvCell(-0.0042)).toBe('-0.0042');
    expect(csvCell(0)).toBe('0');
  });

  it('passes ordinary text through and renders null/undefined as an empty cell', () => {
    expect(csvCell('SOL/USDC')).toBe('SOL/USDC');
    expect(csvCell('a-b')).toBe('a-b'); // a dash that is not leading is harmless
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
});
