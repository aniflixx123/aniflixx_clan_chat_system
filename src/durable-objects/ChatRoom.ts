// src/durable-objects/ChatRoom.ts
import { Message, ChannelMember, WSMessage } from '../types';

export interface Env {
  CHAT_ROOMS: DurableObjectNamespace;
  CHANNEL_CACHE: KVNamespace;
  ATTACHMENTS: R2Bucket;
  MAX_MESSAGE_LENGTH: string;
  MAX_FILE_SIZE: string;
  DB: D1Database;
}

export class ChatRoom {
  private state: DurableObjectState;
  private env: Env;
  private sessions: Map<string, WebSocket> = new Map();
  private members: Map<string, ChannelMember> = new Map();
  private messages: Message[] = [];
  private typingUsers: Set<string> = new Set();
  private channelId: string = '';
  private typingTimeouts: Map<string, number> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    state.blockConcurrencyWhile(async () => {
      const storedMessages = await state.storage.get<Message[]>('messages');
      const storedChannelId = await state.storage.get<string>('channelId');
      const storedMembers = await state.storage.get<Map<string, ChannelMember>>('members');

      if (storedChannelId) this.channelId = storedChannelId;
      if (storedMembers) this.members = new Map(storedMembers);

      if (storedMessages?.length) {
        this.messages = storedMessages;
      } else if (this.channelId) {
        // Load from D1 database
        try {
          const { results } = await env.DB.prepare(
            `SELECT * FROM messages WHERE channelId = ? AND deleted = 0 ORDER BY timestamp DESC LIMIT 50`
          ).bind(this.channelId).all();

          this.messages = (results.reverse() as Record<string, unknown>[]).map((r) => ({
            id: String(r.id),
            channelId: String(r.channelId),
            userId: String(r.userId),
            content: String(r.content),
            timestamp: String(r.timestamp),
            edited: !!r.edited,
            editedAt: r.editedAt ? String(r.editedAt) : undefined,
            deleted: false,
            threadId: r.threadId ? String(r.threadId) : undefined,
            replyTo: r.replyTo ? String(r.replyTo) : undefined,
            attachments: [],
            reactions: {},
            user: {
              uid: String(r.userId),
              username: String(r.username || 'User'),
              profileImage: String(r.profileImage || '')
            },
            mentions: []
          }));

          await state.storage.put('messages', this.messages);
        } catch (error) {
          console.error('Error loading messages from D1:', error);
          this.messages = [];
        }
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/websocket') return this.handleWebSocket(request);
    if (url.pathname === '/messages') return this.getMessages(request);
    if (url.pathname === '/set-channel-id') {
      const body = await request.json() as { channelId: string };
      await this.setChannelId(body.channelId);
      return new Response('OK');
    }
    if (url.pathname === '/debug') {
      return new Response(JSON.stringify({
        channelId: this.channelId,
        messagesInMemory: this.messages.length,
        connectedUsers: this.sessions.size,
        members: Array.from(this.members.keys())
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Not found', { status: 404 });
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    const userId = url.searchParams.get('userId');
    const username = url.searchParams.get('username') || 'User';
    const profileImage = url.searchParams.get('profileImage') || '';

    console.log('🔐 WebSocket connection attempt:', { userId, username });

    if (!userId) {
      console.error('❌ Missing userId');
      return new Response('Unauthorized', { status: 401 });
    }

    // Store user info
    if (!this.members.has(userId)) {
      this.members.set(userId, {
        id: userId,
        username: decodeURIComponent(username),
        avatar: decodeURIComponent(profileImage),
        status: 'online'
      });
      await this.state.storage.put('members', Array.from(this.members.entries()));
    }

    console.log('✅ User authenticated, creating WebSocket');

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    server.accept();
    this.handleSession(server, userId);
    return new Response(null, { status: 101, webSocket: client });
  }

  async getMessages(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const before = url.searchParams.get('before');

    // First try to get from D1, then fall back to simpler query
    let query = `SELECT * FROM messages WHERE channelId = ? AND deleted = 0`;
    const params: any[] = [this.channelId];

    if (before) {
      query += ` AND timestamp < ?`;
      params.push(before);
    }

    query += ` ORDER BY timestamp DESC LIMIT ?`;
    params.push(limit);

    try {
      const { results } = await this.env.DB.prepare(query).bind(...params).all();

      const messages: Message[] = (results.reverse() as Record<string, unknown>[]).map((r) => {
        const member = this.members.get(String(r.userId));
        return {
          id: String(r.id),
          channelId: String(r.channelId),
          userId: String(r.userId),
          content: String(r.content),
          timestamp: String(r.timestamp),
          edited: !!r.edited,
          editedAt: r.editedAt ? String(r.editedAt) : undefined,
          deleted: !!r.deleted,
          threadId: r.threadId ? String(r.threadId) : undefined,
          replyTo: r.replyTo ? String(r.replyTo) : undefined,
          attachments: [],
          reactions: {},
          user: {
            uid: String(r.userId),
            username: String(r.username || member?.username || 'User'),
            profileImage: String(r.profileImage || member?.avatar || '')
          },
          mentions: []
        };
      });

      return new Response(JSON.stringify({ messages }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Error fetching messages:', error);
      // Return empty messages array on error
      return new Response(JSON.stringify({ messages: [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  async setChannelId(channelId: string): Promise<void> {
    this.channelId = channelId;
    await this.state.storage.put('channelId', channelId);
  }

  private handleSession(webSocket: WebSocket, userId: string) {
    console.log('👤 New session for user:', userId);
    this.sessions.set(userId, webSocket);

    const member = this.members.get(userId);
    
    // Set up ping interval for this connection
    const pingInterval = setInterval(() => {
      if (webSocket.readyState === WebSocket.READY_STATE_OPEN) {
        try {
          webSocket.send(JSON.stringify({ type: 'ping' }));
        } catch (error) {
          console.error('Failed to send ping to', userId);
          clearInterval(pingInterval);
        }
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);

    // Send initial messages to the new user
    this.sendToUser(userId, {
      type: 'init',
      messages: this.messages
    });

    // Send current online users
    const onlineUsers = Array.from(this.sessions.keys()).map(uid => {
      const m = this.members.get(uid);
      return {
        uid,
        username: m?.username || 'User',
        profileImage: m?.avatar || ''
      };
    });
    
    this.sendToUser(userId, {
      type: 'user_list',
      users: onlineUsers
    });

    // Notify other users about new user joining
    this.broadcast({
      type: 'user_joined',
      user: {
        uid: userId,
        username: member?.username || 'User',
        profileImage: member?.avatar || ''
      }
    }, userId);

    webSocket.addEventListener('message', async (event) => {
      try {
        const messageData = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
        const message = JSON.parse(messageData) as WSMessage;
        console.log('📨 Received message:', message.type, 'from:', userId);
        await this.handleMessage(message, userId);
      } catch (error) {
        console.error('Error handling message:', error);
        this.sendToUser(userId, {
          type: 'error',
          message: 'Invalid message format'
        });
      }
    });

    webSocket.addEventListener('close', () => {
      console.log('👋 User disconnected:', userId);
      clearInterval(pingInterval);
      this.handleDisconnect(userId);
    });

    webSocket.addEventListener('error', (error) => {
      console.error('WebSocket error:', error);
      clearInterval(pingInterval);
      this.handleDisconnect(userId);
    });
  }

  private async handleMessage(message: WSMessage, userId: string): Promise<void> {
    switch (message.type) {
      case 'send_message':
        await this.handleSendMessage(message, userId);
        break;
      case 'edit_message':
        await this.handleEditMessage(message, userId);
        break;
      case 'delete_message':
        await this.handleDeleteMessage(message, userId);
        break;
      case 'typing_start':
        this.handleTypingStart(userId);
        break;
      case 'typing_stop':
        this.handleTypingStop(userId);
        break;
      case 'reaction_add':
        await this.handleReactionAdd(message, userId);
        break;
      case 'reaction_remove':
        await this.handleReactionRemove(message, userId);
        break;
      case 'ping':
        // Respond to heartbeat
        this.sendToUser(userId, { type: 'pong' });
        break;
      default:
        console.warn('Unknown message type:', message.type);
        this.sendToUser(userId, {
          type: 'error',
          message: 'Unknown message type'
        });
    }
  }

  private async handleSendMessage(message: WSMessage, userId: string): Promise<void> {
    const content = message.content?.trim();
    if (!content || content.length > parseInt(this.env.MAX_MESSAGE_LENGTH)) {
      this.sendToUser(userId, {
        type: 'error',
        message: 'Message content is invalid or too long'
      });
      return;
    }

    const messageId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const member = this.members.get(userId);

    const newMessage: Message = {
      id: messageId,
      channelId: this.channelId,
      userId,
      content,
      timestamp,
      edited: false,
      deleted: false,
      threadId: message.threadId,
      replyTo: message.replyTo,
      attachments: message.attachments || [],
      reactions: {},
      user: {
        uid: userId,
        username: member?.username || 'User',
        profileImage: member?.avatar || ''
      },
      mentions: message.mentions || []
    };

    // Save to database with user info
    try {
      await this.env.DB.prepare(
        `INSERT INTO messages (id, channelId, userId, content, timestamp, threadId, replyTo, username, profileImage) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        messageId,
        this.channelId,
        userId,
        content,
        timestamp,
        message.threadId || null,
        message.replyTo || null,
        member?.username || 'User',
        member?.avatar || ''
      ).run();

      // Add to in-memory cache
      this.messages.push(newMessage);
      if (this.messages.length > 100) {
        this.messages = this.messages.slice(-50);
      }

      // Update storage
      await this.state.storage.put('messages', this.messages);

      // Broadcast to all connected users
      this.broadcast({
        type: 'new_message',
        message: newMessage
      });

      // Stop typing indicator for the sender
      this.handleTypingStop(userId);
      
    } catch (error) {
      console.error('Error saving message:', error);
      this.sendToUser(userId, {
        type: 'error',
        message: 'Failed to send message'
      });
    }
  }

  private async handleEditMessage(message: WSMessage, userId: string): Promise<void> {
    const messageId = message.messageId;
    const newContent = message.content?.trim();
    
    if (!messageId || !newContent) {
      this.sendToUser(userId, {
        type: 'error',
        message: 'Invalid edit request'
      });
      return;
    }

    // Find message in cache
    const messageIndex = this.messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1 || this.messages[messageIndex].userId !== userId) {
      this.sendToUser(userId, {
        type: 'error',
        message: 'Message not found or unauthorized'
      });
      return;
    }

    const editedAt = new Date().toISOString();

    try {
      // Update database
      await this.env.DB.prepare(
        `UPDATE messages SET content = ?, edited = 1, editedAt = ? WHERE id = ? AND userId = ?`
      ).bind(newContent, editedAt, messageId, userId).run();

      // Update cache
      this.messages[messageIndex].content = newContent;
      this.messages[messageIndex].edited = true;
      this.messages[messageIndex].editedAt = editedAt;

      await this.state.storage.put('messages', this.messages);

      // Broadcast edit
      this.broadcast({
        type: 'message_edited',
        message: this.messages[messageIndex]
      });

    } catch (error) {
      console.error('Error editing message:', error);
      this.sendToUser(userId, {
        type: 'error',
        message: 'Failed to edit message'
      });
    }
  }

  private async handleDeleteMessage(message: WSMessage, userId: string): Promise<void> {
    const messageId = message.messageId;
    
    if (!messageId) {
      this.sendToUser(userId, {
        type: 'error',
        message: 'Invalid delete request'
      });
      return;
    }

    const messageIndex = this.messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1 || this.messages[messageIndex].userId !== userId) {
      this.sendToUser(userId, {
        type: 'error',
        message: 'Message not found or unauthorized'
      });
      return;
    }

    try {
      // Update database - soft delete
      await this.env.DB.prepare(
        `UPDATE messages SET deleted = 1 WHERE id = ? AND userId = ?`
      ).bind(messageId, userId).run();

      // Remove from cache
      this.messages.splice(messageIndex, 1);
      await this.state.storage.put('messages', this.messages);

      // Broadcast deletion
      this.broadcast({
        type: 'message_deleted',
        messageId
      });

    } catch (error) {
      console.error('Error deleting message:', error);
      this.sendToUser(userId, {
        type: 'error',
        message: 'Failed to delete message'
      });
    }
  }

  private handleTypingStart(userId: string): void {
    if (this.typingUsers.has(userId)) return;

    this.typingUsers.add(userId);
    
    // Clear existing timeout
    const existingTimeout = this.typingTimeouts.get(userId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Set new timeout
    const timeout = setTimeout(() => {
      this.handleTypingStop(userId);
    }, 3000) as unknown as number;
    
    this.typingTimeouts.set(userId, timeout);

    // Broadcast typing indicator
    this.broadcast({
      type: 'typing_start',
      userId
    }, userId);
  }

  private handleTypingStop(userId: string): void {
    if (!this.typingUsers.has(userId)) return;

    this.typingUsers.delete(userId);
    
    // Clear timeout
    const timeout = this.typingTimeouts.get(userId);
    if (timeout) {
      clearTimeout(timeout);
      this.typingTimeouts.delete(userId);
    }

    // Broadcast typing stop
    this.broadcast({
      type: 'typing_stop',
      userId
    }, userId);
  }

  private async handleReactionAdd(message: WSMessage, userId: string): Promise<void> {
    const { messageId, reaction } = message;
    if (!messageId || !reaction) return;

    const messageIndex = this.messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1) return;

    const msg = this.messages[messageIndex];
    if (!msg.reactions[reaction]) {
      msg.reactions[reaction] = [];
    }

    if (!msg.reactions[reaction].includes(userId)) {
      msg.reactions[reaction].push(userId);
      await this.state.storage.put('messages', this.messages);

      this.broadcast({
        type: 'reaction_added',
        messageId,
        reaction,
        userId
      });
    }
  }

  private async handleReactionRemove(message: WSMessage, userId: string): Promise<void> {
    const { messageId, reaction } = message;
    if (!messageId || !reaction) return;

    const messageIndex = this.messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1) return;

    const msg = this.messages[messageIndex];
    if (msg.reactions[reaction]) {
      msg.reactions[reaction] = msg.reactions[reaction].filter(id => id !== userId);
      if (msg.reactions[reaction].length === 0) {
        delete msg.reactions[reaction];
      }
      await this.state.storage.put('messages', this.messages);

      this.broadcast({
        type: 'reaction_removed',
        messageId,
        reaction,
        userId
      });
    }
  }

  private handleDisconnect(userId: string): void {
    this.sessions.delete(userId);
    this.handleTypingStop(userId);

    // Notify other users
    this.broadcast({
      type: 'user_left',
      userId
    }, userId);
  }

  private broadcast(message: any, excludeUserId?: string): void {
    const messageStr = JSON.stringify(message);
    console.log(`📡 Broadcasting ${message.type} to ${this.sessions.size} users (excluding: ${excludeUserId})`);
    
    let successCount = 0;
    let failCount = 0;
    
    this.sessions.forEach((ws, userId) => {
      if (userId !== excludeUserId && ws.readyState === WebSocket.READY_STATE_OPEN) {
        try {
          ws.send(messageStr);
          successCount++;
        } catch (error) {
          console.error('Error sending message to user:', userId, error);
          failCount++;
          // Clean up broken connection
          this.sessions.delete(userId);
        }
      }
    });
    
    console.log(`✅ Broadcast complete: ${successCount} success, ${failCount} failed`);
  }

  private sendToUser(userId: string, message: any): void {
    const ws = this.sessions.get(userId);
    if (ws && ws.readyState === WebSocket.READY_STATE_OPEN) {
      try {
        ws.send(JSON.stringify(message));
      } catch (error) {
        console.error('Error sending message to user:', userId, error);
        this.sessions.delete(userId);
      }
    }
  }
}

export default ChatRoom;