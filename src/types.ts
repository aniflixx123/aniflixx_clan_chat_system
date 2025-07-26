// src/types.ts
export interface WSMessage {
  type: 'send_message' | 'edit_message' | 'delete_message' | 'typing_start' | 'typing_stop' | 
        'reaction_add' | 'reaction_remove' | 'ping';
  content?: string;
  messageId?: string;
  threadId?: string;
  replyTo?: string;
  attachments?: any[];
  reaction?: string;
  mentions?: string[];
  localId?: string;
}

export interface WSResponse {
  type: 'init' | 'new_message' | 'message_edited' | 'message_deleted' | 'typing_start' | 'typing_stop' | 
        'user_joined' | 'user_left' | 'user_list' | 'reaction_added' | 'reaction_removed' | 'error' | 'pong';
  message?: Message;
  messages?: Message[];
  messageId?: string;
  userId?: string;
  user?: { uid: string };
  users?: Array<{ uid: string }>;
  reaction?: string;
  error?: string;
}

export interface Message {
  id: string;
  channelId: string;
  userId: string;
  content: string;
  timestamp: string;
  edited: boolean;
  editedAt?: string;
  deleted: boolean;
  threadId?: string;
  replyTo?: string;
  attachments: any[];
  reactions: Record<string, string[]>;
  mentions: string[];
  user: {
    uid: string;
    username: string;
    profileImage: string;
  };
}

export interface ChannelMember {
  id: string;
  username: string;
  avatar: string;
  status: 'online' | 'offline' | 'away';
}