-- migrations/001_create_messages_table.sql
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channelId TEXT NOT NULL,
  userId TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  replyTo TEXT,
  threadId TEXT,
  edited INTEGER DEFAULT 0,
  editedAt TEXT,
  deleted INTEGER DEFAULT 0,
  username TEXT,
  profileImage TEXT
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_channel_timestamp ON messages(channelId, timestamp);
CREATE INDEX IF NOT EXISTS idx_user_messages ON messages(userId, timestamp);
CREATE INDEX IF NOT EXISTS idx_thread_messages ON messages(threadId) WHERE threadId IS NOT NULL;

-- Create a users table to store user info
CREATE TABLE IF NOT EXISTS users (
  userId TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  profileImage TEXT,
  lastSeen TEXT
);