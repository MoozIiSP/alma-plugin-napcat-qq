export const MAX_HISTORY_SIZE = 100;
export const MAX_MESSAGE_INDEX_SIZE = 200;
export const MESSAGE_DEDUP_WINDOW_MS = 2 * 60 * 1000;

export const STORAGE_KEYS = {
  history: 'qqchannel.messageHistory',
  threads: 'qqchannel.threads',
  messageIndex: 'qqchannel.messageIndex',
} as const;

export const DEBUG_LOG_PATH = '/tmp/alma-plugin-napcat-qq.log';
export const PLUGIN_ID = 'channel-napcat-qq';
export const ALMA_THREAD_WS_URL = 'ws://127.0.0.1:23001/ws/threads';
export const SETTINGS_SECTION_ID = `${PLUGIN_ID}.runtime`;
export const STATUS_BAR_ID = `${PLUGIN_ID}.status`;
export const SIDEBAR_VIEW_ID = `${PLUGIN_ID}.runtime-status`;
export const RECONNECT_BASE_DELAY_MS = 1000;
export const RECONNECT_MAX_DELAY_MS = 30000;
export const ALMA_THREAD_CREATE_TIMEOUT_MS = 10000;
export const ALMA_TEXT_RESPONSE_TIMEOUT_MS = 180000;
export const ALMA_VISION_RESPONSE_TIMEOUT_MS = 240000;
export const ALMA_TASK_RESPONSE_TIMEOUT_MS = 300000;
export const GROUP_CONTEXT_MESSAGE_LIMIT = 20;
export const GROUP_CONTEXT_CHAR_LIMIT = 4000;
export const GROUP_CONTEXT_LOOKBACK_SECONDS = 15 * 60;
export const GROUP_OPEN_REPLY_POLL_MS = 5000;
export const GROUP_REPLY_DELAY_MENTION_MS = 800;
export const GROUP_REPLY_DELAY_OPEN_MS = 1500;
export const GROUP_REPLY_DELAY_JITTER_MS = 1200;
export const GROUP_OPEN_REPLY_MAX_LENGTH = 120;
export const GROUP_NO_REPLY_SENTINEL = '[[NO_REPLY]]';
export const IMAGE_CACHE_DIR = '/tmp/alma-plugin-napcat-qq-images';
export const WS_OPEN = 1;
