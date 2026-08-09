/**
 * Serialize async mutations per key without retaining every historical key.
 *
 * The always-resolving tail lets a later mutation continue after an earlier
 * failure, while the identity check prevents an older completion from deleting
 * a newer queued tail for the same key.
 */
export function enqueueKeyedMutation<K, T>(
  chains: Map<K, Promise<void>>,
  key: K,
  operation: () => Promise<T>
): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const settled = run.then(() => undefined, () => undefined);
  chains.set(key, settled);
  void settled.finally(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return run;
}