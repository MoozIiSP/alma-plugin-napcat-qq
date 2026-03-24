import { ALMA_THREAD_CREATE_TIMEOUT_MS, ALMA_THREAD_WS_URL } from '../core/constants';

export type AlmaThreadRecord = {
  id: string;
  title?: string;
  updatedAt?: string;
  createdAt?: string;
};

export function getAlmaApiBaseUrl(): string {
  // Alma only exposes the thread API base over HTTP; derive it from the fixed WS endpoint
  // so both transports stay on the same host/port.
  const wsUrl = new URL(ALMA_THREAD_WS_URL);
  wsUrl.protocol = wsUrl.protocol === 'wss:' ? 'https:' : 'http:';
  wsUrl.pathname = '';
  wsUrl.search = '';
  wsUrl.hash = '';
  return wsUrl.toString().replace(/\/$/, '');
}

export async function createAlmaThread(
  title: string,
  deps: {
    writeDebugLog: (level: 'INFO', message: string, extra?: unknown) => void;
    logger: { error: (message: string, error: unknown) => void };
  },
): Promise<AlmaThreadRecord> {
  const endpoint = `${getAlmaApiBaseUrl()}/api/threads`;
  deps.writeDebugLog('INFO', 'Creating Alma thread', { title });

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title }),
      signal: AbortSignal.timeout(ALMA_THREAD_CREATE_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Failed to create Alma thread: ${response.status} ${response.statusText}`);
    }

    const created = await response.json() as AlmaThreadRecord;
    deps.writeDebugLog('INFO', 'Created Alma thread', {
      threadId: created.id,
      title,
    });
    return created;
  } catch (error) {
    deps.logger.error('Failed to create Alma thread', error);
    throw error;
  }
}

export async function listAlmaThreads(
  limit: number,
  deps: {
    writeDebugLog: (level: 'INFO', message: string, extra?: unknown) => void;
    logger: { error: (message: string, error: unknown) => void };
  },
): Promise<AlmaThreadRecord[]> {
  // Recent-thread listing is enough for our mapping guard because QQ thread mappings should
  // always point at actively used Alma threads.
  const endpoint = `${getAlmaApiBaseUrl()}/api/threads?limit=${limit}`;

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      signal: AbortSignal.timeout(ALMA_THREAD_CREATE_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Failed to list Alma threads: ${response.status} ${response.statusText}`);
    }

    const threads = await response.json() as AlmaThreadRecord[];
    return Array.isArray(threads) ? threads : [];
  } catch (error) {
    deps.logger.error('Failed to list Alma threads', error);
    throw error;
  }
}
