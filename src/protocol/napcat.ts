import { ThreadIdGenerator } from '../core/thread-utils';

export async function webSocketDataToText(data: unknown): Promise<string> {
  if (typeof data === 'string') {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf-8');
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf-8');
  }

  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return await data.text();
  }

  return String(data);
}

export function buildNapCatWebSocketUrl(config: { napcatWsUrl: string; token: string }): string {
  const wsUrl = new URL(config.napcatWsUrl);
  if (!wsUrl.searchParams.has('access_token') && config.token) {
    wsUrl.searchParams.set('access_token', config.token);
  }
  return wsUrl.toString();
}

export function parseCQCode(text: string): Array<{ type: string; data: Record<string, any> }> {
  const segments: Array<{ type: string; data: Record<string, any> }> = [];
  const regex = /\[CQ:([^,]+)((?:,[^=]+=[^\]]*)*)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const textSegment = text.slice(lastIndex, match.index).trim();
      if (textSegment) {
        segments.push({ type: 'text', data: { text: textSegment } });
      }
    }

    const cqType = match[1];
    const params: Record<string, string> = {};
    const paramStr = match[2] || '';
    const paramMatches = paramStr.matchAll(/,([^=]+)=([^\]]*)/g);

    for (const [, key, value] of paramMatches) {
      params[key] = value;
    }

    segments.push({ type: cqType, data: params });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) {
      segments.push({ type: 'text', data: { text: remaining } });
    }
  }

  return segments.length > 0 ? segments : [{ type: 'text', data: { text } }];
}

export function segmentToText(seg: { type: string; data: Record<string, any> }): string {
  switch (seg.type) {
    case 'text':
      return seg.data.text ?? '';
    case 'image':
      return '[图片]';
    case 'file':
      return `[文件:${seg.data.name ?? seg.data.file ?? 'unknown'}]`;
    case 'record':
      return '[语音]';
    case 'video':
      return '[视频]';
    case 'face':
      return '[表情]';
    case 'json':
      return '[JSON消息]';
    case 'xml':
      return '[XML消息]';
    default:
      return '';
  }
}

export function buildIncomingImageDebugPayload(
  messageId: number,
  groupId: string | undefined,
  userId: string,
  images: Array<{ file?: string; url?: string }>,
): { messageId: number; threadId: string; images: Array<{ file?: string; url?: string }> } {
  return {
    messageId,
    threadId: groupId ? ThreadIdGenerator.groupChat(groupId) : ThreadIdGenerator.privateChat(userId),
    images,
  };
}
