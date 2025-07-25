-- 001_create_messages_table.sql
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channelId TEXT,
  userId TEXT,
  content TEXT,
  timestamp TEXT,
  replyTo TEXT,
  threadId TEXT,
  edited INTEGER DEFAULT 0,
  deleted INTEGER DEFAULT 0
);
