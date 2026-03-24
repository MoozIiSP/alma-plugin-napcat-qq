/**
 * QQ NapCat Channel Plugin for Alma
 * ==========================
 * Integrates QQ messaging via NapCat/OneBot 11 API with Alma's plugin system.
 *
 * Features:
 * - WebSocket connection for real-time message receiving
 * - WebSocket RPC for sending messages
 * - @ mention detection and trigger-based responses
 * - Rate limiting and cooldown management
 * - Group and private message support
 * - Message history tracking
 */

import { appendFileSync } from 'node:fs';
import WebSocket from 'ws';
import { z } from 'zod';
import type {
  PluginContext,
  PluginActivation,
  ToolContext,
  IncomingMessage,
  MessageHandler,
  CommandContext,
  QQMessageEvent,
  ThreadInfo,
  ThreadContext,
  MessageSegment,
} from './src/core/types';
import { QQ_MESSAGE_EVENTS } from './src/core/types';
import {
  ThreadIdGenerator,
  buildThreadInfo,
  createThreadContext,
  ThreadManager,
  extractTargetFromThreadId,
} from './src/core/thread-utils';
import {
  ALMA_TASK_RESPONSE_TIMEOUT_MS,
  ALMA_TEXT_RESPONSE_TIMEOUT_MS,
  ALMA_THREAD_CREATE_TIMEOUT_MS,
  ALMA_THREAD_WS_URL,
  ALMA_VISION_RESPONSE_TIMEOUT_MS,
  DEBUG_LOG_PATH,
  GROUP_CONTEXT_CHAR_LIMIT,
  GROUP_CONTEXT_MESSAGE_LIMIT,
  GROUP_NO_REPLY_SENTINEL,
  GROUP_OPEN_REPLY_MAX_LENGTH,
  GROUP_REPLY_DELAY_JITTER_MS,
  GROUP_REPLY_DELAY_MENTION_MS,
  GROUP_REPLY_DELAY_OPEN_MS,
  IMAGE_CACHE_DIR,
  MAX_HISTORY_SIZE,
  MAX_MESSAGE_INDEX_SIZE,
  MESSAGE_DEDUP_WINDOW_MS,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  SETTINGS_SECTION_ID,
  SIDEBAR_VIEW_ID,
  STATUS_BAR_ID,
  STORAGE_KEYS,
  WS_OPEN,
} from './src/core/constants';
import { getEffectiveConfig, loadConfig, type QQChannelConfig } from './src/core/config';
import {
  buildGroupHistoryContext as buildGroupHistoryContextFromMessages,
  getSenderLabel as getSenderLabelFromMessage,
} from './src/messages/group-context';
import {
  buildDataUrlFromLocalImage,
  downloadImageToLocalCache,
  getPrimaryImageSource as getPrimaryImageSourceFromImages,
} from './src/messages/image-utils';
import {
  createRuntimeStatusController,
  installDebugLogMirror as installDebugLogMirrorBase,
  showNotification as showNotificationBase,
  writeDebugLog as writeDebugLogToPath,
  type DebugLogLevel,
} from './src/runtime/ui';
import {
  buildOutboundSegments,
  buildThreadId,
  forwardMessageToAlma as forwardMessageToAlmaBase,
  resolveChatTargetFromToolContext,
  sendFileViaBridge as sendFileViaBridgeBase,
  sendImageViaBridge as sendImageViaBridgeBase,
  sendMessageViaBridge as sendMessageViaBridgeBase,
  sendSegmentsToTarget as sendSegmentsToTargetBase,
  sendThreadMessage as sendThreadMessageBase,
} from './src/qq/send';
import {
  buildIncomingImageDebugPayload,
  buildNapCatWebSocketUrl,
  parseCQCode,
  segmentToText,
  webSocketDataToText,
} from './src/protocol/napcat';
import {
  createMemoryStorageAdapter,
  createStructuredStorageAdapter as createStructuredStorageAdapterBase,
  resolveStorageAdapter as resolveStorageAdapterBase,
  type StorageAdapter,
} from './src/runtime/storage';
import {
  buildErrorReply as buildErrorReplyBase,
  buildReplyStrategy as buildReplyStrategyBase,
  checkAtCooldown as checkAtCooldownBase,
  checkRateLimit as checkRateLimitBase,
  generateReply as generateReplyBase,
  getAlmaResponseTimeoutMs,
  getErrorSummary,
  getImageFallbackReply as getImageFallbackReplyBase,
  isAllowedSource as isAllowedSourceBase,
  isTaskLikeRequest,
  markAtReplied as markAtRepliedBase,
  normalizeGeneratedReply as normalizeGeneratedReplyBase,
  shouldRespond as shouldRespondBase,
  type ReplyStrategy,
} from './src/messages/reply-logic';
import {
  createAlmaThread as createAlmaThreadBase,
  getAlmaApiBaseUrl,
  type AlmaThreadRecord,
} from './src/alma/client';

// ============================================================================
// NapCat/OneBot Types
// ============================================================================

interface NapCatMessage {
  message_id: number;
  user_id: number;
  group_id?: number;
  message_type: 'private' | 'group';
  message: Array<{ type: string; data: Record<string, any> }>;
  raw_message?: string;
  time: number;
}

interface NapCatResponse<T> {
  status: string;
  retcode: number;
  data: T;
  message: string;
  echo?: string;
}

interface NapCatLoginInfo {
  user_id: number;
  nickname: string;
}

interface NapCatSendMessageResult {
  message_id?: number;
  messageId?: number;
}

// ============================================================================
// Message Types
// ============================================================================

enum TriggerType {
  AT_BOT = 'at_bot',
  AT_ANYONE = 'at_anyone',
  KEYWORD = 'keyword',
  REPLY_TO_BOT = 'reply_to_bot',
  COMMAND_PREFIX = 'command_prefix',
  DIRECT_MESSAGE = 'direct_message',
  ALWAYS = 'always',
}

interface Mention {
  qq: string;
  name?: string;
  startPos: number;
  endPos: number;
}

interface ParsedMessage {
  messageId: number;
  userId: string;
  senderName?: string;
  groupId?: string;
  messageType: 'private' | 'group';
  rawMessage: string;
  textContent: string;
  mentions: Mention[];
  isAtBot: boolean;
  atBotPosition: number;
  triggerTypes: TriggerType[];
  matchedKeywords: string[];
  matchedCommandPrefix?: string;
  timestamp: number;
  images: Array<{ file?: string; url?: string }>;
  // Thread information
  threadInfo: ThreadInfo;
  threadContext: ThreadContext;
  isReplyToBot: boolean;
}

interface PersistedMessageIndexEntry {
  messageId: number;
  threadId: string;
  userId: string;
  isBot: boolean;
  timestamp: number;
}

// ============================================================================
// Plugin State
// ============================================================================

let pluginContext: PluginContext;
let config: QQChannelConfig;
type RuntimeWebSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
};
let wsConnection: RuntimeWebSocket | null = null;
let isConnected = false;
let persistPromise: Promise<void> = Promise.resolve();
let wsConnectPromise: Promise<void> | null = null;
let storageAdapter: StorageAdapter | null = null;
let hasWarnedStorageFallback = false;
let hasWarnedEventEmitUnavailable = false;
let requestSequence = 0;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let shouldReconnect = true;
const pendingRequests = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

// Rate limiting state
const rateLimitMap = new Map<string, number[]>(); // userId -> timestamps
const atCooldownMap = new Map<string, number>(); // userId -> last reply timestamp

// Message history for context
const messageHistory: ParsedMessage[] = [];
const messageIndex = new Map<number, PersistedMessageIndexEntry>();
const processedMessageIds = new Map<number, number>();

// Thread manager for tracking active threads
const threadManager = new ThreadManager();
let hasShownFirstMessageNotification = false;
const memoryStorage = new Map<string, unknown>();
let runtimeStatusController: ReturnType<typeof createRuntimeStatusController>;
const runtimeStatus = {
  connection: 'disconnected',
  lastMessage: '',
  lastThreadId: '',
  lastError: '',
  duplicateHits: 0,
  reconnectDelayMs: 0,
};

function writeDebugLog(level: DebugLogLevel, message: string, extra?: unknown): void {
  writeDebugLogToPath(DEBUG_LOG_PATH, level, message, extra);
}

function installDebugLogMirror(ctx: PluginContext): void {
  installDebugLogMirrorBase(ctx, DEBUG_LOG_PATH);
}

function updateRuntimeStatus(patch: Partial<typeof runtimeStatus>): void {
  Object.assign(runtimeStatus, patch);
  runtimeStatusController?.update(patch);
}

function emitPluginEvent<T>(eventName: string, payload: T): void {
  const events = (pluginContext as PluginContext & {
    events?: {
      emit?: (event: string, data: T) => void;
    };
  }).events;

  if (typeof events?.emit !== 'function') {
    if (!hasWarnedEventEmitUnavailable) {
      hasWarnedEventEmitUnavailable = true;
      writeDebugLog('WARN', 'Plugin event emit API unavailable; QQ event broadcast disabled');
    }
    return;
  }

  try {
    events.emit(eventName, payload);
  } catch (error) {
    pluginContext.logger.warn('Failed to emit plugin event', { eventName, error });
  }
}

function registerRuntimeStatusView(): void {
  runtimeStatusController?.registerView();
}

function showNotification(
  message: string,
  type: 'info' | 'warning' | 'error' = 'info',
): void {
  showNotificationBase(pluginContext, DEBUG_LOG_PATH, message, type);
}

function getWebSocketConstructor(): new (url: string) => RuntimeWebSocket {
  // Alma's plugin host may try to resolve WebSocket from the plugin directory at runtime.
  // Use the bundled ws client directly so the plugin remains self-contained after install.
  return WebSocket as unknown as new (url: string) => RuntimeWebSocket;
}

function downgradeStorageAdapter(reason: unknown): StorageAdapter {
  if (storageAdapter?.kind !== 'memory-fallback') {
    storageAdapter = createMemoryStorageAdapter(memoryStorage, 'memory-fallback');
  }

  if (!hasWarnedStorageFallback) {
    hasWarnedStorageFallback = true;
    pluginContext.logger.warn(
      'QQ NapCat Channel storage backend is unavailable; falling back to in-memory state for this session.',
      reason,
    );
  }

  return storageAdapter;
}

function createStructuredStorageAdapter(kind: string, candidate: any): StorageAdapter | null {
  return createStructuredStorageAdapterBase(kind, candidate, {
    downgradeStorageAdapter,
  });
}

function resolveStorageAdapter(): StorageAdapter {
  return resolveStorageAdapterBase(pluginContext as any, {
    existingAdapter: storageAdapter,
    setAdapter: adapter => {
      storageAdapter = adapter;
    },
    createMemoryAdapter: kind => createMemoryStorageAdapter(memoryStorage, kind),
    createStructuredAdapter: (kind, candidate) => createStructuredStorageAdapter(kind, candidate),
    onMissing: () => {
      pluginContext.logger.warn(
        'QQ NapCat Channel did not find a compatible Alma storage API; state persistence is disabled for this session.',
      );
    },
  });
}

// ============================================================================
// NapCat API Client
// ============================================================================

async function napcatRequest<T>(endpoint: string, data?: Record<string, any>): Promise<T> {
  await connectWebSocket();

  if (!wsConnection || wsConnection.readyState !== WS_OPEN) {
    throw new Error('NapCat WebSocket is not connected');
  }

  const action = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  const echo = `channel-napcat-qq:${Date.now()}:${requestSequence++}`;

  const result = await new Promise<NapCatResponse<T>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(echo);
      reject(new Error(`NapCat WebSocket request timed out: ${action}`));
    }, 15000);

    pendingRequests.set(echo, {
      resolve: value => resolve(value as NapCatResponse<T>),
      reject,
      timeout,
    });

    try {
      wsConnection!.send(JSON.stringify({
        action,
        params: data || {},
        echo,
      }));
    } catch (error) {
      const pending = pendingRequests.get(echo);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingRequests.delete(echo);
      }
      reject(error);
    }
  });

  if (result.retcode !== 0 || result.status === 'failed') {
    throw new Error(`NapCat API error: ${result.message || action}`);
  }

  return result.data;
}

function parseMessage(data: any): ParsedMessage {
  const messageId = data.message_id || 0;
  const userId = String(data.user_id);
  const senderName =
    data?.sender?.card?.trim() ||
    data?.sender?.nickname?.trim() ||
    undefined;
  const groupId = data.group_id ? String(data.group_id) : undefined;
  const messageType = data.message_type as 'private' | 'group';
  const effectiveConfig = getEffectiveConfig(config, messageType === 'group' ? groupId : undefined);
  const rawMessage = data.raw_message || '';
  const timestamp = data.time || Date.now() / 1000;

  // Parse message segments
  let segments: Array<{ type: string; data: Record<string, any> }>;
  if (Array.isArray(data.message)) {
    segments = data.message;
  } else if (typeof data.message === 'string') {
    segments = parseCQCode(data.message);
  } else {
    segments = [{ type: 'text', data: { text: rawMessage } }];
  }

  const images = segments
    .filter(seg => seg.type === 'image')
    .map(seg => ({
      file: typeof seg.data.file === 'string' ? seg.data.file : undefined,
      url: typeof seg.data.url === 'string' ? seg.data.url : undefined,
    }))
    .filter(image => image.file || image.url);

  if (images.length > 0) {
    writeDebugLog(
      'INFO',
      'Parsed incoming QQ image segments',
      buildIncomingImageDebugPayload(messageId, groupId, userId, images),
    );
  }

  // Extract mentions and text
  const mentions: Mention[] = [];
  let textContent = '';
  let isAtBot = false;
  let isReplyToBot = false;
  let atBotPosition = -1;
  let position = 0;

  for (const seg of segments) {
    if (seg.type === 'at') {
      const qq = seg.data.qq;
      const mention: Mention = {
        qq,
        name: seg.data.name,
        startPos: position,
        endPos: position + 1,
      };
      mentions.push(mention);

      if (qq === config.botQQ) {
        isAtBot = true;
        atBotPosition = position;
      }

      position++;
    } else if (seg.type === 'text') {
      textContent += seg.data.text;
      position += seg.data.text.length;
    } else if (seg.type === 'reply') {
      if (seg.data.user_id === config.botQQ) {
        isReplyToBot = true;
      }
    } else {
      const marker = segmentToText(seg);
      if (marker) {
        textContent += marker;
        position += marker.length;
      }
    }
  }

  // Detect triggers
  const triggerTypes: TriggerType[] = [];
  const matchedKeywords: string[] = [];
  let matchedCommandPrefix: string | undefined;

  if (isAtBot) {
    triggerTypes.push(TriggerType.AT_BOT);
  }

  if (mentions.length > 0) {
    triggerTypes.push(TriggerType.AT_ANYONE);
  }

  // Check for keywords
  for (const keyword of effectiveConfig.keywords) {
    if (textContent.includes(keyword)) {
      matchedKeywords.push(keyword);
    }
  }

  if (matchedKeywords.length > 0) {
    triggerTypes.push(TriggerType.KEYWORD);
  }

  for (const prefix of effectiveConfig.commandPrefixes) {
    const normalizedPrefix = prefix.trim();
    if (!normalizedPrefix) {
      continue;
    }
    if (textContent.startsWith(normalizedPrefix)) {
      matchedCommandPrefix = normalizedPrefix;
      triggerTypes.push(TriggerType.COMMAND_PREFIX);
      textContent = textContent.slice(normalizedPrefix.length).trimStart() || textContent;
      break;
    }
  }

  if (isReplyToBot) {
    triggerTypes.push(TriggerType.REPLY_TO_BOT);
  }

  if (messageType === 'private') {
    triggerTypes.push(TriggerType.DIRECT_MESSAGE);
  }

  // Build thread info
  const threadInfo = buildThreadInfo(data, config.botQQ);

  // Build thread context
  const replyToMessageId = segments.find(s => s.type === 'reply')?.data.id;
  const replyToUserId = segments.find(s => s.type === 'reply')?.data.user_id;
  const resolvedReplyTarget = findReplyTarget(
    replyToMessageId ? parseInt(replyToMessageId) : undefined,
  );

  if (!isReplyToBot && resolvedReplyTarget?.isBot) {
    isReplyToBot = true;
    triggerTypes.push(TriggerType.REPLY_TO_BOT);
  }

  const threadContext = createThreadContext({
    messageType,
    userId,
    groupId,
    messageId,
    isAtBot,
    replyToMessageId: replyToMessageId ? parseInt(replyToMessageId) : undefined,
    replyToUserId:
      replyToUserId ? String(replyToUserId) : resolvedReplyTarget?.userId,
  });

  // Track thread in manager
  threadManager.getOrCreate(threadInfo, {
    senderId: userId,
    messageId,
  });
  upsertMessageIndex({
    messageId,
    threadId: threadInfo.threadId,
    userId,
    isBot: false,
    timestamp,
  });

  return {
    messageId,
    userId,
    groupId,
    messageType,
    rawMessage,
    textContent,
    mentions,
    isAtBot,
    atBotPosition,
    triggerTypes,
    matchedKeywords,
    matchedCommandPrefix,
    timestamp,
    images,
    threadInfo,
    threadContext,
    isReplyToBot,
  };
}

// ============================================================================
// Trigger Logic
// ============================================================================

function shouldRespond(parsed: ParsedMessage): boolean {
  return shouldRespondBase(parsed, getEffectiveConfig(config, parsed.groupId));
}

function isAllowedSource(parsed: ParsedMessage): boolean {
  return isAllowedSourceBase(parsed, getEffectiveConfig(config, parsed.groupId));
}

// ============================================================================
// Rate Limiting
// ============================================================================

function checkRateLimit(userId: string): boolean {
  return checkRateLimitBase(userId, config, rateLimitMap);
}

function checkAtCooldown(userId: string, groupId?: string): boolean {
  return checkAtCooldownBase(userId, getEffectiveConfig(config, groupId), atCooldownMap);
}

function markAtReplied(userId: string): void {
  markAtRepliedBase(userId, atCooldownMap);
}

// ============================================================================
// Reply Generation
// ============================================================================

function generateReply(parsed: ParsedMessage): string | null {
  return generateReplyBase(parsed, getEffectiveConfig(config, parsed.groupId), rateLimitMap);
}

function createAtMention(qq: string, name?: string): string {
  return `[CQ:at,qq=${qq}${name ? `,name=${name}` : ''}]`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getSenderLabel(message: Pick<ParsedMessage, 'senderName' | 'userId' | 'messageType'>): string {
  return getSenderLabelFromMessage(message);
}

function buildGroupHistoryContext(parsedMessage: ParsedMessage): string {
  const effectiveConfig = getEffectiveConfig(config, parsedMessage.groupId);
  const historyLimit = Math.max(1, effectiveConfig.groupContextMessageLimit || GROUP_CONTEXT_MESSAGE_LIMIT);
  const charLimit = Math.max(500, effectiveConfig.groupContextCharLimit || GROUP_CONTEXT_CHAR_LIMIT);
  return buildGroupHistoryContextFromMessages(parsedMessage, {
    historyLimit,
    charLimit,
    getMessageHistory: (groupId, limit) => getMessageHistory(groupId, limit),
  });
}

function buildAlmaInputText(parsedMessage: ParsedMessage): string {
  const effectiveConfig = getEffectiveConfig(config, parsedMessage.groupId);
  const hasImages = parsedMessage.images.length > 0;
  const trimmedText = parsedMessage.textContent.trim();
  const imageAwareText = hasImages
    ? (trimmedText && trimmedText !== '[图片]'
      ? [
          '用户发送了一张图片，并附带了以下文字：',
          trimmedText,
          '',
          '请结合图片内容和文字内容理解并回复。',
        ].join('\n')
      : '用户发送了一张图片。请结合图片内容理解并回复。')
    : parsedMessage.textContent;

  if (parsedMessage.messageType !== 'group') {
    return imageAwareText;
  }

  const senderLabel = getSenderLabel(parsedMessage);
  const currentMessage = [
    '当前需要回复的消息：',
    `[${senderLabel} ${parsedMessage.userId}] ${hasImages ? imageAwareText : parsedMessage.textContent}`,
  ].join('\n');

  if (!effectiveConfig.respondToGroupMessage) {
    return currentMessage;
  }

  const historyContext = buildGroupHistoryContext(parsedMessage);
  const decisionPrompt = [
    '你现在在一个多人 QQ 群里发言。',
    `如果这条消息不需要你回复，请只输出 ${GROUP_NO_REPLY_SENTINEL}，不要输出任何其他内容。`,
    '如果需要回复，请保持自然、简短、贴合群聊语境，避免过度热情和长篇解释。',
  ].join('\n');

  return historyContext
    ? `${decisionPrompt}\n\n${historyContext}\n\n${currentMessage}`
    : `${decisionPrompt}\n\n${currentMessage}`;
}

function getPrimaryImageSource(parsedMessage: ParsedMessage): { file?: string; url?: string } | undefined {
  return getPrimaryImageSourceFromImages(parsedMessage.images);
}

async function resolvePrimaryImageSource(parsedMessage: ParsedMessage): Promise<string | undefined> {
  const image = getPrimaryImageSource(parsedMessage);
  if (!image) {
    return undefined;
  }

  writeDebugLog('INFO', 'Resolving QQ image source', {
    threadId: parsedMessage.threadInfo.threadId,
    image,
  });

  if (image.url && /^(https?:|file:)/i.test(image.url)) {
    return image.url;
  }

  if (image.file && /^(https?:|file:|\/)/i.test(image.file)) {
    return image.file;
  }

  if (!image.file) {
    return undefined;
  }

  try {
    writeDebugLog('INFO', 'Requesting NapCat get_image', {
      threadId: parsedMessage.threadInfo.threadId,
      file: image.file,
    });
    const result = await napcatRequest<{ file?: string; url?: string }>('/get_image', {
      file: image.file,
    });
    writeDebugLog('INFO', 'Resolved NapCat get_image response', {
      threadId: parsedMessage.threadInfo.threadId,
      result,
    });
    if (result?.url) {
      return result.url;
    }
    if (result?.file) {
      return result.file;
    }
  } catch (error) {
    writeDebugLog('WARN', 'Failed to resolve image via NapCat get_image', {
      threadId: parsedMessage.threadInfo.threadId,
      error,
    });
  }

  return image.file;
}
async function buildAlmaUserMessageParts(parsedMessage: ParsedMessage): Promise<{
  parts: Array<Record<string, any>>;
  resolvedImageSource?: string;
}> {
  const text = buildAlmaInputText(parsedMessage);
  const parts: Array<Record<string, any>> = [{ type: 'text', text }];
  const imageSource = await resolvePrimaryImageSource(parsedMessage);

  if (!imageSource) {
    return { parts };
  }

  const localImagePath = await downloadImageToLocalCache(imageSource, {
    cacheDir: IMAGE_CACHE_DIR,
    originalFileName: getPrimaryImageSource(parsedMessage)?.file,
  });
  const { dataUrl, mediaType } = buildDataUrlFromLocalImage(localImagePath);

  parts.push({
    type: 'file',
    url: dataUrl,
    mediaType,
  });
  return {
    parts,
    resolvedImageSource: localImagePath,
  };
}

function summarizeAlmaUserMessageParts(parts: Array<Record<string, any>>): Array<Record<string, any>> {
  return parts.map(part => {
    if (part.type === 'text') {
      return {
        type: 'text',
        textPreview: typeof part.text === 'string' ? part.text.slice(0, 200) : '',
      };
    }

    if (part.type === 'file') {
      return {
        type: 'file',
        urlPreview: typeof part.url === 'string' ? part.url.slice(0, 200) : '',
        filePreview: typeof part.file === 'string' ? part.file.slice(0, 200) : '',
        mediaType: typeof part.mediaType === 'string' ? part.mediaType : '',
      };
    }

    return { type: String(part.type || 'unknown') };
  });
}

function buildErrorReply(error: unknown): string {
  return buildErrorReplyBase(error, config, runtimeStatus);
}

function buildReplyStrategy(parsedMessage: ParsedMessage, reply: string): ReplyStrategy {
  return buildReplyStrategyBase(parsedMessage, reply, getEffectiveConfig(config, parsedMessage.groupId));
}

function normalizeGeneratedReply(parsedMessage: ParsedMessage, reply: string | null): string | null {
  return normalizeGeneratedReplyBase(parsedMessage, reply, getEffectiveConfig(config, parsedMessage.groupId));
}

function getImageFallbackReply(parsedMessage: ParsedMessage): string | null {
  return getImageFallbackReplyBase(parsedMessage, getEffectiveConfig(config, parsedMessage.groupId));
}

async function sendReplyToParsedMessage(
  parsedMessage: ParsedMessage,
  reply: string,
  options?: { mentionSender?: boolean; quoteMessageId?: string },
): Promise<void> {
  let atUser: string | undefined;

  if (
    options?.mentionSender &&
    getEffectiveConfig(config, parsedMessage.groupId).atReplyEnabled &&
    parsedMessage.messageType === 'group' &&
    checkAtCooldown(parsedMessage.userId, parsedMessage.groupId)
  ) {
    atUser = parsedMessage.userId;
    markAtReplied(parsedMessage.userId);
  }

  writeDebugLog('INFO', 'Sending QQ reply', {
    threadId: parsedMessage.threadInfo.threadId,
    messageType: parsedMessage.messageType,
  });

  let result: NapCatSendMessageResult | undefined;
  if (parsedMessage.messageType === 'group' && parsedMessage.groupId) {
    result = await sendGroupMessage({
      group_id: parsedMessage.groupId,
      message: reply,
      at_user: atUser,
      quote_message_id: options?.quoteMessageId,
    }, {} as ToolContext);
  } else {
    result = await sendPrivateMessage({
      user_id: parsedMessage.userId,
      message: reply,
    }, {} as ToolContext);
  }

  addOutboundReplyToHistory(parsedMessage, reply, result);

  writeDebugLog('INFO', 'Sent QQ reply', {
    threadId: parsedMessage.threadInfo.threadId,
    messageType: parsedMessage.messageType,
    text: reply.slice(0, 200),
  });
}

async function notifyMessageError(parsedMessage: ParsedMessage, error: unknown): Promise<void> {
  try {
    await sendReplyToParsedMessage(parsedMessage, buildErrorReply(error));
  } catch (sendError) {
    pluginContext.logger.error('Failed to send QQ error reply', {
      threadId: parsedMessage.threadInfo.threadId,
      error: sendError,
    });
  }
}

// ============================================================================
// Message History
// ============================================================================

function addToHistory(parsed: ParsedMessage): void {
  messageHistory.push(parsed);
  if (messageHistory.length > MAX_HISTORY_SIZE) {
    messageHistory.shift();
  }
}

function addOutboundReplyToHistory(
  parsedMessage: ParsedMessage,
  reply: string,
  result?: NapCatSendMessageResult,
): void {
  if (parsedMessage.messageType !== 'group' || !parsedMessage.groupId) {
    return;
  }

  const numericMessageId = Number(result?.message_id ?? result?.messageId ?? 0);
  const fallbackMessageId = Date.now();
  const messageId = numericMessageId > 0 ? numericMessageId : fallbackMessageId;
  const timestamp = Date.now() / 1000;

  addToHistory({
    messageId,
    userId: config.botQQ,
    senderName: 'Alma',
    groupId: parsedMessage.groupId,
    messageType: 'group',
    rawMessage: reply,
    textContent: reply,
    mentions: [],
    images: [],
    isAtBot: false,
    atBotPosition: -1,
    triggerTypes: [],
    matchedKeywords: [],
    timestamp,
    threadInfo: parsedMessage.threadInfo,
    threadContext: {
      threadId: parsedMessage.threadInfo.threadId,
      type: 'group',
      napcatMessageId: messageId,
      isAtBot: false,
      isReply: false,
    },
    isReplyToBot: false,
  });

  upsertMessageIndex({
    messageId,
    threadId: parsedMessage.threadInfo.threadId,
    userId: config.botQQ,
    isBot: true,
    timestamp,
  });
  schedulePersist();
}

function markMessageProcessed(messageId: number): void {
  const now = Date.now();
  processedMessageIds.set(messageId, now);

  for (const [id, timestamp] of processedMessageIds) {
    if (now - timestamp > MESSAGE_DEDUP_WINDOW_MS) {
      processedMessageIds.delete(id);
    }
  }
}

function hasProcessedMessage(messageId: number): boolean {
  const now = Date.now();
  const timestamp = processedMessageIds.get(messageId);
  if (timestamp === undefined) {
    return false;
  }
  if (now - timestamp > MESSAGE_DEDUP_WINDOW_MS) {
    processedMessageIds.delete(messageId);
    return false;
  }
  return true;
}

function getReconnectDelayMs(): number {
  const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts);
  return Math.min(delay, RECONNECT_MAX_DELAY_MS);
}

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (!shouldReconnect || reconnectTimer) {
    return;
  }

  const delayMs = getReconnectDelayMs();
  reconnectAttempts += 1;
  updateRuntimeStatus({ reconnectDelayMs: delayMs });
  writeDebugLog('WARN', 'Scheduling NapCat reconnect', {
    attempt: reconnectAttempts,
    delayMs,
  });

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectWebSocket().catch(error => {
      writeDebugLog('ERROR', 'Reconnect attempt failed', error);
    });
  }, delayMs);
}

function upsertMessageIndex(entry: PersistedMessageIndexEntry): void {
  messageIndex.set(entry.messageId, entry);

  if (messageIndex.size <= MAX_MESSAGE_INDEX_SIZE) {
    return;
  }

  const oldest = Array.from(messageIndex.values())
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, messageIndex.size - MAX_MESSAGE_INDEX_SIZE);

  for (const item of oldest) {
    messageIndex.delete(item.messageId);
  }
}

async function persistState(): Promise<void> {
  const storage = resolveStorageAdapter();
  await storage.set(STORAGE_KEYS.history, messageHistory);
  await storage.set(STORAGE_KEYS.threads, threadManager.getAll());
  await storage.set(
    STORAGE_KEYS.messageIndex,
    Array.from(messageIndex.values()),
  );
}

function schedulePersist(): void {
  persistPromise = persistPromise
    .catch(() => {})
    .then(() => persistState())
    .catch(error => {
      pluginContext.logger.error('Failed to persist QQ NapCat Channel state:', error);
      writeDebugLog('ERROR', 'Failed to persist QQ NapCat Channel state', error);
    });
}

async function restoreState(): Promise<void> {
  const storage = resolveStorageAdapter();
  const [storedHistory, storedThreads, storedIndex] = await Promise.all([
    storage.get<ParsedMessage[]>(STORAGE_KEYS.history, []),
    storage.get<ReturnType<ThreadManager['getAll']>>(STORAGE_KEYS.threads, []),
    storage.get<PersistedMessageIndexEntry[]>(STORAGE_KEYS.messageIndex, []),
  ]);

  messageHistory.length = 0;
  messageHistory.push(...(storedHistory ?? []).slice(-MAX_HISTORY_SIZE));

  threadManager.replaceAll(storedThreads ?? []);

  messageIndex.clear();
  for (const entry of (storedIndex ?? []).slice(-MAX_MESSAGE_INDEX_SIZE)) {
    messageIndex.set(entry.messageId, entry);
  }
}

async function createAlmaThread(title: string): Promise<AlmaThreadRecord> {
  return createAlmaThreadBase(title, {
    writeDebugLog,
    logger: pluginContext.logger,
  });
}

async function ensureAlmaThreadId(parsedMessage: ParsedMessage): Promise<string> {
  const thread = threadManager.get(parsedMessage.threadInfo.threadId);
  if (thread?.almaThreadId) {
    return thread.almaThreadId;
  }

  const created = await createAlmaThread(parsedMessage.threadInfo.displayName);
  threadManager.setAlmaThreadId(parsedMessage.threadInfo.threadId, created.id);
  schedulePersist();
  return created.id;
}

function findReplyTarget(replyToMessageId?: number): PersistedMessageIndexEntry | undefined {
  if (!replyToMessageId) {
    return undefined;
  }

  return messageIndex.get(replyToMessageId);
}

function getMessageHistory(groupId?: string, limit: number = 10): ParsedMessage[] {
  let filtered = messageHistory;
  if (groupId) {
    filtered = messageHistory.filter(m => m.groupId === groupId);
  }
  return filtered.slice(-limit);
}

async function rememberOutboundMessage(
  result: unknown,
  params: { threadId: string; timestamp?: number },
): Promise<void> {
  const data = result as NapCatSendMessageResult | undefined;
  const messageId = data?.message_id ?? data?.messageId;

  if (!messageId) {
    return;
  }

  upsertMessageIndex({
    messageId,
    threadId: params.threadId,
    userId: config.botQQ,
    isBot: true,
    timestamp: params.timestamp ?? Date.now() / 1000,
  });
  schedulePersist();
}

// ============================================================================
// WebSocket Connection
// ============================================================================

async function connectWebSocket(): Promise<void> {
  shouldReconnect = true;
  updateRuntimeStatus({ connection: 'connecting', lastError: '' });
  if (wsConnection) {
    if (isConnected && wsConnection.readyState === WS_OPEN) {
      return;
    }
  }

  if (wsConnectPromise) {
    return wsConnectPromise;
  }

  wsConnectPromise = (async () => {
    const WebSocketCtor = getWebSocketConstructor();
    const wsUrl = buildNapCatWebSocketUrl(config);

    pluginContext.logger.info(`Connecting to WebSocket: ${wsUrl}`);

    wsConnection = new WebSocketCtor(wsUrl);

    await new Promise<void>((resolve, reject) => {
      const socket = wsConnection!;
      const handleOpen = () => {
        pluginContext.logger.info('WebSocket connected to NapCat');
        writeDebugLog('INFO', 'WebSocket connected to NapCat');
        isConnected = true;
        reconnectAttempts = 0;
        clearReconnectTimer();
        updateRuntimeStatus({ connection: 'connected', reconnectDelayMs: 0 });
        showNotification('QQ NapCat Channel connected to NapCat.', 'info');
        resolve();
      };

      const handleOpenError = (event: any) => {
        const error = event?.error ?? event;
        socket.removeEventListener('open', handleOpen);
        reject(error);
      };

      socket.addEventListener('open', handleOpen, { once: true });
      socket.addEventListener('error', handleOpenError, { once: true });
    });

    wsConnection.addEventListener('message', async event => {
      try {
        const message = await webSocketDataToText(event?.data);
        const parsed = JSON.parse(message);

        if (parsed?.echo && pendingRequests.has(parsed.echo)) {
          const pending = pendingRequests.get(parsed.echo)!;
          clearTimeout(pending.timeout);
          pendingRequests.delete(parsed.echo);
          pending.resolve(parsed);
          return;
        }

        // Handle only group and private messages
        if (parsed.post_type === 'message') {
          const rawMessageId = Number(parsed?.message_id ?? 0);
          if (rawMessageId > 0 && hasProcessedMessage(rawMessageId)) {
            updateRuntimeStatus({ duplicateHits: runtimeStatus.duplicateHits + 1 });
            writeDebugLog('WARN', 'Skipped duplicate QQ message', {
              messageId: rawMessageId,
              userId: parsed?.user_id,
              messageType: parsed?.message_type,
            });
            return;
          }

          const parsedMessage = parseMessage(parsed);
          let willRespond = false;

          try {
            markMessageProcessed(parsedMessage.messageId);
            willRespond = shouldRespond(parsedMessage);
            addToHistory(parsedMessage);
            schedulePersist();
            writeDebugLog('INFO', 'Received QQ message', {
              threadId: parsedMessage.threadInfo.threadId,
              userId: parsedMessage.userId,
              messageType: parsedMessage.messageType,
              text: parsedMessage.textContent.slice(0, 200),
              willRespond,
            });
            updateRuntimeStatus({
              lastThreadId: parsedMessage.threadInfo.threadId,
              lastMessage: parsedMessage.textContent.slice(0, 80),
            });

            if (!hasShownFirstMessageNotification) {
              hasShownFirstMessageNotification = true;
              showNotification('QQ NapCat Channel received a message.', 'info');
            }

            // Build QQMessageEvent for Alma
            const messageEvent: QQMessageEvent = {
            type: 'qq.message.received',
            version: '1.1.0',
            messageId: `qq:${parsedMessage.messageId}`,
            sender: {
              userId: parsedMessage.userId,
              nickname: parsed.sender?.nickname ?? parsedMessage.userId,
              card: parsed.sender?.card,
              role: parsed.sender?.role,
              isBot: false,
            },
            content: {
              raw: parsedMessage.rawMessage,
              text: parsedMessage.textContent,
              segments: parsed.message?.map((seg: any) => ({
                type: seg.type,
                data: seg.data,
              })) || [{ type: 'text', data: { text: parsedMessage.rawMessage } }],
            },
            thread: parsedMessage.threadInfo,
            threadContext: parsedMessage.threadContext,
            metadata: {
              platform: 'qq',
              napcatMessageId: parsedMessage.messageId,
              isAtBot: parsedMessage.isAtBot,
              triggerTypes: parsedMessage.triggerTypes,
              matchedKeywords: parsedMessage.matchedKeywords,
              isReply: parsedMessage.threadContext.isReply,
              replyToMessageId: parsedMessage.threadContext.replyToMessageId?.toString(),
              replyToUserId: parsedMessage.threadContext.replyToUserId,
            },
            timestamp: parsedMessage.timestamp * 1000,
            };

            // Emit structured event for Alma with thread context
            emitPluginEvent(QQ_MESSAGE_EVENTS.MESSAGE_RECEIVED, messageEvent);

            // Also emit legacy event for backward compatibility
            emitPluginEvent('qq.message', parsedMessage);

            // Forward message to Alma's chat interface (via ChatRegistry bridge)
            // This enables Alma to receive messages via chat.onMessage()
            await forwardMessageToAlma(parsedMessage);

            let reply: string | null = null;
            if (willRespond) {
              try {
                reply = getImageFallbackReply(parsedMessage);
                if (!reply) {
                  reply = normalizeGeneratedReply(parsedMessage, await generateAlmaResponse(parsedMessage));
                }
                if (!reply && !config.respondToGroupMessage) {
                  reply = generateReply(parsedMessage);
                }
              } catch (error) {
                pluginContext.logger.error('Failed to generate Alma response', {
                  threadId: parsedMessage.threadInfo.threadId,
                  error: error instanceof Error ? {
                    name: error.name,
                    message: error.message,
                    stack: error.stack,
                  } : error,
                });
                reply = buildErrorReply(error);
              }
            }

            if (reply) {
              const strategy = buildReplyStrategy(parsedMessage, reply);
              if (strategy.delayMs > 0) {
                await sleep(strategy.delayMs);
              }
              await sendReplyToParsedMessage(parsedMessage, strategy.text, {
                mentionSender: strategy.mentionSender,
                quoteMessageId: strategy.quoteMessageId,
              });
            }
          } catch (error) {
            pluginContext.logger.error('Failed to process QQ message', {
              threadId: parsedMessage.threadInfo.threadId,
              error,
            });
            if (willRespond) {
              await notifyMessageError(parsedMessage, error);
            }
          }
        }
      } catch (error) {
        pluginContext.logger.error('Error handling WebSocket message:', error);
      }
    });

    wsConnection.addEventListener('close', () => {
      pluginContext.logger.warn('WebSocket connection closed');
      writeDebugLog('WARN', 'WebSocket connection closed');
      isConnected = false;
      wsConnection = null;
      wsConnectPromise = null;
      updateRuntimeStatus({ connection: 'disconnected' });
      showNotification('QQ NapCat Channel disconnected from NapCat.', 'warning');

      for (const [, pending] of pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('NapCat WebSocket connection closed'));
      }
      pendingRequests.clear();

      scheduleReconnect();
    });

    wsConnection.addEventListener('error', event => {
      const error = event?.error ?? event;
      pluginContext.logger.error('WebSocket error:', error);
      writeDebugLog('ERROR', 'WebSocket error', error);
      updateRuntimeStatus({ lastError: String(error) });
      showNotification(`QQ NapCat Channel WebSocket error: ${String(error)}`, 'error');
      if (!isConnected) {
        wsConnectPromise = null;
      }
    });

  })().catch(error => {
    pluginContext.logger.error('Failed to connect WebSocket:', error);
    writeDebugLog('ERROR', 'Failed to connect WebSocket', error);
    updateRuntimeStatus({ connection: 'disconnected', lastError: String(error) });
    wsConnectPromise = null;
    wsConnection = null;
    isConnected = false;
    throw error;
  });

  return wsConnectPromise;
}

function disconnectWebSocket(): void {
  shouldReconnect = false;
  clearReconnectTimer();
  if (wsConnection) {
    wsConnection.close();
    wsConnection = null;
    isConnected = false;
    pluginContext.logger.info('WebSocket disconnected');
    writeDebugLog('INFO', 'WebSocket disconnected');
  }
  updateRuntimeStatus({ connection: 'disconnected', reconnectDelayMs: 0 });
  wsConnectPromise = null;
}

// ============================================================================
// Tool Implementations
// ============================================================================

async function sendPrivateMessage(
  params: {
    user_id: string;
    message: string;
  },
  toolContext: ToolContext
): Promise<any> {
  const target = resolveChatTargetFromToolContext({
    chatType: 'private',
    chatId: params.user_id,
  }, toolContext, writeDebugLog);
  const userId = target.chatId;

  const result = await napcatRequest('/send_private_msg', {
    user_id: parseInt(userId),
    message: [{ type: 'text', data: { text: params.message } }],
  });
  await rememberOutboundMessage(result, {
    threadId: ThreadIdGenerator.privateChat(userId),
  });
  return result;
}

async function sendGroupMessage(
  params: {
    group_id: string;
    message: string;
    at_user?: string;
    quote_message_id?: string;
  },
  toolContext: ToolContext
): Promise<any> {
  const target = resolveChatTargetFromToolContext({
    chatType: 'group',
    chatId: params.group_id,
  }, toolContext, writeDebugLog);
  const groupId = target.chatId;

  let message: any[] = [{ type: 'text', data: { text: params.message } }];

  if (params.quote_message_id) {
    message.unshift({
      type: 'reply',
      data: { id: params.quote_message_id },
    });
  }

  if (params.at_user) {
    message.unshift({
      type: 'at',
      data: { qq: params.at_user },
    });
    const spaceIndex = params.quote_message_id ? 2 : 1;
    message.splice(spaceIndex, 0, {
      type: 'text',
      data: { text: ' ' },
    });
  }

  const result = await napcatRequest('/send_group_msg', {
    group_id: parseInt(groupId),
    message,
  });
  await rememberOutboundMessage(result, {
    threadId: ThreadIdGenerator.groupChat(groupId),
  });
  return result;
}

async function sendSegmentsToTarget(
  target: { chatType: 'private' | 'group'; targetId: string },
  messageSegments: Record<string, any>[],
  threadId: string,
): Promise<any> {
  return sendSegmentsToTargetBase(target, messageSegments, threadId, {
    napcatRequest,
    rememberOutboundMessage,
  });
}

/**
 * Send a message to a thread by threadId
 * This is the primary method for Alma to send replies to QQ chats
 */
async function sendThreadMessage(
  params: {
    thread_id: string;
    message: string;
    at_sender?: boolean;
    quote_message?: boolean;
    quote_message_id?: string;
  },
  _toolContext: ToolContext
): Promise<any> {
  return sendThreadMessageBase(params, {
    threadManager,
    sendSegmentsToTarget,
  });
}

async function requestAlmaResponse(
  parsedMessage: ParsedMessage,
  almaThreadId: string,
): Promise<string> {
  const effectiveConfig = getEffectiveConfig(config, parsedMessage.groupId);
  const hasImages = parsedMessage.images.length > 0;
  const almaModel = (hasImages ? effectiveConfig.almaVisionModel.trim() : '') || effectiveConfig.almaModel.trim();
  const userMessagePartsPromise = buildAlmaUserMessageParts(parsedMessage);
  const timeoutMs = getAlmaResponseTimeoutMs(parsedMessage);

  return new Promise((resolve, reject) => {
    const WebSocketCtor = getWebSocketConstructor();
    let settled = false;
    let responseText = '';
    const ws = new WebSocketCtor(ALMA_THREAD_WS_URL);
    const timeout = setTimeout(() => {
      pluginContext.logger.warn('Alma thread WS timed out', {
        threadId: almaThreadId,
        timeoutMs,
      });
      writeDebugLog('WARN', 'Alma thread WS timed out', {
        threadId: almaThreadId,
        timeoutMs,
      });
      finish(() => reject(new Error(`Alma thread WS timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // Ignore close failures.
      }
      fn();
    };

    ws.addEventListener('open', () => {
      void (async () => {
        try {
          const { parts: userMessageParts, resolvedImageSource } = await userMessagePartsPromise;
          if (hasImages && !resolvedImageSource) {
            throw new Error('Image source could not be resolved from NapCat');
          }
          const requestPayload = {
            type: 'generate_response',
            data: {
              threadId: almaThreadId,
              model: almaModel,
              userMessage: {
                role: 'user',
                parts: userMessageParts,
              },
            },
          };

          writeDebugLog('INFO', 'Requesting Alma reply', {
            threadId: almaThreadId,
            model: almaModel,
            hasImages,
            timeoutMs,
            taskLikeRequest: isTaskLikeRequest(parsedMessage),
            resolvedImageSource: !!resolvedImageSource,
            userMessageParts: summarizeAlmaUserMessageParts(userMessageParts),
          });
          ws.send(JSON.stringify(requestPayload));
        } catch (error) {
          finish(() => reject(error));
        }
      })();
    });

    ws.addEventListener('message', async event => {
      try {
        const raw = await webSocketDataToText(event?.data);
        const parsed = JSON.parse(raw);

        if (parsed?.type === 'message_delta') {
          const deltas = Array.isArray(parsed?.data?.deltas) ? parsed.data.deltas : [];
          for (const delta of deltas) {
            if (delta?.type === 'text_append' && delta?.partType === 'text' && typeof delta?.text === 'string') {
              responseText += delta.text;
            }
          }
          return;
        }

        if (parsed?.type === 'message_updated') {
          const parts = Array.isArray(parsed?.data?.message?.parts) ? parsed.data.message.parts : [];
          const finalText = parts
            .filter((part: any) => part?.type === 'text' && typeof part?.text === 'string')
            .map((part: any) => part.text)
            .join('');
          if (finalText.trim()) {
            responseText = finalText;
          }
          return;
        }

        if (parsed?.type === 'generation_completed') {
          finish(() => resolve(responseText.trim()));
          return;
        }

        if (parsed?.type === 'error' || parsed?.type === 'generation_error') {
          finish(() => reject(new Error(parsed?.data?.error || 'Alma thread WS returned an error')));
          return;
        }
      } catch (error) {
        pluginContext.logger.error('Failed to parse Alma thread WS event', error);
      }
    });

    ws.addEventListener('error', event => {
      const error = event?.error ?? event;
      pluginContext.logger.error('Alma thread WS error', error);
      updateRuntimeStatus({ lastError: `Alma WS: ${String(error)}` });
      finish(() => reject(error));
    });

    ws.addEventListener('close', () => {
      if (!settled) {
        finish(() => resolve(responseText.trim()));
      }
    });
  });
}

async function generateAlmaResponse(parsedMessage: ParsedMessage): Promise<string> {
  const almaThreadId = await ensureAlmaThreadId(parsedMessage);
  return requestAlmaResponse(parsedMessage, almaThreadId);
}

async function sendImage(
  params: {
    chat_type: 'private' | 'group';
    chat_id: string;
    image_path: string;
    caption?: string;
  },
  toolContext: ToolContext
): Promise<any> {
  const message: any[] = [
    { type: 'image', data: { file: params.image_path } },
  ];

  if (params.caption) {
    message.unshift({ type: 'text', data: { text: params.caption } });
  }

  const target = resolveChatTargetFromToolContext({
    chatType: params.chat_type,
    chatId: params.chat_id,
  }, toolContext, writeDebugLog);
  const endpoint = target.chatType === 'private' ? '/send_private_msg' : '/send_group_msg';
  const idField = target.chatType === 'private' ? 'user_id' : 'group_id';

  return napcatRequest(endpoint, {
    [idField]: parseInt(target.chatId),
    message,
  });
}

async function sendVoice(
  params: {
    chat_type: 'private' | 'group';
    chat_id: string;
    voice_path: string;
  },
  toolContext: ToolContext
): Promise<any> {
  const message = [
    { type: 'record', data: { file: params.voice_path } },
  ];

  const target = resolveChatTargetFromToolContext({
    chatType: params.chat_type,
    chatId: params.chat_id,
  }, toolContext, writeDebugLog);
  const endpoint = target.chatType === 'private' ? '/send_private_msg' : '/send_group_msg';
  const idField = target.chatType === 'private' ? 'user_id' : 'group_id';

  return napcatRequest(endpoint, {
    [idField]: parseInt(target.chatId),
    message,
  });
}

async function sendRichMessage(
  params: {
    chat_type: 'private' | 'group';
    chat_id: string;
    message?: string;
    segments: MessageSegment[];
  },
  toolContext: ToolContext
): Promise<any> {
  const resolvedTarget = resolveChatTargetFromToolContext({
    chatType: params.chat_type,
    chatId: params.chat_id,
  }, toolContext, writeDebugLog);
  const threadId = buildThreadId(resolvedTarget.chatType, resolvedTarget.chatId);
  const target = {
    chatType: resolvedTarget.chatType,
    targetId: resolvedTarget.chatId,
  } as const;
  const messageSegments = buildOutboundSegments({
    message: params.message,
    segments: params.segments,
  });
  return sendSegmentsToTarget(target, messageSegments, threadId);
}

async function sendThreadRichMessage(
  params: {
    thread_id: string;
    message?: string;
    segments: MessageSegment[];
    at_sender?: boolean;
    quote_message?: boolean;
    quote_message_id?: string;
  },
  _toolContext: ToolContext
): Promise<any> {
  const target = extractTargetFromThreadId(params.thread_id);
  if (!target) {
    throw new Error(`Invalid thread ID: ${params.thread_id}`);
  }

  const thread = threadManager.get(params.thread_id);
  const messageSegments = buildOutboundSegments({
    message: params.message,
    segments: params.segments,
    atSender: params.at_sender,
    senderId: thread?.lastSenderId,
    quoteMessage: params.quote_message,
    quoteMessageId: params.quote_message_id,
  });
  return sendSegmentsToTarget(target, messageSegments, params.thread_id);
}

async function sendFile(
  params: {
    chat_type: 'private' | 'group';
    chat_id: string;
    file_path: string;
  },
  _toolContext: ToolContext
): Promise<any> {
  if (params.chat_type !== 'group') {
    throw new Error('File upload is only supported for groups');
  }

  const fileName = params.file_path.split('/').pop() || 'file';

  return napcatRequest('/upload_group_file', {
    group_id: parseInt(params.chat_id),
    file: params.file_path,
    name: fileName,
  });
}

async function getFriendList(_params: {}, _toolContext: ToolContext): Promise<any[]> {
  return napcatRequest('/get_friend_list', {});
}

async function getGroupList(_params: {}, _toolContext: ToolContext): Promise<any[]> {
  return napcatRequest('/get_group_list', {});
}

async function getGroupMembers(
  params: {
    group_id: string;
  },
  _toolContext: ToolContext
): Promise<any[]> {
  return napcatRequest('/get_group_member_list', {
    group_id: parseInt(params.group_id),
  });
}

async function deleteMessage(
  params: {
    message_id: string;
  },
  _toolContext: ToolContext
): Promise<any> {
  return napcatRequest('/delete_msg', {
    message_id: parseInt(params.message_id),
  });
}

async function groupKick(
  params: {
    group_id: string;
    user_id: string;
    reject_add_request?: boolean;
  },
  _toolContext: ToolContext
): Promise<any> {
  return napcatRequest('/set_group_kick', {
    group_id: parseInt(params.group_id),
    user_id: parseInt(params.user_id),
    reject_add_request: params.reject_add_request ?? false,
  });
}

async function groupBan(
  params: {
    group_id: string;
    user_id: string;
    duration: number;
  },
  _toolContext: ToolContext
): Promise<any> {
  return napcatRequest('/set_group_ban', {
    group_id: parseInt(params.group_id),
    user_id: parseInt(params.user_id),
    duration: params.duration,
  });
}

async function setGroupCard(
  params: {
    group_id: string;
    user_id: string;
    card: string;
  },
  _toolContext: ToolContext
): Promise<any> {
  return napcatRequest('/set_group_card', {
    group_id: parseInt(params.group_id),
    user_id: parseInt(params.user_id),
    card: params.card,
  });
}

async function getMessageHistoryTool(
  params: {
    group_id?: string;
    user_id?: string;
    limit?: number;
  },
  _toolContext: ToolContext
): Promise<ParsedMessage[]> {
  let filtered = messageHistory;

  if (params.group_id) {
    filtered = filtered.filter(message => message.groupId === params.group_id);
  }

  if (params.user_id) {
    filtered = filtered.filter(message => message.userId === params.user_id);
  }

  return filtered.slice(-(params.limit || 10));
}

// ============================================================================
// Chat Registry Bridge Implementation
// ============================================================================

/**
 * Message handlers registered via chat.onMessage
 * Alma uses this to receive incoming QQ messages
 */
const almaMessageHandlers: ((message: IncomingMessage) => void | Promise<void>)[] = [];

/**
 * Register a message handler for Alma's onMessage callback
 * This bridges QQ messages to Alma's chat interface
 */
function registerAlmaMessageHandler(handler: (message: IncomingMessage) => void | Promise<void>): void {
  almaMessageHandlers.push(handler);
  pluginContext.logger.debug(`Registered Alma message handler (total: ${almaMessageHandlers.length})`);
}

function registerDynamicSettingsSection(ctx: PluginContext): void {
  ctx.logger.info('QQ NapCat Channel uses qqchannel.configJson for configuration; skipping dynamic Alma settings section.');
}

/**
 * Unregister a message handler
 */
function unregisterAlmaMessageHandler(handler: (message: IncomingMessage) => void | Promise<void>): void {
  const index = almaMessageHandlers.indexOf(handler);
  if (index > -1) {
    almaMessageHandlers.splice(index, 1);
    pluginContext.logger.debug(`Unregistered Alma message handler (remaining: ${almaMessageHandlers.length})`);
  }
}

/**
 * Forward parsed QQ message to Alma's registered handlers
 * This is called when a message is received via WebSocket
 */
async function forwardMessageToAlma(parsedMessage: ParsedMessage): Promise<void> {
  await forwardMessageToAlmaBase(parsedMessage, almaMessageHandlers, pluginContext.logger);
}

/**
 * Send a message via Alma's chat interface
 * This bridges Alma's sendMessage to NapCat API
 */
async function sendMessageViaBridge(
  chatId: string,
  content: string,
  options?: { replyTo?: string; parseMode?: 'plain' | 'markdown' | 'html' }
): Promise<void> {
  await sendMessageViaBridgeBase(chatId, content, options, {
    napcatRequest,
    rememberOutboundMessage,
    logger: pluginContext.logger,
  });
}

/**
 * Send an image via Alma's chat interface
 */
async function sendImageViaBridge(
  chatId: string,
  imagePath: string,
  caption?: string
): Promise<void> {
  await sendImageViaBridgeBase(chatId, imagePath, caption, {
    napcatRequest,
    rememberOutboundMessage,
  });
}

/**
 * Send a file via Alma's chat interface
 */
async function sendFileViaBridge(
  chatId: string,
  filePath: string
): Promise<void> {
  await sendFileViaBridgeBase(chatId, filePath, {
    napcatRequest,
  });
}

// ============================================================================
// Plugin Activation
// ============================================================================

export async function activate(ctx: PluginContext): Promise<PluginActivation> {
  pluginContext = ctx;
  runtimeStatusController = createRuntimeStatusController(ctx, {
    statusBarId: STATUS_BAR_ID,
    sidebarViewId: SIDEBAR_VIEW_ID,
  });
  installDebugLogMirror(ctx);
  hasWarnedEventEmitUnavailable = false;
  ctx.logger.info('QQ NapCat Channel Plugin activating...');
  writeDebugLog('INFO', 'QQ NapCat Channel Plugin activating');
  storageAdapter = null;
  hasWarnedStorageFallback = false;

  // Load configuration
  config = loadConfig(ctx, {
    logError: (message, error) => {
      ctx.logger.error(`${message}:`, error);
      writeDebugLog('ERROR', message, error);
    },
    notify: (message, type) => showNotification(message, type),
  });
  registerRuntimeStatusView();
  updateRuntimeStatus({ connection: 'disconnected' });

  writeDebugLog('INFO', 'QQ NapCat Channel Alma thread config', {
    almaThreadWsUrl: ALMA_THREAD_WS_URL,
    almaModel: config.almaModel,
  });
  ctx.logger.info(`QQ NapCat Channel storage adapter: ${resolveStorageAdapter().kind}`);

  // Test connection
  try {
    const loginInfo = await napcatRequest<NapCatLoginInfo>('/get_login_info', {});
    const detectedBotQQ = String(loginInfo.user_id);
    if (!config.botQQ) {
      config.botQQ = detectedBotQQ;
      ctx.logger.info('QQ NapCat Channel botQQ auto-detected from NapCat login');
      writeDebugLog('INFO', 'Auto-detected bot QQ from NapCat login');
    } else if (config.botQQ !== detectedBotQQ) {
      ctx.logger.warn('Configured botQQ does not match NapCat login; using configured value.');
      writeDebugLog('WARN', 'Configured botQQ does not match NapCat login');
    }
    ctx.logger.info('Connected to NapCat login');
    writeDebugLog('INFO', 'Connected to NapCat login');
  } catch (error) {
    ctx.logger.error(`Failed to connect to NapCat: ${error}`);
    writeDebugLog('ERROR', 'Failed to connect to NapCat', error);
    showNotification(`QQ NapCat Channel failed to connect: ${String(error)}`, 'error');
    return { dispose: () => {} };
  }

  await restoreState();

  // Register ChatRegistry bridge for Alma integration
  // This provides the standard chat.onMessage and chat.sendMessage interface
  ctx.chat.onMessage = registerAlmaMessageHandler;
  ctx.chat.sendMessage = sendMessageViaBridge;
  ctx.chat.sendImage = sendImageViaBridge;
  ctx.chat.sendFile = sendFileViaBridge;
  registerDynamicSettingsSection(ctx);
  ctx.logger.info('ChatRegistry bridge registered for Alma integration');
  writeDebugLog('INFO', 'ChatRegistry bridge registered for Alma integration');
  showNotification('QQ NapCat Channel plugin activated.', 'info');

  // Register tools
  ctx.tools.register('send_private_msg', {
    description: 'Explicitly send a direct/private message to a QQ user. This is not a group reply and does not @ mention anyone in a group.',
    parameters: z.object({
      user_id: z.string().describe('The QQ user ID for a private/direct message target'),
      message: z.string().describe('The message text to send'),
    }),
    execute: sendPrivateMessage,
  });

  ctx.tools.register('send_group_msg', {
    description: 'Explicitly send a message to a QQ group. Use at_user only to @ mention a group member inside that group; it does not create a private message.',
    parameters: z.object({
      group_id: z.string().describe('The QQ group ID to send into'),
      message: z.string().describe('The message text to send'),
      at_user: z.string().optional().describe('Optional QQ user ID to @ mention inside the target group'),
    }),
    execute: sendGroupMessage,
  });

  ctx.tools.register('send_thread_message', {
    description: 'Safest default for replying in the current QQ conversation. The thread_id determines whether this is a private reply or a group reply.',
    parameters: z.object({
      thread_id: z.string().describe('The current QQ thread ID: qq:private:{userId} for direct chat, or qq:group:{groupId} for group chat'),
      message: z.string().describe('The message text to send'),
      at_sender: z.boolean().optional().describe('Only for group threads: whether to @ the current sender in the same group'),
      quote_message: z.boolean().optional().describe('Whether to quote the original message in the same thread'),
      quote_message_id: z.string().optional().describe('Message ID to quote'),
    }),
    execute: sendThreadMessage,
  });

  ctx.tools.register('send_rich_message', {
    description: 'Explicitly send a rich QQ message to either a private chat or a group. Prefer send_thread_rich_message when replying in the current conversation.',
    parameters: z.object({
      chat_type: z.enum(['private', 'group']).describe('Whether to send to a private chat or group'),
      chat_id: z.string().describe('The user ID or group ID'),
      message: z.string().optional().describe('Optional leading text'),
      segments: z.array(z.object({
        type: z.enum(['text', 'at', 'image', 'record', 'video', 'file', 'reply', 'face', 'json', 'xml']),
        data: z.record(z.string(), z.any()),
      })).describe('Ordered rich message segments'),
    }),
    execute: sendRichMessage as any,
  });

  ctx.tools.register('send_thread_rich_message', {
    description: 'Safest rich-message reply tool for the current QQ conversation identified by thread_id.',
    parameters: z.object({
      thread_id: z.string().describe('The thread ID'),
      message: z.string().optional().describe('Optional leading text'),
      segments: z.array(z.object({
        type: z.enum(['text', 'at', 'image', 'record', 'video', 'file', 'reply', 'face', 'json', 'xml']),
        data: z.record(z.string(), z.any()),
      })).describe('Ordered rich message segments'),
      at_sender: z.boolean().optional().describe('Whether to @ the sender'),
      quote_message: z.boolean().optional().describe('Whether to quote the original message'),
      quote_message_id: z.string().optional().describe('Message ID to quote'),
    }),
    execute: sendThreadRichMessage as any,
  });

  ctx.tools.register('send_image', {
    description: 'Explicitly send an image to either a private chat or a group.',
    parameters: z.object({
      chat_type: z.enum(['private', 'group']).describe('Whether to send to a private chat or group'),
      chat_id: z.string().describe('The user ID or group ID'),
      image_path: z.string().describe('The absolute path to the image file'),
      caption: z.string().optional().describe('Optional caption text'),
    }),
    execute: sendImage,
  });

  ctx.tools.register('send_voice', {
    description: 'Explicitly send a voice message to either a private chat or a group.',
    parameters: z.object({
      chat_type: z.enum(['private', 'group']).describe('Whether to send to a private chat or group'),
      chat_id: z.string().describe('The user ID or group ID'),
      voice_path: z.string().describe('The absolute path to the voice file'),
    }),
    execute: sendVoice,
  });

  ctx.tools.register('send_file', {
    description: 'Send a file to a QQ group',
    parameters: z.object({
      chat_type: z.enum(['private', 'group']).describe('Whether to send to a private chat or group'),
      chat_id: z.string().describe('The user ID or group ID'),
      file_path: z.string().describe('The absolute path to the file'),
    }),
    execute: sendFile,
  });

  ctx.tools.register('get_friend_list', {
    description: 'Get the list of QQ friends',
    parameters: z.object({}),
    execute: getFriendList,
  });

  ctx.tools.register('get_group_list', {
    description: 'Get the list of QQ groups',
    parameters: z.object({}),
    execute: getGroupList,
  });

  ctx.tools.register('get_group_members', {
    description: 'Get the member list of a QQ group',
    parameters: z.object({
      group_id: z.string().describe('The QQ group ID'),
    }),
    execute: getGroupMembers,
  });

  ctx.tools.register('delete_message', {
    description: 'Delete/recall a message',
    parameters: z.object({
      message_id: z.string().describe('The message ID to delete'),
    }),
    execute: deleteMessage,
  });

  ctx.tools.register('group_kick', {
    description: 'Kick a member from a group',
    parameters: z.object({
      group_id: z.string().describe('The QQ group ID'),
      user_id: z.string().describe('The user ID to kick'),
      reject_add_request: z.boolean().optional().describe('Whether to reject future add requests'),
    }),
    execute: groupKick,
  });

  ctx.tools.register('group_ban', {
    description: 'Ban a member in a group',
    parameters: z.object({
      group_id: z.string().describe('The QQ group ID'),
      user_id: z.string().describe('The user ID to ban'),
      duration: z.number().default(3600).describe('Ban duration in seconds (default: 3600)'),
    }),
    execute: groupBan,
  });

  ctx.tools.register('set_group_card', {
    description: 'Set a member\'s card/nickname in a group',
    parameters: z.object({
      group_id: z.string().describe('The QQ group ID'),
      user_id: z.string().describe('The user ID'),
      card: z.string().describe('The new card/nickname'),
    }),
    execute: setGroupCard,
  });

  ctx.tools.register('get_message_history', {
    description: 'Get recent message history',
    parameters: z.object({
      group_id: z.string().optional().describe('Filter by group ID'),
      user_id: z.string().optional().describe('Filter by user ID'),
      limit: z.number().optional().describe('Number of messages to retrieve (default: 10)'),
    }),
    execute: getMessageHistoryTool,
  });

  // Register commands
  ctx.commands.register('channel-napcat-qq.connect', async () => {
    await connectWebSocket();
    ctx.logger.info('QQ WebSocket connection initiated');
    writeDebugLog('INFO', 'Connect command executed');
    showNotification('QQ NapCat Channel connect command executed.', 'info');
  });

  ctx.commands.register('channel-napcat-qq.disconnect', async () => {
    disconnectWebSocket();
    ctx.logger.info('QQ WebSocket disconnected');
    writeDebugLog('INFO', 'Disconnect command executed');
    showNotification('QQ NapCat Channel disconnect command executed.', 'warning');
  });

  ctx.commands.register('channel-napcat-qq.send-private', async (cmdCtx: CommandContext) => {
    const [userId, ...messageParts] = cmdCtx.args;
    const message = messageParts.join(' ');
    if (!userId || !message) {
      throw new Error('Usage: channel-napcat-qq.send-private <userId> <message>');
    }
    await sendPrivateMessage({ user_id: userId, message }, {} as ToolContext);
    ctx.logger.info(`Private message sent to ${userId}`);
  });

  ctx.commands.register('channel-napcat-qq.send-group', async (cmdCtx: CommandContext) => {
    const [groupId, ...messageParts] = cmdCtx.args;
    const message = messageParts.join(' ');
    if (!groupId || !message) {
      throw new Error('Usage: channel-napcat-qq.send-group <groupId> <message>');
    }
    await sendGroupMessage({ group_id: groupId, message }, {} as ToolContext);
    ctx.logger.info(`Group message sent to ${groupId}`);
  });

  ctx.commands.register('channel-napcat-qq.get-friends', async () => {
    const friends = await getFriendList({}, {} as ToolContext);
    ctx.logger.info(`Friends: ${JSON.stringify(friends, null, 2)}`);
  });

  ctx.commands.register('channel-napcat-qq.get-groups', async () => {
    const groups = await getGroupList({}, {} as ToolContext);
    ctx.logger.info(`Groups: ${JSON.stringify(groups, null, 2)}`);
  });

  ctx.commands.register('channel-napcat-qq.reload-config', async () => {
    config = loadConfig(ctx, {
      logError: (message, error) => {
        ctx.logger.error(`${message}:`, error);
        writeDebugLog('ERROR', message, error);
      },
      notify: (message, type) => showNotification(message, type),
    });
    ctx.logger.info('QQ NapCat Channel configuration reloaded');
  });

  ctx.commands.register('channel-napcat-qq.status', async () => {
    const status = isConnected ? 'connected' : 'disconnected';
    ctx.logger.info(`QQ NapCat Channel status: ${status}`);
    ctx.logger.info(`Message history size: ${messageHistory.length}`);
    writeDebugLog('INFO', 'Status command executed', {
      status,
      historySize: messageHistory.length,
      logPath: DEBUG_LOG_PATH,
    });
    showNotification(
      `QQ NapCat Channel status: ${status}, history: ${messageHistory.length}`,
      status === 'connected' ? 'info' : 'warning',
    );
  });

  // Start WebSocket connection
  await connectWebSocket();

  ctx.logger.info('QQ NapCat Channel Plugin activated successfully');

  return {
    dispose: () => {
      disconnectWebSocket();
      try {
        ctx.ui?.sidebar?.unregisterView?.(SIDEBAR_VIEW_ID);
      } catch (error) {
        ctx.logger.warn('Failed to unregister QQ NapCat Channel sidebar view:', error);
      }
      try {
        ctx.ui?.statusBar?.removeItem?.(STATUS_BAR_ID);
      } catch (error) {
        ctx.logger.warn('Failed to remove QQ NapCat Channel status bar item:', error);
      }
      try {
        ctx.ui?.settings?.unregisterSection?.(SETTINGS_SECTION_ID);
      } catch (error) {
        ctx.logger.warn('Failed to unregister QQ NapCat Channel settings section:', error);
      }
      // Clear all Alma message handlers
      almaMessageHandlers.length = 0;
      void persistPromise;
      ctx.logger.info('QQ NapCat Channel Plugin deactivated');
      writeDebugLog('WARN', 'QQ NapCat Channel Plugin deactivated');
      showNotification('QQ NapCat Channel plugin deactivated.', 'warning');
    },
  };
}

export async function deactivate(): Promise<void> {
  disconnectWebSocket();
}
