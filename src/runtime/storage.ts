import { mkdirSync } from 'node:fs';
import path from 'node:path';

export type StorageAdapter = {
  kind: string;
  get<T>(key: string, defaultValue?: T): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
};

function deserializeStoredValue<T>(value: unknown, defaultValue?: T): T | undefined {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value !== 'string') {
    return value as T;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return value as T;
  }
}

function isEnoentError(error: unknown): error is NodeJS.ErrnoException & { path?: string } {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function ensureStorageParentDir(error: unknown): boolean {
  if (!isEnoentError(error) || typeof error.path !== 'string' || !error.path) {
    return false;
  }

  try {
    mkdirSync(path.dirname(error.path), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

async function runStorageOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (ensureStorageParentDir(error)) {
      return operation();
    }

    throw error;
  }
}

export function createMemoryStorageAdapter(
  memoryStorage: Map<string, unknown>,
  kind: string,
): StorageAdapter {
  return {
    kind,
    async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
      return (memoryStorage.get(key) as T | undefined) ?? defaultValue;
    },
    async set<T>(key: string, value: T): Promise<void> {
      memoryStorage.set(key, value);
    },
    async remove(key: string): Promise<void> {
      memoryStorage.delete(key);
    },
    async keys(): Promise<string[]> {
      return Array.from(memoryStorage.keys());
    },
  };
}

export function createStructuredStorageAdapter(
  kind: string,
  candidate: any,
  hooks: {
    downgradeStorageAdapter: (reason: unknown) => StorageAdapter;
  },
): StorageAdapter | null {
  if (!candidate) {
    return null;
  }

  if (typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function') {
    return {
      kind,
      async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
        try {
          return deserializeStoredValue<T>(
            await runStorageOperation(() => candidate.getItem(key)),
            defaultValue,
          );
        } catch (error) {
          return hooks.downgradeStorageAdapter(error).get(key, defaultValue);
        }
      },
      async set<T>(key: string, value: T): Promise<void> {
        try {
          await runStorageOperation(() => candidate.setItem(key, JSON.stringify(value)));
        } catch (error) {
          await hooks.downgradeStorageAdapter(error).set(key, value);
        }
      },
      async remove(key: string): Promise<void> {
        if (typeof candidate.removeItem === 'function') {
          try {
            await runStorageOperation(() => candidate.removeItem(key));
          } catch (error) {
            await hooks.downgradeStorageAdapter(error).remove(key);
          }
        }
      },
      async keys(): Promise<string[]> {
        if (typeof candidate.keys === 'function') {
          try {
            return Array.from(await runStorageOperation(() => candidate.keys()));
          } catch (error) {
            return hooks.downgradeStorageAdapter(error).keys();
          }
        }
        return [];
      },
    };
  }

  if (typeof candidate.get !== 'function') {
    return null;
  }

  const setMethod =
    typeof candidate.set === 'function' ? candidate.set.bind(candidate) :
    typeof candidate.store === 'function' ? candidate.store.bind(candidate) :
    typeof candidate.update === 'function' ? candidate.update.bind(candidate) :
    null;

  if (!setMethod) {
    return null;
  }

  const deleteMethod =
    typeof candidate.delete === 'function' ? candidate.delete.bind(candidate) :
    typeof candidate.remove === 'function' ? candidate.remove.bind(candidate) :
    typeof candidate.update === 'function' ? ((key: string) => candidate.update(key, undefined)) :
    null;

  return {
    kind,
    async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
      try {
        const value = candidate.get.length >= 2
          ? await runStorageOperation(() => candidate.get(key, defaultValue))
          : await runStorageOperation(() => candidate.get(key));
        return deserializeStoredValue<T>(value, defaultValue);
      } catch (error) {
        return hooks.downgradeStorageAdapter(error).get(key, defaultValue);
      }
    },
    async set<T>(key: string, value: T): Promise<void> {
      try {
        await runStorageOperation(() => setMethod(key, JSON.stringify(value)));
      } catch (error) {
        await hooks.downgradeStorageAdapter(error).set(key, value);
      }
    },
    async remove(key: string): Promise<void> {
      if (deleteMethod) {
        try {
          await runStorageOperation(() => deleteMethod(key));
        } catch (error) {
          await hooks.downgradeStorageAdapter(error).remove(key);
        }
      }
    },
    async keys(): Promise<string[]> {
      if (typeof candidate.keys === 'function') {
        try {
          return Array.from(await runStorageOperation(() => candidate.keys()));
        } catch (error) {
          return hooks.downgradeStorageAdapter(error).keys();
        }
      }
      return [];
    },
  };
}

export function resolveStorageAdapter(
  runtimeContext: any,
  hooks: {
    existingAdapter: StorageAdapter | null;
    setAdapter: (adapter: StorageAdapter) => void;
    createMemoryAdapter: (kind: string) => StorageAdapter;
    createStructuredAdapter: (kind: string, candidate: any) => StorageAdapter | null;
    onMissing: () => void;
  },
): StorageAdapter {
  if (hooks.existingAdapter) {
    return hooks.existingAdapter;
  }

  const rawStorage = runtimeContext?.storage;
  const candidates: Array<[string, any]> = [
    ['storage.state', rawStorage?.state],
    ['storage.global', rawStorage?.global],
    ['storage.workspace', rawStorage?.workspace],
    ['storage.local', rawStorage?.local],
    ['storage.secrets', rawStorage?.secrets],
    ['storage', rawStorage],
    ['globalState', runtimeContext?.globalState],
    ['workspaceState', runtimeContext?.workspaceState],
  ];

  for (const [kind, candidate] of candidates) {
    const adapter = hooks.createStructuredAdapter(kind, candidate);
    if (adapter) {
      hooks.setAdapter(adapter);
      return adapter;
    }
  }

  const fallback = hooks.createMemoryAdapter('memory-fallback');
  hooks.setAdapter(fallback);
  hooks.onMissing();
  return fallback;
}
