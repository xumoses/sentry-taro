import { snapshotNetworkOptions, type NetworkDetailOptions } from '../sdk/network-details';

/** Override network accessors without invoking them during a later options spread. */
export function withNetworkOptionsSnapshot<T extends NetworkDetailOptions>(
  options: T,
  snapshot: Required<NetworkDetailOptions> = snapshotNetworkOptions(options),
): T {
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(options),
      ...Object.getOwnPropertyDescriptors(snapshot),
    },
  ) as T;
}
