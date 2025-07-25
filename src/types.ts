// types.ts (additions to your existing types)

export interface WSMessage {
  type: 'send_message' | 'edit_message' | 'delete_message' | 'typing_start' | 'typing_stop' | 'reaction_add' | 'reaction_remove';
  content?: string;
  messageId?: string;
  threadId?: string;
  replyTo?: string;
  attachments?: any[];
  reaction?: string;
}

export interface WSResponse {
  type: 'new_message' | 'message_edited' | 'message_deleted' | 'typing_start' | 'typing_stop' | 
        'user_joined' | 'user_left' | 'user_list' | 'reaction_added' | 'reaction_removed' | 'error';
  message?: Message;
  messageId?: string;
  userId?: string;
  user?: ChannelMember;
  users?: ChannelMember[];
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
  user: {
    username: string;
    avatar: string | null;
  };
}

export interface ChannelMember {
  id: string;
  username: string;
  avatar: string | null;
  status: 'online' | 'offline' | 'away';
}