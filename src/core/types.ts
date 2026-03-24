/**
 * QQ Channel Plugin - Local Type Definitions
 * Based on Alma Plugin API types
 */

import { z } from 'zod';

// ============================================================================
// Plugin Manifest Types
// ============================================================================

export type PluginType =
  | 'tool'
  | 'ui'
  | 'theme'
  | 'provider'
  | 'transform'
  | 'integration'
  | 'composite';

export interface PluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

export interface PluginEngine {
  alma: string;
}

export interface PluginContributes {
  tools?: ToolContribution[];
  commands?: CommandContribution[];
  configuration?: ConfigurationContribution;
  themes?: ThemeContribution[];
  providers?: ProviderContribution[];
  transforms?: TransformContribution[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: PluginAuthor;
  main: string;
  engines: PluginEngine;
  type: PluginType;
  permissions?: PluginPermission[];
  activationEvents?: ActivationEvent[];
  contributes?: PluginContributes;
}

// ============================================================================
// Plugin Permissions
// ============================================================================

export type PluginPermission =
  | 'notifications'
  | 'storage'
  | 'network'
  | 'filesystem'
  | 'shell'
  | 'clipboard'
  | 'webview'
  | 'settings';

// ============================================================================
// Activation Events
// ============================================================================

export type ActivationEvent =
  | 'onStartup'
  | `onCommand:${string}`
  | `onTool:${string}`
  | `onEvent:${string}`
  | `onLanguage:${string}`;

// ============================================================================
// Tool Contributions
// ============================================================================

export interface ToolContribution {
  id: string;
  name: string;
  description: string;
  parameters: z.ZodType<any>;
  execute: (params: any, context: ToolContext) => Promise<any>;
}

export interface ToolContext {
  chatId?: string;
  userId?: string;
  messageId?: string;
  abortSignal?: AbortSignal;
}

// ============================================================================
// Command Contributions
// ============================================================================

export interface CommandContribution {
  id: string;
  title: string;
  description?: string;
  category?: string;
  keybinding?: string;
  handler: (context: CommandContext) => Promise<void>;
}

export interface CommandContext {
  args: string[];
  options: Record<string, any>;
  chatId?: string;
  userId?: string;
}

// ============================================================================
// Configuration Contributions
// ============================================================================

export interface ConfigurationContribution {
  properties: Record<string, ConfigProperty>;
}

export interface ConfigProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  default?: any;
  description: string;
  enum?: any[];
  minimum?: number;
  maximum?: number;
}

// ============================================================================
// Theme Contributions
// ============================================================================

export interface ThemeContribution {
  id: string;
  label: string;
  uiTheme: 'dark' | 'light' | 'high-contrast';
  path: string;
}

// ============================================================================
// Provider Contributions
// ============================================================================

export interface ProviderContribution {
  id: string;
  name: string;
  description: string;
  models: ModelInfo[];
  createChatCompletion: (params: ChatCompletionParams) => Promise<ChatCompletionResponse>;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  supportsStreaming: boolean;
  supportsVision: boolean;
}

export interface ChatCompletionParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// ============================================================================
// Transform Contributions
// ============================================================================

export interface TransformContribution {
  id: string;
  name: string;
  description: string;
  transformType: 'message' | 'prompt' | 'response';
  transform: (input: string, context: TransformContext) => Promise<string>;
}

export interface TransformContext {
  chatId?: string;
  userId?: string;
  metadata?: Record<string, any>;
}

// ============================================================================
// Plugin Context (passed to activate function)
// ============================================================================

export interface PluginContext {
  // Plugin metadata
  id: string;
  extensionPath: string;
  storagePath: string;

  // Logging
  logger: Logger;

  // Storage
  storage: Storage;

  // Registration APIs
  tools: ToolRegistry;
  commands: CommandRegistry;
  events: EventRegistry;
  ui: UIRegistry;
  chat: ChatRegistry;
  providers: ProviderRegistry;

  // Workspace
  workspace: WorkspaceAPI;
  settings: SettingsAPI;
  i18n: I18nAPI;
}

// ============================================================================
// Logger Interface
// ============================================================================

export interface Logger {
  trace(message: string, ...args: any[]): void;
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

// ============================================================================
// Storage Interface
// ============================================================================

export interface Storage {
  get<T>(key: string, defaultValue?: T): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

// ============================================================================
// Tool Registry
// ============================================================================

export interface ToolRegistry {
  register(id: string, tool: ToolDefinition): void;
  unregister(id: string): void;
  get(id: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
}

export interface ToolDefinition {
  description: string;
  parameters: z.ZodType<any>;
  execute: (params: any, context: ToolContext) => Promise<any>;
}

// ============================================================================
// Command Registry
// ============================================================================

export interface CommandRegistry {
  register(id: string, handler: CommandHandler): void;
  unregister(id: string): void;
  execute(id: string, args: string[]): Promise<void>;
}

export type CommandHandler = (context: CommandContext) => Promise<void>;

// ============================================================================
// Event Registry
// ============================================================================

export interface EventRegistry {
  on<T>(event: string, listener: EventListener<T>): void;
  once<T>(event: string, listener: EventListener<T>): void;
  off<T>(event: string, listener: EventListener<T>): void;
  emit<T>(event: string, data: T): void;
}

export type EventListener<T> = (data: T) => void | Promise<void>;

// ============================================================================
// UI Registry
// ============================================================================

export interface UIRegistry {
  statusBar: StatusBarAPI;
  sidebar: SidebarAPI;
  settings: SettingsPanelAPI;
  showNotification?(message: string, options?: { type?: 'info' | 'warning' | 'error' }): void;
}

export interface StatusBarAPI {
  setItem(id: string, text: string, tooltip?: string, command?: string): void;
  removeItem(id: string): void;
}

export interface SidebarAPI {
  registerView(id: string, view: SidebarView): void;
  unregisterView(id: string): void;
}

export interface SidebarView {
  title: string;
  icon?: string;
  render(): string | unknown;
}

export interface SettingsPanelAPI {
  registerSection(id: string, section: SettingsSection): void;
  unregisterSection(id: string): void;
}

export interface SettingsSection {
  title: string;
  description?: string;
  fields: SettingsField[];
}

export interface SettingsField {
  id: string;
  type: 'text' | 'number' | 'boolean' | 'select' | 'password';
  label: string;
  description?: string;
  default?: any;
  options?: { label: string; value: any }[];
}

// ============================================================================
// Chat Registry
// ============================================================================

export interface ChatRegistry {
  sendMessage(chatId: string, content: string, options?: SendMessageOptions): Promise<void>;
  sendImage(chatId: string, imagePath: string, caption?: string): Promise<void>;
  sendFile(chatId: string, filePath: string): Promise<void>;
  onMessage(handler: MessageHandler): void;
}

export interface SendMessageOptions {
  replyTo?: string;
  parseMode?: 'plain' | 'markdown' | 'html';
}

export type MessageHandler = (message: IncomingMessage) => void | Promise<void>;

export interface IncomingMessage {
  id: string;
  chatId: string;
  userId: string;
  text: string;
  timestamp: number;
  isGroup: boolean;
}

// ============================================================================
// Provider Registry
// ============================================================================

export interface ProviderRegistry {
  register(id: string, provider: AIProvider): void;
  unregister(id: string): void;
  get(id: string): AIProvider | undefined;
  list(): AIProvider[];
}

export interface AIProvider {
  name: string;
  models: ModelInfo[];
  createChatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResponse>;
}

// ============================================================================
// Workspace API
// ============================================================================

export interface WorkspaceAPI {
  rootPath: string | undefined;
  openFile(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  glob(pattern: string): Promise<string[]>;
}

// ============================================================================
// Settings API
// ============================================================================

export interface SettingsAPI {
  get<T>(key: string, defaultValue?: T): T | undefined;
  set<T>(key: string, value: T): Promise<void>;
  onChange(key: string, callback: (value: any) => void): void;
}

// ============================================================================
// I18n API
// ============================================================================

export interface I18nAPI {
  t(key: string, params?: Record<string, any>): string;
  setLocale(locale: string): void;
  getLocale(): string;
}

// ============================================================================
// Plugin Activation
// ============================================================================

export interface PluginActivation {
  dispose(): void;
}

export type ActivateFunction = (
  context: PluginContext
) => Promise<PluginActivation>;

// ============================================================================
// Plugin Module Interface
// ============================================================================

export interface PluginModule {
  activate: ActivateFunction;
  deactivate?: () => Promise<void>;
}

// ============================================================================
// Thread Types (for QQ Channel Plugin)
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

/** Thread context attached to messages for Alma processing */
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

/** QQ Message Event for Alma EventRegistry */
export interface QQMessageEvent {
  /** Event type */
  type: 'qq.message.received';
  /** Event version */
  version: '1.1.0';
  /** Message unique ID */
  messageId: string;
  /** Sender information */
  sender: {
    userId: string;
    nickname: string;
    card?: string;
    role?: 'member' | 'admin' | 'owner';
    isBot: boolean;
  };
  /** Message content */
  content: {
    raw: string;
    text: string;
    segments: MessageSegment[];
  };
  /** Thread information */
  thread: ThreadInfo;
  /** Thread context */
  threadContext: ThreadContext;
  /** Message metadata */
  metadata: {
    platform: 'qq';
    napcatMessageId: number;
    isAtBot: boolean;
    triggerTypes: string[];
    matchedKeywords: string[];
    isReply: boolean;
    replyToMessageId?: string;
    replyToUserId?: string;
  };
  /** Timestamp (milliseconds) */
  timestamp: number;
}

/** Message segment types */
export type MessageSegment =
  | { type: 'text'; data: { text: string } }
  | { type: 'at'; data: { qq: string; name?: string } }
  | { type: 'image'; data: { file: string; url?: string } }
  | { type: 'record'; data: { file: string } }
  | { type: 'video'; data: { file: string } }
  | { type: 'file'; data: { file: string; name: string } }
  | { type: 'reply'; data: { messageId: string; userId: string } }
  | { type: 'face'; data: { id: string } }
  | { type: 'json'; data: { data: string } }
  | { type: 'xml'; data: { data: string } };

/** QQ Reply Request from Alma to Plugin */
export interface QQReplyRequest {
  /** Target Thread ID */
  threadId: string;
  /** Reply content */
  content: string;
  /** Reply options */
  options?: {
    atSender?: boolean;
    quoteMessage?: boolean;
    quoteMessageId?: string;
    segments?: MessageSegment[];
    timeout?: number;
  };
}

/** QQ Command Request from Alma to Plugin */
export interface QQCommandRequest {
  /** Command type */
  type: 'send_message' | 'send_image' | 'send_file' | 'get_history';
  /** Thread ID */
  threadId: string;
  /** Command parameters */
  params: Record<string, any>;
}

/** Event names for QQ Channel Plugin */
export const QQ_MESSAGE_EVENTS = {
  /** Message received from QQ */
  MESSAGE_RECEIVED: 'qq.message.received',
  /** Message handled by Alma */
  MESSAGE_HANDLED: 'qq.message.handled',
  /** Error processing message */
  MESSAGE_ERROR: 'qq.message.error',
  /** New thread created */
  THREAD_CREATED: 'qq.thread.created',
  /** Thread updated */
  THREAD_UPDATED: 'qq.thread.updated',
} as const;
