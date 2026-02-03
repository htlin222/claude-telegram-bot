# Testing /restart Command

## Automated Tests

Run the unit tests:

```bash
bun test src/__tests__/restart.test.ts
```

This verifies:

- ✅ Startup mode detection (binary/CLI/development)
- ✅ TTY detection
- ✅ Restart command generation
- ✅ Warning and success message formatting

## Manual Testing Scenarios

### Scenario 1: Terminal Mode (Development)

**Setup:**

```bash
cd /Users/htlin/claude-telegram-bot
bun run start
```

**Expected behavior:**

1. Send `/restart` in Telegram
2. Bot replies with **warning message**:

   ```
   ⚠️ Terminal Mode Detected

   You started the bot from a terminal. Restarting will:
   • Detach from your current terminal session
   • Run in background
   • Log to: /tmp/claude-telegram-bot.log

   View logs after restart:
   tail -f /tmp/claude-telegram-bot.log

   Or stop and restart manually:
   • Press Ctrl+C
   • Run bun run "src/index.ts"
   ```

3. After 3 seconds, bot sends "🔄 Restarting bot..."
4. Terminal session ends (process exits)
5. Bot restarts in background
6. Bot updates message with:

   ```
   ✅ Bot Restarted

   PID: 12345
   Log: /tmp/claude-telegram-bot.log

   View logs:
   tail -f /tmp/claude-telegram-bot.log

   Stop bot:
   kill 12345
   ```

**Verify:**

- [ ] Original terminal shows no more output
- [ ] Bot is still responsive in Telegram
- [ ] `tail -f /tmp/claude-telegram-bot.log` shows new logs
- [ ] `ps aux | grep [b]un` shows new PID

---

### Scenario 2: CLI Mode

**Setup:**

```bash
cd ~/my-project
ctb
```

**Expected behavior:**
Same as Scenario 1, but with:

- Restart command shows: `bun "cli.ts"` or `bun "cli.js"`

---

### Scenario 3: Binary Mode

**Setup:**

```bash
# After building standalone binary
./ctb-binary
```

**Expected behavior:**
Same as Scenario 1, but with:

- Restart command shows the binary path (e.g., `/usr/local/bin/ctb`)

---

### Scenario 4: LaunchAgent Mode (Background)

**Setup:**

```bash
launchctl load ~/Library/LaunchAgents/com.claude-telegram-ts.plist
```

**Expected behavior:**

1. Send `/restart` in Telegram
2. **No warning message** (not TTY)
3. Bot sends "🔄 Restarting bot..."
4. Bot restarts immediately
5. Bot updates message with PID and log location

**Verify:**

- [ ] No warning about terminal detach
- [ ] Bot restarts quickly
- [ ] Logs continue in `/tmp/claude-telegram-bot.log`

---

## Verification Commands

After restart, verify the bot is running:

```bash
# Check process
ps aux | grep [b]un

# Check logs
tail -f /tmp/claude-telegram-bot.log

# Test bot responsiveness
# Send /status in Telegram

# Stop bot manually (use PID from restart message)
kill <PID>
```

---

## Edge Cases to Test

### Test 1: Restart during active query

**Steps:**

1. Send a long-running query (e.g., "analyze this codebase")
2. While Claude is working, send `/restart`

**Expected:**

- Warning appears (if TTY)
- Current query is interrupted
- Bot restarts successfully

### Test 2: Multiple rapid restarts

**Steps:**

1. Send `/restart`
2. Immediately send `/restart` again in another chat

**Expected:**

- First restart proceeds
- Second restart may fail (process already exiting)
- Bot recovers gracefully

### Test 3: Restart with unsaved session

**Steps:**

1. Have an active Claude session
2. Send `/restart`

**Expected:**

- Session is flushed before restart
- After restart, can use `/resume` to continue

---

## Troubleshooting

### Bot doesn't restart

**Symptoms:**

- Message stuck at "🔄 Restarting bot..."
- Bot not responsive

**Check:**

1. Verify spawn command syntax:
   ```bash
   # Should see something like:
   sleep 1 && cd "/path" && bun run "src/index.ts" >> /tmp/claude-telegram-bot.log 2>&1 &
   ```
2. Check logs:
   ```bash
   tail -f /tmp/claude-telegram-bot.log
   ```
3. Look for errors in stderr:
   ```bash
   tail -f /tmp/claude-telegram-bot.err
   ```

### Can't find logs

**Symptoms:**

- `tail -f /tmp/claude-telegram-bot.log` shows nothing

**Solutions:**

1. Check if log file exists:
   ```bash
   ls -la /tmp/claude-telegram-bot.log
   ```
2. Verify bot is writing to the correct location (check restart message)
3. Try full path in tail command

### Terminal session ends but bot doesn't start

**Symptoms:**

- Original terminal exits
- Bot not responsive
- No new process in `ps aux`

**Check:**

1. Verify PATH includes `bun`:
   ```bash
   which bun
   ```
2. Check for syntax errors in spawn command
3. Verify working directory is accessible
4. Check file permissions

---

## Test Coverage

Current test coverage for `/restart`:

```
✅ Startup mode detection (binary/CLI/dev)
✅ TTY detection
✅ Restart command generation
✅ Warning message formatting
✅ Success message formatting
✅ Log file path handling
```

Not yet tested (requires integration tests):

- ⏳ Actual process restart
- ⏳ Message update after restart
- ⏳ Session preservation
- ⏳ File descriptor cleanup
