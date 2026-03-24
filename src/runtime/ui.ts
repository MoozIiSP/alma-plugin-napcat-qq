import type { PluginContext } from '../core/types';

export type DebugLogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export type RuntimeStatus = {
  connection: string;
  lastMessage: string;
  lastThreadId: string;
  lastError: string;
  duplicateHits: number;
  reconnectDelayMs: number;
};

function safeSerialize(value: unknown): string {
  if (value instanceof Error) {
    return JSON.stringify({
      name: value.name,
      message: value.message,
      stack: value.stack,
      code: (value as Error & { code?: unknown }).code,
      cause: (value as Error & { cause?: unknown }).cause,
    });
  }
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function writeDebugLog(
  logPath: string,
  level: DebugLogLevel,
  message: string,
  extra?: unknown,
): void {
  const timestamp = new Date().toISOString();
  const suffix = extra === undefined ? '' : ` ${safeSerialize(extra)}`;
  try {
    const { appendFileSync } = require('node:fs') as typeof import('node:fs');
    appendFileSync(logPath, `[${timestamp}] [${level}] ${message}${suffix}\n`);
  } catch {
    // Ignore /tmp logging failures.
  }
}

export function installDebugLogMirror(
  ctx: PluginContext,
  logPath: string,
): void {
  const logger = ctx.logger as typeof ctx.logger & { __qqChannelDebugMirrorInstalled?: boolean };
  if (logger.__qqChannelDebugMirrorInstalled) {
    return;
  }

  const mirror = (level: DebugLogLevel, original: (message: string, ...args: any[]) => void) => {
    return (message: string, ...args: any[]): void => {
      const extra = args.length === 0 ? undefined : args.length === 1 ? args[0] : args;
      writeDebugLog(logPath, level, message, extra);
      original.call(ctx.logger, message, ...args);
    };
  };

  logger.trace = mirror('TRACE', logger.trace);
  logger.debug = mirror('DEBUG', logger.debug);
  logger.info = mirror('INFO', logger.info);
  logger.warn = mirror('WARN', logger.warn);
  logger.error = mirror('ERROR', logger.error);
  logger.__qqChannelDebugMirrorInstalled = true;
}

export function createRuntimeStatusController(
  ctx: PluginContext,
  ids: { statusBarId: string; sidebarViewId: string },
) {
  const status: RuntimeStatus = {
    connection: 'disconnected',
    lastMessage: '',
    lastThreadId: '',
    lastError: '',
    duplicateHits: 0,
    reconnectDelayMs: 0,
  };

  const update = (patch: Partial<RuntimeStatus>): void => {
    Object.assign(status, patch);

    const summary = status.connection === 'connected'
      ? 'QQ: Connected'
      : status.connection === 'connecting'
        ? 'QQ: Connecting'
        : 'QQ: Disconnected';

    const tooltipParts = [
      `Connection: ${status.connection}`,
      status.lastThreadId ? `Last thread: ${status.lastThreadId}` : '',
      status.lastMessage ? `Last message: ${status.lastMessage}` : '',
      status.lastError ? `Last error: ${status.lastError}` : '',
      `Duplicate hits: ${status.duplicateHits}`,
      status.reconnectDelayMs > 0 ? `Reconnect delay: ${status.reconnectDelayMs}ms` : '',
    ].filter(Boolean);

    try {
      ctx.ui?.statusBar?.setItem(ids.statusBarId, summary, tooltipParts.join('\n'));
    } catch {
      // Ignore status bar update failures.
    }
  };

  const registerView = (): void => {
    try {
      ctx.ui?.sidebar?.registerView?.(ids.sidebarViewId, {
        title: 'QQ NapCat Channel Status',
        render(): string {
          return [
            '# QQ NapCat Channel Status',
            '',
            `Connection: ${status.connection}`,
            `Last thread: ${status.lastThreadId || '-'}`,
            `Last message: ${status.lastMessage || '-'}`,
            `Last error: ${status.lastError || '-'}`,
            `Duplicate hits: ${status.duplicateHits}`,
            `Reconnect delay: ${status.reconnectDelayMs || 0}ms`,
          ].join('\n');
        },
      });
    } catch (error) {
      ctx.logger.warn('Failed to register QQ NapCat Channel sidebar view:', error);
    }
  };

  return { status, update, registerView };
}

export function showNotification(
  ctx: PluginContext,
  logPath: string,
  message: string,
  type: 'info' | 'warning' | 'error' = 'info',
): void {
  try {
    ctx.ui?.showNotification?.(message, { type });
  } catch (error) {
    ctx.logger.warn('Failed to show notification:', error);
    writeDebugLog(logPath, 'WARN', 'Failed to show notification', error);
  }
}
