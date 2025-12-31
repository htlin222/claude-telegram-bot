# Security Model

This document describes the security architecture of the Claude Telegram Bot.

## Threat Model

The bot is designed for **personal use by trusted users**. The primary threats we defend against:

1. **Unauthorized access** - Someone discovers or steals your bot token
2. **Prompt injection** - Malicious content in messages tries to manipulate Claude
3. **Accidental damage** - Legitimate users accidentally running destructive commands
4. **Credential exposure** - Attempts to extract API keys, passwords, or secrets

## Defense in Depth

The bot implements multiple layers of security:

### Layer 1: User Allowlist

Only Telegram users whose IDs are in `TELEGRAM_ALLOWED_USERS` can interact with the bot.

```
User sends message → Check user ID in allowlist → Reject if not authorized
```

- User IDs are numeric and cannot be spoofed in Telegram
- Get your ID from [@userinfobot](https://t.me/userinfobot)
- Unauthorized attempts are logged

### Layer 2: Rate Limiting

Token bucket rate limiting prevents abuse even if credentials are compromised.

```
Default: 20 requests per 60 seconds per user
```

Configure via:
- `RATE_LIMIT_ENABLED` - Enable/disable (default: true)
- `RATE_LIMIT_REQUESTS` - Requests per window (default: 20)
- `RATE_LIMIT_WINDOW` - Window in seconds (default: 60)

### Layer 3: Intent Classification

Every message is classified by a fast AI model (Claude Haiku) before being processed.

```
Message → Haiku classifies intent → UNSAFE messages are blocked
```

**UNSAFE triggers:**
- Requesting raw secrets (.env, API keys, SSH keys, passwords)
- Social engineering ("ignore instructions", "pretend you're...")
- Prompt injection attempts

**SAFE by design:**
- File operations (search, read, edit)
- Email, calendar, tasks
- Coding help, debugging
- Web search, research

The classifier errs on the side of allowing requests. Only clear security threats are blocked.

### Layer 4: Path Validation

File operations are restricted to explicitly allowed directories.

```
Default allowed paths:
- CLAUDE_WORKING_DIR
- ~/Documents
- ~/Downloads
- ~/Desktop
```

Customize via `ALLOWED_PATHS` (comma-separated).

**Validation uses proper path containment checks:**
- Symlinks are resolved before checking
- Path traversal attacks (../) are prevented
- Only exact directory matches are allowed

**Exception for temp files:**
- Reading from /tmp/ and /var/folders/ is allowed
- This enables handling of Telegram-downloaded files

### Layer 5: Command Safety

Dangerous shell commands are blocked as defense-in-depth:

```
Blocked patterns:
- rm -rf / (or ~ or $HOME)
- sudo rm
- Fork bombs
- Direct disk writes (> /dev/sd, mkfs, dd if=)
```

For `rm` commands specifically, each path argument is validated against allowed paths.

### Layer 6: System Prompt

Claude receives a safety prompt that instructs it to:

1. **Never delete files without explicit confirmation** - Must ask "Are you sure?"
2. **Only access allowed directories** - Refuse operations outside them
3. **Never run dangerous commands** - Even if asked
4. **Ask for confirmation on destructive actions**

This is the primary protection layer. The other layers are defense-in-depth.

### Layer 7: Audit Logging

All interactions are logged for security review.

```
Log location: /tmp/claude-telegram-audit.log (configurable)
```

Logged events:
- `message` - User messages and Claude responses
- `blocked` - Blocked requests (with reason and confidence)
- `auth` - Authorization attempts
- `tool_use` - Claude tool usage
- `error` - Errors during processing
- `rate_limit` - Rate limit events

Enable JSON format for easier parsing: `AUDIT_LOG_JSON=true`

## What This Doesn't Protect Against

1. **Malicious authorized users** - If you add someone to the allowlist, they have full access
2. **Zero-day vulnerabilities** - Unknown bugs in Claude, the SDK, or dependencies
3. **Physical access** - Someone with access to the machine running the bot
4. **Network interception** - Though Telegram uses encryption

## Recommendations

1. **Keep the allowlist small** - Only add users you fully trust
2. **Use a dedicated working directory** - Don't point at `/` or `~`
3. **Review audit logs periodically** - Look for suspicious patterns
4. **Keep dependencies updated** - Security patches for the SDK and Telegram library
5. **Use a dedicated API key** - Create a separate Anthropic API key for the bot
6. **Enable email alerts** - Get notified when new sessions start

## Incident Response

If you suspect unauthorized access:

1. **Stop the bot**: `launchctl unload ~/Library/LaunchAgents/com.claude-telegram-ts.plist`
2. **Revoke the Telegram bot token**: Message @BotFather and create a new token
3. **Review audit logs**: Check `/tmp/claude-telegram-audit.log`
4. **Check for file changes**: Review recent activity in allowed directories
5. **Update credentials**: Rotate any API keys that may have been exposed

## Security Updates

If you discover a security issue:

1. **Don't open a public GitHub issue**
2. Contact the maintainer privately
3. Allow time for a fix before disclosure
