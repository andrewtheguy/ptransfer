import type { DirectoryDescription } from './webtor-api';

/**
 * Whether a stored Tor directory is still worth handing to a client.
 *
 * The reading of a seed — its validity window and the onion-service time
 * period it places descriptors in — is webtor's (`describeDirectory`), so
 * that there is no second consensus parser here to drift from the one that
 * will place the descriptors. The judgement on top of that reading is ours,
 * and it is the same whether the seed came from IndexedDB in a tab or from a
 * file under the CLI's cache directory, which is why it lives here on its own
 * with no storage API in sight.
 */

/** A seed with less life than this left would expire during the bootstrap. */
const MIN_REMAINING_MS = 10 * 60 * 1000;

export interface SeedVerdict {
  usable: boolean;
  /** Why not, phrased to follow "Ignoring the cached directory:". */
  reason?: string;
}

/**
 * Whether a directory still describes the network as it is now — both that
 * its consensus is live, and that it belongs to the onion-service time period
 * in force at `now`.
 *
 * The second half is the one that is easy to miss. A consensus stays valid for
 * three hours, but the period rotates on its own schedule, so a seed saved at
 * 11:00 UTC is still perfectly valid at 13:00 and still places the HSDir ring
 * where it was before noon. Seeding a client with it sends every descriptor
 * lookup to relays the service never uploaded to, and seeding a *service* with
 * it publishes where no current client will look.
 *
 * This rule is ours, not webtor's: webtor installs any seed whose consensus is
 * signed and timely, which is the right bar for a client that will download a
 * fresh directory anyway. A transfer wants both peers on one ring.
 */
export function judgeDescription(
  described: DirectoryDescription | undefined,
  now: number = Date.now(),
): SeedVerdict {
  if (!described) {
    return { usable: false, reason: 'it carries no readable consensus' };
  }
  const validAfter = described.validAfter.getTime();
  const validUntil = described.validUntil.getTime();
  if (now < validAfter) {
    return { usable: false, reason: 'its consensus is not valid yet' };
  }
  if (now + MIN_REMAINING_MS > validUntil) {
    return {
      usable: false,
      reason: `its consensus expires at ${described.validUntil.toISOString()}`,
    };
  }
  if (described.timePeriod !== described.timePeriodAt(now)) {
    return {
      usable: false,
      reason:
        'its consensus is from a previous onion-service time period, which ' +
        'would place every descriptor on the wrong HSDirs',
    };
  }
  return { usable: true };
}
