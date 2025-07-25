// durable-objects/ChatRoom.ts
import { Message, ChannelMember, WSMessage } from '../types';
import { DurableObject } from "cloudflare:workers";

export interface Env {
  CHAT_ROOMS: DurableObjectNamespace;
  CHANNEL_CACHE: KVNamespace;
  ATTACHMENTS: R2Bucket;
  BACKEND_URL: string;
  MAX_MESSAGE_LENGTH: string;
  MAX_FILE_SIZE: string;
  DB: D1Database;
}

export class ChatRoom extends DurableObject<Env> {
  private sessions: Map<string, WebSocket> = new Map();
  private members: Map<string, ChannelMember> = new Map();
  private messages: Message[] = [];
  private typingUsers: Set<string> = new Set();
  private channelId: string = '';
  private typingTimeouts: Map<string, number> = new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      const storedMessages = await ctx.storage.get<Message[]>('messages');
      const storedChannelId = await ctx.storage.get<string>('channelId');

      if (storedChannelId) this.channelId = storedChannelId;

      if (storedMessages?.length) {
        this.messages = storedMessages;
      } else if (this.channelId) {
        const { results } = await env.DB.prepare(
          `SELECT * FROM messages WHERE channelId = ? ORDER BY timestamp DESC LIMIT 50`
        ).bind(this.channelId).all();

        const enriched = await Promise.all((results.reverse() as Record<string, unknown>[]).map(async (r) => {
          const userInfo = await this.getUserInfo(String(r.userId));
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
            user: userInfo
          };
        }));

        this.messages = enriched;
        await ctx.storage.put('messages', this.messages);
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
    return new Response('Not found', { status: 404 });
  }

  private async getUserInfo(userId: string): Promise<{ username: string; avatar: string | null }> {
    try {
      const cached = this.members.get(userId);
      if (cached) return { username: cached.username, avatar: cached.avatar || null };

      const res = await fetch(`${this.env.BACKEND_URL}/api/hub/chat/users/${userId}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const userInfo = await res.json() as { username: string; avatar: string | null };
      
      // Cache the user info
      this.members.set(userId, {
        id: userId,
        username: userInfo.username,
        avatar: userInfo.avatar,
        status: 'online'
      });
      
      return userInfo;
    } catch {
      return { username: 'Unknown', avatar: null };
    }
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    const userId = url.searchParams.get('userId');

    if (!token || !userId || !(await this.verifyToken(token, userId))) {
      return new Response('Unauthorized', { status: 401 });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    server.accept();
    this.handleSession(server, userId);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async verifyToken(token: string, userId: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.env.BACKEND_URL}/api/hub/chat/auth/verify-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, userId }),
      });
      if (!res.ok) return false;
      const result = await res.json() as { valid: boolean };
      return result.valid;
    } catch {
      return false;
    }
  }

  async getMessages(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const before = url.searchParams.get('before');

    let query = `SELECT * FROM messages WHERE channelId = ?`;
    const params: any[] = [this.channelId];

    if (before) {
      query += ` AND timestamp < ?`;
      params.push(before);
    }

    query += ` ORDER BY timestamp DESC LIMIT ?`;
    params.push(limit);

    const { results } = await this.env.DB.prepare(query).bind(...params).all();

    const messages: Message[] = await Promise.all((results.reverse() as Record<string, unknown>[]).map(async (r) => {
      const userInfo = await this.getUserInfo(String(r.userId));
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
        user: userInfo
      };
    }));

    return new Response(JSON.stringify({ messages }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async setChannelId(channelId: string): Promise<void> {
    this.channelId = channelId;
    await this.ctx.storage.put('channelId', channelId);
  }

  private handleSession(webSocket: WebSocket, userId: string) {
    this.sessions.set(userId, webSocket);

    // Send current online users to the new user
    this.sendToUser(userId, {
      type: 'user_list',
      users: Array.from(this.members.values()).filter(member => this.sessions.has(member.id))
    });

    // Notify other users about new user joining
    this.broadcast({
      type: 'user_joined',
      user: this.members.get(userId) || { id: userId, username: 'Unknown', avatar: null, status: 'online' }
    }, userId);

    webSocket.addEventListener('message', async (event) => {
      try {
        const messageData = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
        const message = JSON.parse(messageData) as WSMessage;
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
      this.handleDisconnect(userId);
    });

    webSocket.addEventListener('error', (error) => {
      console.error('WebSocket error:', error);
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
      default:
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
    const userInfo = await this.getUserInfo(userId);

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
      user: userInfo
    };

    // Save to database
    try {
      await this.env.DB.prepare(
        `INSERT INTO messages (id, channelId, userId, content, timestamp, threadId, replyTo) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        messageId,
        this.channelId,
        userId,
        content,
        timestamp,
        message.threadId || null,
        message.replyTo || null
      ).run();

      // Add to in-memory cache
      this.messages.push(newMessage);
      if (this.messages.length > 100) {
        this.messages = this.messages.slice(-100);
      }

      // Update storage
      await this.ctx.storage.put('messages', this.messages);

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
        `UPDATE messages SET content = ?, edited = true, editedAt = ? WHERE id = ?`
      ).bind(newContent, editedAt, messageId).run();

      // Update cache
      this.messages[messageIndex].content = newContent;
      this.messages[messageIndex].edited = true;
      this.messages[messageIndex].editedAt = editedAt;

      await this.ctx.storage.put('messages', this.messages);

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
      // Update database
      await this.env.DB.prepare(
        `UPDATE messages SET deleted = true WHERE id = ?`
      ).bind(messageId).run();

      // Update cache
      this.messages[messageIndex].deleted = true;
      await this.ctx.storage.put('messages', this.messages);

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
    }, 5000) as unknown as number;
    
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
      await this.ctx.storage.put('messages', this.messages);

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
      await this.ctx.storage.put('messages', this.messages);

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
    
    this.sessions.forEach((ws, userId) => {
      if (userId !== excludeUserId && ws.readyState === WebSocket.READY_STATE_OPEN) {
        try {
          ws.send(messageStr);
        } catch (error) {
          console.error('Error sending message to user:', userId, error);
          // Clean up broken connection
          this.sessions.delete(userId);
        }
      }
    });
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