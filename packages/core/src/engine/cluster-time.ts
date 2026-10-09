import type { Timestamp } from 'mongodb';

const MAX_INCREMENT = 0xffff_ffff;

type TimestampClass = new (value: { t: number; i: number }) => Timestamp;

/**
 * The smallest cluster time after `time`. Built with `time`'s own constructor: the value goes back
 * to the server through the app's driver, which rejects BSON values from another driver copy.
 */
export function nextClusterTime(time: Timestamp): Timestamp {
  const Next = time.constructor as TimestampClass;
  const { t, i } = time;
  return i < MAX_INCREMENT ? new Next({ t, i: i + 1 }) : new Next({ t: t + 1, i: 0 });
}
