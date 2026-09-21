export interface IsolatedSlotTask<T = unknown> {
  slot: string;
  timeoutMs: number;
  run(signal: AbortSignal): T | Promise<T>;
}

export interface IsolatedSlotResult<T = unknown> {
  ok: boolean;
  value?: T;
  error?: Error;
}

async function runOne<T>(task: IsolatedSlotTask<T>): Promise<IsolatedSlotResult<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`slot ${task.slot} timed out after ${task.timeoutMs}ms`);
      reject(error);
      controller.abort(error);
    }, task.timeoutMs);
  });
  try {
    const value = await Promise.race([Promise.resolve().then(() => task.run(controller.signal)), timeout]);
    return {ok: true, value};
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error : new Error(String(error))};
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runIsolatedSlots<T>(tasks: IsolatedSlotTask<T>[]): Promise<Map<string, IsolatedSlotResult<T>>> {
  const entries = await Promise.all(tasks.map(async (task) => [task.slot, await runOne(task)] as const));
  return new Map(entries);
}
