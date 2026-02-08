# Auto File Send Feature

## Overview

The Auto File Send feature automatically detects when users request to view or download files and sends them without requiring manual `/file` command invocation.

## How It Works

1. **Detection**: When you send a text message, the bot checks if it matches file request patterns
2. **Extraction**: If detected, it extracts file paths from Claude's last response
3. **Sending**: Automatically sends all detected files to you

## Supported Patterns

### Chinese

- 把檔案給我看
- 把這個檔案給我
- 檔案給我看下
- 給我那個檔案
- 傳檔案給我
- 下載檔案
- 看檔案
- 檔案看一下

### English

- send me the file(s)
- show me the file(s)
- give me the file(s)
- download the file(s)
- get the file(s)
- can i see the file(s)
- let me see the file(s)
- i want/need the file(s)
- file(s) please/pls

## Example Usage

### Scenario 1: Basic Usage

```
You: Create a hello world script in Python
Claude: I've created hello.py with the following content...
You: 把檔案給我看
Bot: ✅ Sent 1 file automatically based on your request.
[Receives hello.py]
```

### Scenario 2: Multiple Files

```
You: Generate a web page with CSS
Claude: I've created index.html and styles.css...
You: send me the files
Bot: ✅ Sent 2 files automatically based on your request.
[Receives index.html and styles.css]
```

### Scenario 3: Fallback to Manual

```
You: show me config.json
Bot: 📎 I understand you want to see files, but I couldn't find any file paths in my last response.

Usage: /file <filepath>
```

## Implementation Details

### File Path Detection

The feature uses `detectFilePaths()` from `src/formatting.ts` to extract file paths from:

- Paths in `<code>` tags (HTML formatted responses)
- Paths in backticks
- Paths after common prefixes (file:, saved:, created:, etc.)
- Standalone absolute paths

### Deduplication

File paths are automatically deduplicated, so if Claude mentions the same file multiple times, it's only sent once.

### Size Limits

- **Text files < 4KB**: Displayed inline with syntax highlighting
- **Files < 50MB**: Sent as document download
- **Files > 50MB**: Error message (Telegram bot limit)

### Security

All file operations respect:

- `ALLOWED_PATHS` configuration
- Path validation (no traversal attacks)
- Existence checks
- Permission checks

## Code Structure

### Key Files

- **`src/formatting.ts`**:
  - `detectFileRequest()` - Detects if message is a file request
  - `detectFilePaths()` - Extracts file paths from text

- **`src/handlers/file-sender.ts`**:
  - `handleAutoFileSend()` - Main auto-detection handler
  - `sendFile()` - Shared file sending utility

- **`src/handlers/text.ts`**:
  - Integrates auto file send before normal message processing

### Flow Diagram

```
Text Message
    ↓
detectFileRequest()
    ↓ (yes)
Extract file paths from lastBotResponse
    ↓
detectFilePaths()
    ↓
Deduplicate paths
    ↓
For each path:
    sendFile()
        ↓
    Path validation
        ↓
    Size check
        ↓
    Send inline or as document
```

## Testing

Run the test suite:

```bash
bun test src/__tests__/file-request-detection.test.ts
```

Tests cover:

- Chinese pattern matching
- English pattern matching
- Case insensitivity
- Negative cases (false positives)
- Edge cases

## Configuration

No additional configuration needed. The feature works out of the box.

To disable, you could modify `src/handlers/text.ts` to skip the `handleAutoFileSend()` call.

## Tips

1. **Be specific**: Say "send me the file" after Claude mentions creating/modifying files
2. **Use /file manually**: For files not in the last response, use `/file <path>`
3. **Check last response**: The feature only works with the most recent Claude response
4. **Multiple chats**: Each chat has its own session and last response

## Limitations

1. Only detects files from the **last bot response**
2. Requires file paths to be in a detectable format (in code blocks, backticks, or after common prefixes)
3. Cannot retrieve files from conversation history beyond the last response
4. Subject to Telegram's 50MB file size limit

## Future Enhancements

Potential improvements:

- Support for file ranges ("send me files 1-3")
- File preview thumbnails
- Compression for large files
- Archive creation for multiple files
