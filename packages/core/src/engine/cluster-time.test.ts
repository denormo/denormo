import { Timestamp } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { nextClusterTime } from './cluster-time.js';

/** Stands in for a Timestamp class from another driver copy. */
class ForeignTimestamp extends Timestamp {}

describe('nextClusterTime', () => {
  it('returns the next increment in the same second', () => {
    const next = nextClusterTime(new Timestamp({ t: 5, i: 1 }));
    expect({ t: next.t, i: next.i }).toEqual({ t: 5, i: 2 });
  });

  it('rolls over to the next second after the largest increment', () => {
    const next = nextClusterTime(new Timestamp({ t: 5, i: 0xffff_ffff }));
    expect({ t: next.t, i: next.i }).toEqual({ t: 6, i: 0 });
  });

  it("builds the result with the input's own class, so it matches the app's driver", () => {
    const next = nextClusterTime(new ForeignTimestamp({ t: 5, i: 1 }));
    expect(next).toBeInstanceOf(ForeignTimestamp);
  });
});
