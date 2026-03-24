import { z } from 'zod';

import type { PluginContext } from './types';

const ReplyTemplatesSchema = z.object({
  atResponse: z.array(z.string()).default(['来了来了~', '在呢在呢', '啥事', '嗯？', '说']),
  keywordHelp: z.array(z.string()).default(['需要帮忙吗？', '我在，请说', '有什么可以帮你的？']),
  default: z.array(z.string()).default(['嗯哼~', '哦哦', '知道了', '行', '好滴', '👌', '嗯嗯', '好']),
  error: z.array(z.string()).default(['出错了，稍后再试', '有点问题，等一下']),
  cooldown: z.array(z.string()).default(['说太快啦，等一下', '别急嘛']),
});

const GroupPolicySchema = z.object({
  almaModel: z.string().optional(),
  almaVisionModel: z.string().optional(),
  allowFrom: z.array(z.string()).optional(),
  allowedGroups: z.array(z.string()).optional(),
  allowedUsers: z.array(z.string()).optional(),
  ignoredUsers: z.array(z.string()).optional(),
  commandPrefixes: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  respondToDirectMessage: z.boolean().optional(),
  respondToGroupMessage: z.boolean().optional(),
  respondToAt: z.boolean().optional(),
  respondToKeyword: z.boolean().optional(),
  respondToReply: z.boolean().optional(),
  requireAtForKeyword: z.boolean().optional(),
  groupContextMessageLimit: z.number().optional(),
  groupContextCharLimit: z.number().optional(),
  rateLimitEnabled: z.boolean().optional(),
  rateLimitMessages: z.number().optional(),
  rateLimitWindow: z.number().optional(),
  atReplyEnabled: z.boolean().optional(),
  atReplyCooldown: z.number().optional(),
  replyTemplates: ReplyTemplatesSchema.partial().optional(),
});

export const QQChannelConfigSchema = z.object({
  napcatWsUrl: z.string().default('ws://127.0.0.1:6099/ws'),
  almaModel: z.string().default('openai:gpt-4o'),
  almaVisionModel: z.string().default(''),
  token: z.string().default(''),
  botQQ: z.string().default(''),
  defaultGroup: z.string().default(''),
  allowFrom: z.array(z.string()).default([]),
  allowedGroups: z.array(z.string()).default([]),
  allowedUsers: z.array(z.string()).default([]),
  ignoredUsers: z.array(z.string()).default([]),
  commandPrefixes: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default(['启动', 'help', '帮助']),
  respondToDirectMessage: z.boolean().default(true),
  respondToGroupMessage: z.boolean().default(false),
  respondToAt: z.boolean().default(true),
  respondToKeyword: z.boolean().default(true),
  respondToReply: z.boolean().default(false),
  requireAtForKeyword: z.boolean().default(false),
  groupContextMessageLimit: z.number().default(20),
  groupContextCharLimit: z.number().default(4000),
  rateLimitEnabled: z.boolean().default(true),
  rateLimitMessages: z.number().default(10),
  rateLimitWindow: z.number().default(60),
  atReplyEnabled: z.boolean().default(true),
  atReplyCooldown: z.number().default(3),
  replyTemplates: ReplyTemplatesSchema.default({
    atResponse: ['来了来了~', '在呢在呢', '啥事', '嗯？', '说'],
    keywordHelp: ['需要帮忙吗？', '我在，请说', '有什么可以帮你的？'],
    default: ['嗯哼~', '哦哦', '知道了', '行', '好滴', '👌', '嗯嗯', '好'],
    error: ['出错了，稍后再试', '有点问题，等一下'],
    cooldown: ['说太快啦，等一下', '别急嘛'],
  }),
  groupPolicies: z.record(z.string(), GroupPolicySchema).default({}),
});

export type QQChannelConfig = z.infer<typeof QQChannelConfigSchema>;
export type QQGroupPolicy = z.infer<typeof GroupPolicySchema>;

export function loadLegacyConfig(ctx: PluginContext): Record<string, unknown> {
  return {
    napcatWsUrl: ctx.settings.get('qqchannel.napcatWsUrl', 'ws://127.0.0.1:6099/ws'),
    almaModel: ctx.settings.get('qqchannel.almaModel', 'openai:gpt-4o'),
    almaVisionModel: ctx.settings.get('qqchannel.almaVisionModel', ''),
    token: ctx.settings.get('qqchannel.token', ''),
    botQQ: ctx.settings.get('qqchannel.botQQ', ''),
    defaultGroup: ctx.settings.get('qqchannel.defaultGroup', ''),
    allowFrom: ctx.settings.get('qqchannel.allowFrom', []),
    allowedGroups: ctx.settings.get('qqchannel.allowedGroups', []),
    allowedUsers: ctx.settings.get('qqchannel.allowedUsers', []),
    ignoredUsers: ctx.settings.get('qqchannel.ignoredUsers', []),
    commandPrefixes: ctx.settings.get('qqchannel.commandPrefixes', []),
    keywords: ctx.settings.get('qqchannel.keywords', ['启动', 'help', '帮助']),
    respondToDirectMessage: ctx.settings.get('qqchannel.respondToDirectMessage', true),
    respondToGroupMessage: ctx.settings.get('qqchannel.respondToGroupMessage', false),
    respondToAt: ctx.settings.get('qqchannel.respondToAt', true),
    respondToKeyword: ctx.settings.get('qqchannel.respondToKeyword', true),
    respondToReply: ctx.settings.get('qqchannel.respondToReply', false),
    requireAtForKeyword: ctx.settings.get('qqchannel.requireAtForKeyword', false),
    groupContextMessageLimit: ctx.settings.get('qqchannel.groupContextMessageLimit', 20),
    groupContextCharLimit: ctx.settings.get('qqchannel.groupContextCharLimit', 4000),
    rateLimitEnabled: ctx.settings.get('qqchannel.rateLimitEnabled', true),
    rateLimitMessages: ctx.settings.get('qqchannel.rateLimitMessages', 10),
    rateLimitWindow: ctx.settings.get('qqchannel.rateLimitWindow', 60),
    atReplyEnabled: ctx.settings.get('qqchannel.atReplyEnabled', true),
    atReplyCooldown: ctx.settings.get('qqchannel.atReplyCooldown', 3),
    replyTemplates: ctx.settings.get('qqchannel.replyTemplates', {}),
    groupPolicies: ctx.settings.get('qqchannel.groupPolicies', {}),
  };
}

export function parseJsonConfigSetting(value: unknown): Record<string, unknown> | null {
  if (value == null || value === '') {
    return null;
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value !== 'string') {
    throw new Error('qqchannel.configJson must be a JSON object string');
  }

  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('qqchannel.configJson must decode to a JSON object');
  }

  return parsed as Record<string, unknown>;
}

export function loadConfig(
  ctx: PluginContext,
  hooks: {
    logError: (message: string, error: unknown) => void;
    notify: (message: string, type: 'info' | 'warning' | 'error') => void;
  },
): QQChannelConfig {
  const legacyConfig = loadLegacyConfig(ctx);
  const jsonSetting = ctx.settings.get('qqchannel.configJson', '');
  let jsonConfig: Record<string, unknown> | null = null;

  try {
    jsonConfig = parseJsonConfigSetting(jsonSetting);
  } catch (error) {
    hooks.logError('Failed to parse qqchannel.configJson', error);
    hooks.notify('QQ NapCat Channel configJson is invalid JSON; falling back to legacy settings.', 'warning');
  }

  return QQChannelConfigSchema.parse({
    ...legacyConfig,
    ...(jsonConfig ?? {}),
  });
}

export function getEffectiveConfig(
  config: QQChannelConfig,
  groupId?: string,
): QQChannelConfig {
  if (!groupId) {
    return config;
  }

  const policy = config.groupPolicies?.[groupId];
  if (!policy) {
    return config;
  }

  return {
    ...config,
    ...policy,
    replyTemplates: {
      ...config.replyTemplates,
      ...(policy.replyTemplates ?? {}),
    },
  };
}
