/** Sample-rate clamping and Replay id generation, matching the official integration's rules. */

export const clampRate = (value: number | undefined): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value || 0)) : 0;

export const sampled = (rate: number, random: () => number): boolean =>
  rate > 0 && (rate >= 1 || random() < rate);

export function createReplayId(random: () => number): string {
  let value = '';
  for (let index = 0; index < 32; index++) value += Math.floor(random() * 16).toString(16);
  return value;
}
