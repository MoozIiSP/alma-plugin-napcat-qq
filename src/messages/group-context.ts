export interface GroupContextMessage {
  senderName?: string;
  userId: string;
  messageType: 'private' | 'group';
  textContent: string;
  timestamp: number;
  messageId: number;
  triggerTypes: string[];
  groupId?: string;
  isAtBot?: boolean;
  isReplyToBot?: boolean;
}

export function getSenderLabel(message: Pick<GroupContextMessage, 'senderName' | 'userId' | 'messageType'>): string {
  const senderName = message.senderName?.trim();
  if (senderName && !/^\d+$/.test(senderName)) {
    return senderName;
  }

  return message.messageType === 'group' ? '群友' : '用户';
}

export function formatHistoryMessageEntry(message: GroupContextMessage): string {
  const senderLabel = getSenderLabel(message);
  return `[${senderLabel} ${message.userId}] ${message.textContent}`.trim();
}

export function extractMessageTerms(text: string): Set<string> {
  const matches = text.toLowerCase().match(/[a-z0-9\u4e00-\u9fa5]{2,}/g) || [];
  return new Set(matches.slice(0, 24));
}

export function scoreGroupHistoryMessage(current: GroupContextMessage, candidate: GroupContextMessage): number {
  let score = 0;

  if (candidate.userId === current.userId) {
    score += 4;
  }
  if (candidate.isAtBot || candidate.isReplyToBot) {
    score += 3;
  }
  if (candidate.triggerTypes.includes('at_bot')) {
    score += 3;
  }
  if (candidate.triggerTypes.includes('reply_to_bot')) {
    score += 2;
  }

  const currentTerms = extractMessageTerms(current.textContent);
  const candidateTerms = extractMessageTerms(candidate.textContent);
  for (const term of currentTerms) {
    if (candidateTerms.has(term)) {
      score += 2;
    }
  }

  const timeDistance = Math.max(0, current.timestamp - candidate.timestamp);
  if (timeDistance < 60) {
    score += 3;
  } else if (timeDistance < 5 * 60) {
    score += 2;
  } else if (timeDistance < 15 * 60) {
    score += 1;
  }

  return score;
}

export function buildGroupHistoryContext(
  parsedMessage: GroupContextMessage,
  options: {
    historyLimit: number;
    charLimit: number;
    getMessageHistory: (groupId: string, limit: number) => GroupContextMessage[];
  },
): string {
  if (!parsedMessage.groupId) {
    return '';
  }

  const candidateMessages = options.getMessageHistory(parsedMessage.groupId, options.historyLimit * 3)
    .filter(message => message.messageId !== parsedMessage.messageId);

  const recentMessages = candidateMessages
    .map(message => ({
      message,
      score: scoreGroupHistoryMessage(parsedMessage, message),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.message.timestamp - b.message.timestamp;
    })
    .slice(0, options.historyLimit)
    .sort((a, b) => a.message.timestamp - b.message.timestamp)
    .map(item => item.message);

  if (recentMessages.length === 0) {
    return '';
  }

  const lines = recentMessages.map(formatHistoryMessageEntry);
  const chunks: string[] = [];
  let totalLength = 0;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const nextLength = totalLength === 0 ? line.length : totalLength + 1 + line.length;
    if (nextLength > options.charLimit) {
      break;
    }
    chunks.unshift(line);
    totalLength = nextLength;
  }

  if (chunks.length === 0) {
    return '';
  }

  return [
    '以下是本群最近消息，按时间顺序排列：',
    ...chunks,
  ].join('\n');
}
