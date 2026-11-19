import { describe, expect, it } from 'vitest';
import { formatPerVote, prizeFor } from '../../src/modules/battles/prize.js';

describe('growing prize', () => {
  const rules = { base: 300, threshold: 600, perHundred: 50 };
  it('stays at the base until the threshold, then adds half a star per vote (rounded down), without a ceiling', () => {
    expect(prizeFor(0, rules)).toEqual({ stars: 300, left: 600, paidVotes: 0 });
    expect(prizeFor(556, rules)).toMatchObject({ stars: 300, left: 44 });
    expect(prizeFor(600, rules)).toMatchObject({ stars: 300, left: 0 });
    expect(prizeFor(601, rules)).toMatchObject({ stars: 300 });
    expect(prizeFor(700, rules)).toMatchObject({ stars: 350 });
    expect(prizeFor(30_600, rules)).toMatchObject({ stars: 15_300 });
    expect(formatPerVote(50)).toBe('0,5');
    expect(formatPerVote(100)).toBe('1');
  });
});
