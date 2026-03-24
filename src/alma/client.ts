import { ALMA_THREAD_CREATE_TIMEOUT_MS, ALMA_THREAD_WS_URL } from '../core/constants';

export type AlmaThreadRecord = {
  id: string;
  title?: string;
};

export function getAlmaApiBaseUrl(): string {
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
