import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJsonStringify, sha256Hex } from '../src/shared/canonicalHash';
import { runAllAcceptanceTests } from '../src/shared/selfTestSuite';

describe('THE LOOPHOLE Rev.15.2 Acceptance Test Suite (AT-01 ~ AT-21)', () => {
  it('matches Node.js crypto SHA-256 bit-for-bit', () => {
    const sample = canonicalJsonStringify({
      b: [1, 2, 3],
      a: 'cleanco_v1',
      nested: { z: true, m: null },
    });
    const expected = createHash('sha256').update(sample, 'utf8').digest('hex');
    expect(sha256Hex(sample)).toBe(expected);
  });

  const suiteReport = runAllAcceptanceTests();
  for (const item of suiteReport.results) {
    it(`${item.id}: ${item.title} (${item.requirementRef})`, () => {
      expect(item.status, item.detail).toBe('PASS');
    });
  }
});
