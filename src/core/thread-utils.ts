/**
 * Thread Utilities for QQ Channel Plugin
 * ======================================
 * Provides thread ID generation and mapping for QQ messages.
 * Maps QQ chats (private/group) to Alma thread IDs for conversation continuity.
 */

// ============================================================================
// Thread ID Types
// ============================================================================

/** Thread type: private chat or group chat */
export type ThreadType = 'private' | 'group';

/** Thread information for a QQ chat session */
export interface ThreadInfo {
  /** Thread ID - Alma's unique identifier for this conversation */
  threadId: string;
  /** Thread type */
  type: ThreadType;
  /** Group ID (only for group chats) */
  groupId?: string;
  /** Group name (only for group chats) */
  groupName?: string;
  /** User ID (only for private chats) */
  userId?: string;
  /** Display name for this thread */
  displayName: string;
  /** Avatar URL */
  avatarUrl?: string;
}

/** Thread ID generator namespace */
export namespace ThreadIdGenerator {
  /** Prefix for QQ thread IDs */
  export const PREFIX = 'qq';

  /**
   * Generate a thread ID for a private chat
   * Format: qq:private:{userId}
   * @param userId - QQ user ID
   * @returns Thread ID string
   */
  export function privateChat(userId: string): string {
    return `${PREFIX}:private:${userId}`;
  }

  /**
   * Generate a thread ID for a group chat
   * Format: qq:group:{groupId}
   * @param groupId - QQ group ID
   * @returns Thread ID string
   */
  export function groupChat(groupId: string): string {
    return `${PREFIX}:group:${groupId}`;
  }

  /**
   * Parse a thread ID into its components
   * @param threadId - Thread ID to parse
   * @returns Parsed thread info or null if invalid
   */
  export function parse(threadId: string): {
    platform: 'qq';
    type: ThreadType;
    id: string;
  } | null {
    const parts = threadId.split(':');
    if (parts.length !== 3 || parts[0] !== PREFIX) {
      return null;
    }
    const type = parts[1] as ThreadType;
    if (type !== 'private' && type !== 'group') {
      return null;
    }
    return {
      platform: 'qq',
      type,
      id: parts[2],
    };
  }

  /**
   * Check if a thread ID is valid
   * @param threadId - Thread ID to validate
   * @returns True if valid
   */
  export function isValid(threadId: string): boolean {
    return parse(threadId) !== null;
  }

  /**
   * Extract the QQ ID from a thread ID
   * @param threadId - Thread ID
   * @returns QQ ID or null if invalid
   */
  export function extractId(threadId: string): string | null {
    const parsed = parse(threadId);
    return parsed?.id ?? null;
  }

  /**
   * Get the thread type from a thread ID
   * @param threadId - Thread ID
   * @returns Thread type or null if invalid
   */
  export function getType(threadId: string): ThreadType | null {
    const parsed = parse(threadId);
    return parsed?.type ?? null;
  }
}

// ============================================================================
// Thread Info Builder
// ============================================================================

/**
 * Build thread info from NapCat message data
 * @param messageData - Raw NapCat message data
 * @param botQQ - Bot's QQ number (for determining display name)
 * @returns ThreadInfo object
 */
export function buildThreadInfo(
  messageData: {
    message_type?: 'private' | 'group';
    user_id?: number;
    group_id?: number;
    sender?: {
      nickname?: string;
      card?: string;
    };
    group_name?: string;
  },
  botQQ: string
): ThreadInfo {
  const messageType = messageData.message_type ?? 'private';

  if (messageType === 'group') {
    const groupId = String(messageData.group_id ?? '');
    const groupName = messageData.group_name?.trim() || `Group ${groupId}`;
    const displayName = `QQ Group: ${groupName} ${groupId}`;

    return {
      threadId: ThreadIdGenerator.groupChat(groupId),
      type: 'group',
      groupId,
      groupName,
      displayName,
    };
  } else {
    const userId = String(messageData.user_id ?? '');
    const sender = messageData.sender ?? {};
    const userName = sender.nickname?.trim() || sender.card?.trim() || `User ${userId}`;
    const displayName = `QQ: ${userName} ${userId}`;

    return {
      threadId: ThreadIdGenerator.privateChat(userId),
      type: 'private',
      userId,
      displayName,
    };
  }
}

// ============================================================================
// Thread Context for Messages
// ============================================================================

/**
 * Thread context attached to messages for Alma processing
 */
export interface ThreadContext {
  /** Thread ID for this conversation */
  threadId: string;
  /** Thread type */
  type: ThreadType;
  /** Original message ID from NapCat */
  napcatMessageId: number;
  /** Whether this message is @ mentioning the bot */
  isAtBot: boolean;
  /** Whether this is a reply to a previous message */
  isReply: boolean;
  /** ID of message being replied to (if any) */
  replyToMessageId?: number;
  /** User ID of the message being replied to (if any) */
  replyToUserId?: string;
}

/**
 * Create thread context from parsed message data
 * @param params - Message parameters
 * @returns ThreadContext
 */
export function createThreadContext(params: {
  messageType: 'private' | 'group';
  userId: string;
  groupId?: string;
  messageId: number;
  isAtBot: boolean;
  replyToMessageId?: number;
  replyToUserId?: string;
}): ThreadContext {
  const threadId = params.messageType === 'group' && params.groupId
    ? ThreadIdGenerator.groupChat(params.groupId)
    : ThreadIdGenerator.privateChat(params.userId);

  return {
    threadId,
    type: params.messageType,
    napcatMessageId: params.messageId,
    isAtBot: params.isAtBot,
    isReply: !!params.replyToMessageId,
    replyToMessageId: params.replyToMessageId,
    replyToUserId: params.replyToUserId,
  };
}

// ============================================================================
// Thread Storage Helper
// ============================================================================

/**
 * Thread metadata for persistence
 */
export interface ThreadMetadata {
  threadId: string;
  type: ThreadType;
  qqId: string; // groupId or userId
  displayName: string;
  almaThreadId?: string;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  lastSenderId?: string;
  lastMessageId?: number;
}

/**
 * Thread manager for tracking active threads
 */
export class ThreadManager {
  private threads = new Map<string, ThreadMetadata>();

  /**
   * Get or create thread metadata
   * @param threadInfo - Thread info
   * @returns Thread metadata
   */
  getOrCreate(
    threadInfo: ThreadInfo,
    activity?: { senderId?: string; messageId?: number }
  ): ThreadMetadata {
    const existing = this.threads.get(threadInfo.threadId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      existing.messageCount++;
      if (activity?.senderId) {
        existing.lastSenderId = activity.senderId;
      }
      if (activity?.messageId !== undefined) {
        existing.lastMessageId = activity.messageId;
      }
      return existing;
    }

    const now = Date.now();
      const metadata: ThreadMetadata = {
        threadId: threadInfo.threadId,
        type: threadInfo.type,
        qqId: threadInfo.groupId ?? threadInfo.userId ?? '',
        displayName: threadInfo.displayName,
        almaThreadId: undefined,
        createdAt: now,
        lastActivityAt: now,
        messageCount: 1,
        lastSenderId: activity?.senderId,
        lastMessageId: activity?.messageId,
    };

    this.threads.set(threadInfo.threadId, metadata);
    return metadata;
  }

  /**
   * Get thread metadata by ID
   * @param threadId - Thread ID
   * @returns Thread metadata or undefined
   */
  get(threadId: string): ThreadMetadata | undefined {
    return this.threads.get(threadId);
  }

  /**
   * Get all active threads
   * @returns Array of thread metadata
   */
  getAll(): ThreadMetadata[] {
    return Array.from(this.threads.values());
  }

  /**
   * Replace all threads from persisted metadata
   */
  replaceAll(threads: ThreadMetadata[]): void {
    this.threads.clear();
    for (const thread of threads) {
      this.threads.set(thread.threadId, thread);
    }
  }

  /**
   * Get threads by type
   * @param type - Thread type filter
   * @returns Array of thread metadata
   */
  getByType(type: ThreadType): ThreadMetadata[] {
    return this.getAll().filter(t => t.type === type);
  }

  /**
   * Update thread display name
   * @param threadId - Thread ID
   * @param displayName - New display name
   */
  updateDisplayName(threadId: string, displayName: string): void {
    const thread = this.threads.get(threadId);
    if (thread) {
      thread.displayName = displayName;
    }
  }

  setAlmaThreadId(threadId: string, almaThreadId: string): void {
    const thread = this.threads.get(threadId);
    if (thread) {
      thread.almaThreadId = almaThreadId;
    }
  }

  clearAlmaThreadId(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (thread) {
      thread.almaThreadId = undefined;
    }
  }

  /**
   * Remove a thread
   * @param threadId - Thread ID to remove
   */
  remove(threadId: string): void {
    this.threads.delete(threadId);
  }

  /**
   * Clear all threads
   */
  clear(): void {
    this.threads.clear();
  }

  /**
   * Get thread count
   */
  get size(): number {
    return this.threads.size;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Extract target ID from thread ID for sending messages
 * @param threadId - Thread ID
 * @returns Object with chat type and target ID
 */
export function extractTargetFromThreadId(threadId: string): {
  chatType: 'private' | 'group';
  targetId: string;
} | null {
  const parsed = ThreadIdGenerator.parse(threadId);
  if (!parsed) return null;

  return {
    chatType: parsed.type,
    targetId: parsed.id,
  };
}

/**
 * Generate a display name for a thread
 * @param threadId - Thread ID
 * @param metadata - Optional metadata for better naming
 * @returns Display name
 */
export function generateDisplayName(
  threadId: string,
  metadata?: { nickname?: string; groupName?: string }
): string {
  const parsed = ThreadIdGenerator.parse(threadId);
  if (!parsed) return 'Unknown';

  if (parsed.type === 'group') {
    return metadata?.groupName ?? `Group ${parsed.id}`;
  } else {
    return metadata?.nickname ?? `User ${parsed.id}`;
  }
}
