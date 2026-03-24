import type { IncomingMessage, MessageSegment, ToolContext } from '../core/types';

import { ThreadIdGenerator, extractTargetFromThreadId, type ThreadManager } from '../core/thread-utils';

export function normalizeMessageSegment(segment: MessageSegment): Record<string, any> {
  switch (segment.type) {
    case 'text':
      return { type: 'text', data: { text: segment.data.text } };
    case 'at':
      return { type: 'at', data: { qq: segment.data.qq, name: segment.data.name } };
    case 'image':
      return { type: 'image', data: { file: segment.data.file, url: segment.data.url } };
    case 'record':
      return { type: 'record', data: { file: segment.data.file } };
    case 'video':
      return { type: 'video', data: { file: segment.data.file } };
    case 'file':
      return { type: 'file', data: { file: segment.data.file, name: segment.data.name } };
    case 'reply':
      return { type: 'reply', data: { id: segment.data.messageId, user_id: segment.data.userId } };
    case 'face':
      return { type: 'face', data: { id: segment.data.id } };
    case 'json':
      return { type: 'json', data: { data: segment.data.data } };
    case 'xml':
      return { type: 'xml', data: { data: segment.data.data } };
    default:
      throw new Error(`Unsupported message segment type: ${String((segment as MessageSegment).type)}`);
  }
}

export function buildOutboundSegments(params: {
  message?: string;
  segments?: MessageSegment[];
  atSender?: boolean;
  senderId?: string;
  quoteMessage?: boolean;
  quoteMessageId?: string;
}): Record<string, any>[] {
  const messageSegments: Record<string, any>[] = [];

  if (params.quoteMessage && params.quoteMessageId) {
    messageSegments.push({
      type: 'reply',
      data: { id: params.quoteMessageId },
    });
  }

  if (params.atSender && params.senderId) {
    messageSegments.push({
      type: 'at',
      data: { qq: params.senderId },
    });
  }

  if (params.message) {
    messageSegments.push({
      type: 'text',
      data: { text: params.message },
    });
  }

  if (params.segments?.length) {
    messageSegments.push(...params.segments.map(normalizeMessageSegment));
  }

  if (messageSegments.length === 0) {
    throw new Error('At least one message segment is required');
  }

  return messageSegments;
}

export function resolveChatTargetFromToolContext(
  params: { chatType: 'private' | 'group'; chatId: string },
  toolContext: ToolContext,
  writeDebugLog: (level: 'WARN', message: string, extra?: unknown) => void,
): { chatType: 'private' | 'group'; chatId: string } {
  const contextTarget = toolContext.chatId ? extractTargetFromThreadId(toolContext.chatId) : null;
  if (!contextTarget) {
    return params;
  }

  if (contextTarget.chatType === params.chatType) {
    if (contextTarget.targetId !== params.chatId) {
      writeDebugLog('WARN', 'Overriding QQ tool target with active thread context', {
        requestedChatType: params.chatType,
        requestedChatId: params.chatId,
        contextChatId: toolContext.chatId,
        resolvedChatId: contextTarget.targetId,
      });
    }
    return {
      chatType: contextTarget.chatType,
      chatId: contextTarget.targetId,
    };
  }

  return params;
}

export async function sendSegmentsToTarget(
  target: { chatType: 'private' | 'group'; targetId: string },
  messageSegments: Record<string, any>[],
  threadId: string,
  deps: {
    napcatRequest: <T>(endpoint: string, data?: Record<string, any>) => Promise<T>;
    rememberOutboundMessage: (result: unknown, params: { threadId: string; timestamp?: number }) => Promise<void>;
  },
): Promise<any> {
  if (target.chatType === 'group') {
    const result = await deps.napcatRequest('/send_group_msg', {
      group_id: parseInt(target.targetId),
      message: messageSegments,
    });
    await deps.rememberOutboundMessage(result, { threadId });
    return result;
  }

  const result = await deps.napcatRequest('/send_private_msg', {
    user_id: parseInt(target.targetId),
    message: messageSegments,
  });
  await deps.rememberOutboundMessage(result, { threadId });
  return result;
}

export async function sendMessageViaBridge(
  chatId: string,
  content: string,
  options: { replyTo?: string; parseMode?: 'plain' | 'markdown' | 'html' } | undefined,
  deps: {
    napcatRequest: <T>(endpoint: string, data?: Record<string, any>) => Promise<T>;
    rememberOutboundMessage: (result: unknown, params: { threadId: string; timestamp?: number }) => Promise<void>;
    logger: { info: (message: string) => void };
  },
): Promise<void> {
  const target = extractTargetFromThreadId(chatId);
  if (!target) {
    throw new Error(`Invalid chat ID: ${chatId}`);
  }

  const messageSegments: Array<{ type: string; data: Record<string, any> }> = [
    { type: 'text', data: { text: content } },
  ];

  if (options?.replyTo) {
    messageSegments.unshift({
      type: 'reply',
      data: { id: options.replyTo },
    });
  }

  await sendSegmentsToTarget(target, messageSegments, chatId, deps);
  deps.logger.info(`Sent message to ${chatId}: ${content.slice(0, 50)}...`);
}

export async function sendImageViaBridge(
  chatId: string,
  imagePath: string,
  caption: string | undefined,
  deps: {
    napcatRequest: <T>(endpoint: string, data?: Record<string, any>) => Promise<T>;
    rememberOutboundMessage: (result: unknown, params: { threadId: string; timestamp?: number }) => Promise<void>;
  },
): Promise<void> {
  const target = extractTargetFromThreadId(chatId);
  if (!target) {
    throw new Error(`Invalid chat ID: ${chatId}`);
  }

  const messageSegments: Array<{ type: string; data: Record<string, any> }> = [
    { type: 'image', data: { file: imagePath } },
  ];

  if (caption) {
    messageSegments.unshift({ type: 'text', data: { text: caption } });
  }

  await sendSegmentsToTarget(target, messageSegments, chatId, deps);
}

export async function sendFileViaBridge(
  chatId: string,
  filePath: string,
  deps: {
    napcatRequest: <T>(endpoint: string, data?: Record<string, any>) => Promise<T>;
  },
): Promise<void> {
  const target = extractTargetFromThreadId(chatId);
  if (!target) {
    throw new Error(`Invalid chat ID: ${chatId}`);
  }

  if (target.chatType !== 'group') {
    throw new Error('File sending is only supported for group chats');
  }

  const fileName = filePath.split('/').pop() || 'file';

  await deps.napcatRequest('/upload_group_file', {
    group_id: parseInt(target.targetId),
    file: filePath,
    name: fileName,
  });
}

export function forwardMessageToAlma(
  parsedMessage: {
    messageId: number;
    threadInfo: { threadId: string };
    userId: string;
    textContent: string;
    timestamp: number;
    messageType: 'private' | 'group';
  },
  almaMessageHandlers: Array<(message: IncomingMessage) => void | Promise<void>>,
  logger: { error: (message: string, error: unknown) => void },
): Promise<void> {
  if (almaMessageHandlers.length === 0) {
    return Promise.resolve();
  }

  const incomingMessage: IncomingMessage = {
    id: `qq:${parsedMessage.messageId}`,
    chatId: parsedMessage.threadInfo.threadId,
    userId: parsedMessage.userId,
    text: parsedMessage.textContent,
    timestamp: parsedMessage.timestamp * 1000,
    isGroup: parsedMessage.messageType === 'group',
  };

  return almaMessageHandlers.reduce<Promise<void>>(async (prev, handler) => {
    await prev;
    try {
      await handler(incomingMessage);
    } catch (error) {
      logger.error('Error in Alma message handler:', error);
    }
  }, Promise.resolve());
}

export async function sendThreadMessage(
  params: {
    thread_id: string;
    message: string;
    at_sender?: boolean;
    quote_message?: boolean;
    quote_message_id?: string;
  },
  deps: {
    threadManager: ThreadManager;
    sendSegmentsToTarget: (
      target: { chatType: 'private' | 'group'; targetId: string },
      messageSegments: Record<string, any>[],
      threadId: string,
    ) => Promise<any>;
  },
): Promise<any> {
  const target = extractTargetFromThreadId(params.thread_id);
  if (!target) {
    throw new Error(`Invalid thread ID: ${params.thread_id}`);
  }

  const thread = deps.threadManager.get(params.thread_id);
  const messageSegments = buildOutboundSegments({
    message: params.message,
    atSender: params.at_sender,
    senderId: thread?.lastSenderId,
    quoteMessage: params.quote_message,
    quoteMessageId: params.quote_message_id,
  });
  return deps.sendSegmentsToTarget(target, messageSegments, params.thread_id);
}

export function buildThreadId(chatType: 'private' | 'group', chatId: string): string {
  return chatType === 'group'
    ? ThreadIdGenerator.groupChat(chatId)
    : ThreadIdGenerator.privateChat(chatId);
}
