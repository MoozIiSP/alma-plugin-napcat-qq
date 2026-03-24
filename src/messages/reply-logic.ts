import {
  ALMA_TASK_RESPONSE_TIMEOUT_MS,
  ALMA_TEXT_RESPONSE_TIMEOUT_MS,
  ALMA_VISION_RESPONSE_TIMEOUT_MS,
  GROUP_NO_REPLY_SENTINEL,
  GROUP_OPEN_REPLY_MAX_LENGTH,
  GROUP_REPLY_DELAY_JITTER_MS,
  GROUP_REPLY_DELAY_MENTION_MS,
  GROUP_REPLY_DELAY_OPEN_MS,
} from '../core/constants';

export type ReplyStrategy = {
  text: string;
  mentionSender: boolean;
  delayMs: number;
  quoteMessageId?: string;
};

export function shouldRespond(
  parsed: any,
  config: any,
): boolean {
  if (!isAllowedSource(parsed, config)) {
    return false;
  }

  if (parsed.messageType === 'group' && config.respondToGroupMessage) {
    return true;
  }

  if (
    parsed.messageType === 'group' &&
    !config.respondToGroupMessage &&
    !parsed.isAtBot &&
    !parsed.triggerTypes.includes('reply_to_bot') &&
    !parsed.triggerTypes.includes('command_prefix')
  ) {
    return false;
  }

  if (parsed.isAtBot && config.respondToAt) {
    return true;
  }

  if (parsed.matchedKeywords.length > 0 && config.respondToKeyword) {
    if (config.requireAtForKeyword) {
      return parsed.isAtBot;
    }
    return true;
  }

  if (parsed.triggerTypes.includes('reply_to_bot') && config.respondToReply) {
    return true;
  }

  if (parsed.triggerTypes.includes('command_prefix')) {
    return true;
  }

  if (parsed.triggerTypes.includes('direct_message') && config.respondToDirectMessage) {
    return true;
  }

  return false;
}

export function isAllowedSource(parsed: any, config: any): boolean {
  if (config.ignoredUsers.includes(parsed.userId)) {
    return false;
  }

  const normalizedRules = config.allowFrom.map((rule: string) => rule.trim()).filter(Boolean);
  if (normalizedRules.length === 0) {
    if (parsed.groupId && config.allowedGroups.length > 0 && !config.allowedGroups.includes(parsed.groupId)) {
      return false;
    }
    if (config.allowedUsers.length > 0 && !config.allowedUsers.includes(parsed.userId)) {
      return false;
    }
    return true;
  }

  const candidates = new Set<string>([
    parsed.messageType,
    `type:${parsed.messageType}`,
    `user:${parsed.userId}`,
  ]);

  if (parsed.groupId) {
    candidates.add(`group:${parsed.groupId}`);
  }

  for (const rule of normalizedRules) {
    if (rule === '*') {
      return true;
    }
    if (candidates.has(rule)) {
      return true;
    }
  }

  return false;
}

export function checkRateLimit(
  userId: string,
  config: any,
  rateLimitMap: Map<string, number[]>,
): boolean {
  if (!config.rateLimitEnabled) {
    return true;
  }

  const now = Date.now() / 1000;
  const window = config.rateLimitWindow;
  const maxMessages = config.rateLimitMessages;

  if (!rateLimitMap.has(userId)) {
    rateLimitMap.set(userId, []);
  }

  const timestamps = rateLimitMap.get(userId)!;
  const validTimestamps = timestamps.filter(ts => now - ts < window);
  rateLimitMap.set(userId, validTimestamps);

  if (validTimestamps.length < maxMessages) {
    validTimestamps.push(now);
    return true;
  }

  return false;
}

export function checkAtCooldown(
  userId: string,
  config: any,
  atCooldownMap: Map<string, number>,
): boolean {
  if (!config.atReplyEnabled) {
    return false;
  }

  const now = Date.now() / 1000;
  const lastReply = atCooldownMap.get(userId);

  if (!lastReply) {
    return true;
  }

  return now - lastReply >= config.atReplyCooldown;
}

export function markAtReplied(userId: string, atCooldownMap: Map<string, number>): void {
  atCooldownMap.set(userId, Date.now() / 1000);
}

export function generateReply(
  parsed: any,
  config: any,
  rateLimitMap: Map<string, number[]>,
): string | null {
  if (!checkRateLimit(parsed.userId, config, rateLimitMap)) {
    const cooldownReplies = config.replyTemplates.cooldown;
    return cooldownReplies[Math.floor(Math.random() * cooldownReplies.length)];
  }

  if (!shouldRespond(parsed, config)) {
    return null;
  }

  if (parsed.isAtBot) {
    if (parsed.matchedKeywords.length > 0) {
      const helpReplies = config.replyTemplates.keywordHelp;
      return helpReplies[Math.floor(Math.random() * helpReplies.length)];
    }
    const atReplies = config.replyTemplates.atResponse;
    return atReplies[Math.floor(Math.random() * atReplies.length)];
  }

  if (parsed.matchedKeywords.length > 0) {
    const helpReplies = config.replyTemplates.keywordHelp;
    return helpReplies[Math.floor(Math.random() * helpReplies.length)];
  }
  return null;
}

export function isTaskLikeRequest(parsedMessage: any): boolean {
  if (parsedMessage.matchedCommandPrefix) {
    return true;
  }

  const text = parsedMessage.textContent.toLowerCase();
  return /(task|任务|工具|tool|调用|执行|run\b|agent\b|workflow|工作流)/i.test(text);
}

export function getAlmaResponseTimeoutMs(parsedMessage: any): number {
  if (isTaskLikeRequest(parsedMessage)) {
    return ALMA_TASK_RESPONSE_TIMEOUT_MS;
  }

  if (parsedMessage.images.length > 0) {
    return ALMA_VISION_RESPONSE_TIMEOUT_MS;
  }

  return ALMA_TEXT_RESPONSE_TIMEOUT_MS;
}

export function getErrorSummary(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'Unknown error';

  const normalized = raw
    .replace(/\s+/g, ' ')
    .replace(/file:\/\/\/\S+/gi, '')
    .replace(/\bat\s+\S+\s+\([^)]+\)/gi, '')
    .replace(/\bcause:\s*.*/gi, '')
    .trim();

  if (/Failed to get Copilot API token/i.test(normalized)) {
    return '模型服务配置不可用，请检查 Alma 中的工具模型和对话模型配置后重试';
  }

  if (/timed out/i.test(normalized)) {
    return '模型服务响应超时';
  }

  if (/NapCat WebSocket is not connected/i.test(normalized)) {
    return 'QQ 连接未建立';
  }

  if (/Image source could not be resolved from NapCat/i.test(normalized)) {
    return '我这边暂时看不到图，你可以发一条文字描述再试试';
  }

  return normalized.slice(0, 80) || 'Unknown error';
}

export function buildServiceStatusSummary(runtimeStatus: {
  connection: string;
  lastError: string;
}): string {
  const qqStatus = runtimeStatus.connection === 'connected'
    ? 'QQ通道正常'
    : runtimeStatus.connection === 'connecting'
      ? 'QQ通道重连中'
      : 'QQ通道未连接';

  const modelStatus = runtimeStatus.lastError.startsWith('Alma WS:')
    ? '模型服务异常'
    : '模型服务状态未知';

  return `${qqStatus} | ${modelStatus}`;
}

export function buildErrorReply(error: unknown, config: any, runtimeStatus: { connection: string; lastError: string }): string {
  const base = config.replyTemplates.error[0] ?? '出错了，稍后再试';
  const detail = getErrorSummary(error).replace(/\s+/g, ' ').slice(0, 200);
  const status = buildServiceStatusSummary(runtimeStatus);
  const lines = [base];

  if (detail) {
    lines.push(`错误: ${detail}`);
  }
  if (status) {
    lines.push(`状态: ${status}`);
  }

  return lines.join('\n');
}

export function clampGroupReplyText(reply: string): string {
  const normalized = reply.replace(/\s+/g, ' ').trim();
  if (normalized.length <= GROUP_OPEN_REPLY_MAX_LENGTH) {
    return normalized;
  }

  const slice = normalized.slice(0, GROUP_OPEN_REPLY_MAX_LENGTH);
  const lastBreak = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('！'), slice.lastIndexOf('？'), slice.lastIndexOf(' '));
  const shortened = lastBreak >= 24 ? slice.slice(0, lastBreak + 1).trim() : slice.trim();
  return `${shortened}…`;
}

export function buildReplyStrategy(parsedMessage: any, reply: string, config: any): ReplyStrategy {
  if (parsedMessage.messageType !== 'group') {
    return {
      text: reply.trim(),
      mentionSender: false,
      delayMs: 0,
    };
  }

  const isExplicitTrigger = parsedMessage.isAtBot
    || parsedMessage.triggerTypes.includes('reply_to_bot')
    || parsedMessage.triggerTypes.includes('command_prefix');

  if (!config.respondToGroupMessage) {
    return {
      text: reply.trim(),
      mentionSender: true,
      delayMs: GROUP_REPLY_DELAY_MENTION_MS + Math.floor(Math.random() * 600),
      quoteMessageId: parsedMessage.threadContext.replyToMessageId?.toString()
        || String(parsedMessage.messageId),
    };
  }

  const quoteMessageId = parsedMessage.triggerTypes.includes('reply_to_bot')
    ? (parsedMessage.threadContext.replyToMessageId?.toString() || String(parsedMessage.messageId))
    : undefined;

  return {
    text: isExplicitTrigger ? reply.trim() : clampGroupReplyText(reply),
    mentionSender: config.atReplyEnabled,
    delayMs: (isExplicitTrigger ? GROUP_REPLY_DELAY_MENTION_MS : GROUP_REPLY_DELAY_OPEN_MS)
      + Math.floor(Math.random() * GROUP_REPLY_DELAY_JITTER_MS),
    quoteMessageId,
  };
}

export function normalizeGeneratedReply(parsedMessage: any, reply: string | null, config: any): string | null {
  if (!reply) {
    return null;
  }

  const normalized = reply.trim();
  if (!normalized) {
    return null;
  }

  if (
    parsedMessage.messageType === 'group'
    && config.respondToGroupMessage
    && normalized === GROUP_NO_REPLY_SENTINEL
  ) {
    return null;
  }

  return normalized;
}

export function getImageFallbackReply(parsedMessage: any, config: any): string | null {
  if (parsedMessage.images.length === 0) {
    return null;
  }

  if (config.almaVisionModel.trim()) {
    return null;
  }

  return '我这边暂时看不到图，你可以发一条文字描述，或者给我配置支持视觉理解的模型。';
}
