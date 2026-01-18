/**
 * Test setup - sets required environment variables for tests.
 */

// Set dummy values for required environment variables
process.env.TELEGRAM_BOT_TOKEN = "test-token-12345";
process.env.TELEGRAM_ALLOWED_USERS = "123,456,789";
process.env.CLAUDE_WORKING_DIR = "/tmp";
