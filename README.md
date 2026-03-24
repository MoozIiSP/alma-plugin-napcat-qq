# QQ NapCat Channel

QQ NapCat Channel integration plugin for Alma, extracted from `/Users/mooziisp/GitRepos/qq-bot-mission` and reduced to the plugin-side runtime files.

## Development

- Keep plugin source in TypeScript.
- Bundle to a self-contained JavaScript file for Alma to load.
- Test by copying or pointing Alma to this plugin directory.

## TypeScript Setup

```bash
npm init -y
npm install -D typescript alma-plugin-api
npm install zod ws
npx tsc --init
```

## Included Capabilities

- NapCat / OneBot 11 HTTP API requests
- WebSocket RPC for QQ private and group messages
- QQ thread ID mapping like `qq:private:{userId}` and `qq:group:{groupId}`
- Alma chat bridge for inbound and outbound message forwarding
- Tool wrappers for send message, send image, send voice, send file, friend/group queries, moderation, and history lookup
- Rich message sending with mixed segments like text, @, image, voice, file, reply, JSON, and XML
- Basic trigger detection for `@bot`, keywords, direct message, cooldown, and rate limiting

## Configuration

Use a single `qqchannel.configJson` setting instead of Alma's field-by-field form UI.

Example:

```json
{
  "napcatWsUrl": "ws://127.0.0.1:6099/ws",
  "almaModel": "openai:gpt-4o",
  "almaVisionModel": "",
  "token": "",
  "botQQ": "",
  "allowFrom": ["private", "group:YOUR_GROUP_ID"],
  "respondToDirectMessage": true,
  "respondToGroupMessage": false,
  "respondToAt": true,
  "respondToReply": true,
  "groupContextMessageLimit": 20,
  "groupContextCharLimit": 4000,
  "atReplyEnabled": true,
  "groupPolicies": {
    "YOUR_GROUP_ID": {
      "respondToGroupMessage": true,
      "respondToReply": true,
      "groupContextMessageLimit": 30,
      "atReplyEnabled": false
    }
  }
}
```

`botQQ` can be left empty. The plugin will auto-detect it from NapCat `get_login_info` on startup.

The plugin still reads legacy `qqchannel.*` settings as a fallback, but new setups should use `qqchannel.configJson`.
Advanced fields such as `keywords`, rate limits, and custom reply templates are still supported, but omitted from the example unless you need them.

Group chat behavior:

- if `respondToGroupMessage` is `false`, group chats stay in mention/reply style and only send the current message to Alma
- if `respondToGroupMessage` is `true`, group chats prepend a recent-message window before the current message
- open group mode lets the model decide whether to stay silent for a given message
- `groupContextMessageLimit` controls how many recent group messages are injected
- `groupContextCharLimit` controls the total injected history size
- group replies can still `@` the triggering sender according to `atReplyEnabled`
- `groupPolicies.{groupId}` can override these settings per QQ group without affecting other groups

Image handling:

- when an incoming message contains an image, the plugin prefers `almaVisionModel` if configured
- the first image is resolved via NapCat and downloaded to a local cache path before sending to Alma
- if `almaVisionModel` is empty, the plugin replies with a fixed "看不到图" style fallback message instead of attempting OCR

Current runtime sends and receives through WebSocket only.
The Alma thread WebSocket endpoint is fixed to `ws://127.0.0.1:23001/ws/threads` and is not user-configurable.
The plugin needs network access to local Alma services on `localhost` and to the configured NapCat WebSocket service.

Required Alma permissions:

- `chat:read`
- `chat:write`
- `tools:register`
- `commands:register`
- `statusbar`
- `settings`
- `network:fetch`
- `network:localhost`

`network:localhost` is required for Alma's local thread WebSocket endpoint.
Remote NapCat access should not be pinned to a user-specific IP in the manifest. Use the generic `network:fetch` permission for configurable NapCat endpoints.

NapCat authentication uses the WebSocket URL query style, for example:

```text
ws://127.0.0.1:6099/ws?access_token=your-token
```

## Thread Reuse

This plugin now follows Alma's thread model:

- one QQ conversation maps to one persistent Alma thread
- private chat: one QQ user -> one Alma thread
- group chat: one QQ group -> one Alma thread
- no time-based or idle-based automatic thread rotation

That keeps QQ conversations isolated from each other and avoids cross-thread context pollution.

## Conversation Model

The plugin keeps Alma's thread model as the source of truth:

- one QQ chat maps to one Alma thread
- the `almaThreadId` is persisted and reused
- local storage only keeps message history, thread mapping, and delivery indexes
- the plugin does not try to replace Alma's thread/workspace model with a Telegram-style no-thread runtime

For group chats, the plugin also injects a small recent-message window into the current request:

- only group chats get explicit local history injection
- the latest group messages are formatted in chronological order and prepended to the current message
- this is an input enhancement for group continuity, not a replacement for Alma thread persistence

When `respondToGroupMessage` is disabled, group chats fall back to mention-only/private-style input and do not prepend the local history window.
Private chats still rely on the persistent Alma thread directly and do not prepend a local history window.

## Group Bot Philosophy

The plugin treats group-chat realism as a context problem first, not a wording problem:

- about 70% comes from context awareness: knowing what the group has been talking about
- about 20% comes from reply timing and formatting: whether to reply, when to reply, how long to reply, and whether to `@` or quote
- the remaining 10% comes from the LLM's wording style

In practice, that means the plugin should not behave like a stateless mention bot:

- when a group message does not trigger a reply, the plugin still updates the local sliding window
- when a message does trigger a reply, the plugin uses the current message plus recent group context
- mention-only mode stays more restrained and private-chat-like
- open group mode favors continuity and situational awareness over aggressive replying
- group replies use a lightweight strategy layer for delay, `@` behavior, and reply length restraint
- explicit reply-to-bot cases prefer quoting the original message to preserve turn structure

## Building

```bash
npm run build
```

- `npm run build` runs `bun build main.ts --outfile main.js --target node --format esm`
- `npm run typecheck` runs TypeScript checks without writing files

The generated [main.js](/Users/mooziisp/GitRepos/alma-plugin-qq-channel/main.js) is self-contained and does not require separate `thread-utils.js`, `types.js`, or runtime `node_modules` next to the plugin entry.

## Local Install

Use this directory directly as the local plugin path:

```text
/Users/mooziisp/GitRepos/alma-plugin-qq-channel
```

After rebuilding, Alma should load the bundled [main.js](/Users/mooziisp/GitRepos/alma-plugin-qq-channel/main.js) from this directory.

## Notes

- Runtime entry is [main.js](/Users/mooziisp/GitRepos/alma-plugin-qq-channel/main.js).
- Source implementation is in [main.ts](/Users/mooziisp/GitRepos/alma-plugin-qq-channel/main.ts) and the domain modules under [src](/Users/mooziisp/GitRepos/alma-plugin-qq-channel/src).
- If you need to rebuild, install dependencies from [package.json](/Users/mooziisp/GitRepos/alma-plugin-qq-channel/package.json) and run `npm run build`.
