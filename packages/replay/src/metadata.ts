import type { TaroReplayMetadata } from './types';

/** Merge explicit fields without mutating either source or serializing null contexts. */
export function mergeReplayContexts(
  defaults: TaroReplayMetadata['contexts'],
  custom: TaroReplayMetadata['contexts'],
  preserveNull = false,
): NonNullable<TaroReplayMetadata['contexts']> {
  const result: NonNullable<TaroReplayMetadata['contexts']> = {};
  for (const source of [defaults, custom]) {
    for (const [name, value] of Object.entries(source || {})) {
      if (value === null) {
        // Untyped JS may pass null although older SDK declarations cannot accept
        // it. Retain that tombstone in recorder metadata, then omit it on send.
        if (preserveNull) Reflect.set(result, name, null);
        else delete result[name];
      } else result[name] = { ...result[name], ...value };
    }
  }
  return result;
}
