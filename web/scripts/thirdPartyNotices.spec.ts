import { describe, expect, it } from 'vitest';
import { isAllowedLicense, renderNotice, toPackageEntries } from './thirdPartyNotices';

describe('isAllowedLicense', () => {
  it('accepts permissive licenses', () => {
    expect(isAllowedLicense('MIT')).toBe(true);
    expect(isAllowedLicense('Apache-2.0')).toBe(true);
  });

  it('accepts the font license of the self-hosted typefaces', () => {
    expect(isAllowedLicense('OFL-1.1')).toBe(true);
  });

  it('refuses copyleft and unknown licenses', () => {
    expect(isAllowedLicense('GPL-3.0-only')).toBe(false);
    expect(isAllowedLicense('AGPL-3.0-or-later')).toBe(false);
    expect(isAllowedLicense('UNKNOWN')).toBe(false);
  });

  it('accepts a choice when one alternative is allowed, a combination only when all are', () => {
    expect(isAllowedLicense('(MIT OR GPL-3.0-only)')).toBe(true);
    expect(isAllowedLicense('(MIT AND CC0-1.0)')).toBe(true);
    expect(isAllowedLicense('(MIT AND GPL-3.0-only)')).toBe(false);
  });
});

describe('toPackageEntries', () => {
  it('lists every version of every package, sorted by name', () => {
    const report = {
      MIT: [{ name: 'zod', versions: ['4.6.5'], paths: ['/z'], license: 'MIT' }],
      ISC: [
        { name: 'semver', versions: ['6.3.1', '7.7.2'], paths: ['/s6', '/s7'], license: 'ISC' },
      ],
    };

    expect(toPackageEntries(report)).toEqual([
      { name: 'semver', version: '6.3.1', license: 'ISC', path: '/s6' },
      { name: 'semver', version: '7.7.2', license: 'ISC', path: '/s7' },
      { name: 'zod', version: '4.6.5', license: 'MIT', path: '/z' },
    ]);
  });
});

describe('renderNotice', () => {
  const entry = { name: 'zod', version: '4.6.5', license: 'MIT', path: '/z' };

  it('reproduces the license and notice texts under a heading', () => {
    expect(renderNotice(entry, ['MIT License', 'NOTICE text'])).toBe(
      'zod 4.6.5 (MIT)\n---------------\n\nMIT License\n\nNOTICE text\n',
    );
  });

  it('names the license when the package ships no license file', () => {
    expect(renderNotice(entry, [])).toContain('its license is MIT');
  });
});
