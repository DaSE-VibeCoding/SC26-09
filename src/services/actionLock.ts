export interface ActionLock {
  current: boolean;
}

export async function runIfNotInFlight(
  lock: ActionLock,
  operation: () => Promise<void>,
): Promise<boolean> {
  if (lock.current) return false;

  lock.current = true;
  try {
    await operation();
    return true;
  } finally {
    lock.current = false;
  }
}
