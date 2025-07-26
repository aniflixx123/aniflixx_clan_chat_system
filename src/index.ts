// src/index.ts
import { ChatRoom } from './durable-objects/ChatRoom';

// Export the Durable Object class
export { ChatRoom };

export interface Env {
  CHAT_ROOMS: DurableObjectNamespace;
  CHANNEL_CACHE: KVNamespace;
  ATTACHMENTS: R2Bucket;
  MAX_MESSAGE_LENGTH: string;
  MAX_FILE_SIZE: string;
  DB: D1Database;
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Id, X-Channel-Id',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Route: /api/channels/:channelId/websocket
      const channelMatch = url.pathname.match(/^\/api\/channels\/([^\/]+)\/(websocket|messages)$/);
      if (channelMatch) {
        const channelId = channelMatch[1];
        const endpoint = channelMatch[2];
        
        console.log(`📨 Request for channel: ${channelId}, endpoint: ${endpoint}`);
        
        // Get or create chat room
        const roomId = env.CHAT_ROOMS.idFromName(channelId);
        const room = env.CHAT_ROOMS.get(roomId);
        
        // Store channel ID
        await room.fetch(new Request('http://internal/set-channel-id', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelId }),
        }));
        
        // For WebSocket requests, we need to forward ALL the original request details
        if (endpoint === 'websocket') {
          // Build the internal URL with query params
          const internalUrl = new URL('http://internal/websocket');
          
          // Copy all query params (token, userId, username, profileImage, etc.)
          url.searchParams.forEach((value, key) => {
            internalUrl.searchParams.set(key, value);
          });
          
          console.log('🔄 Forwarding WebSocket request to Durable Object');
          
          // Forward the request with all headers and query params
          const response = await room.fetch(new Request(internalUrl.toString(), {
            method: request.method,
            headers: request.headers,
          }));
          
          // Don't modify WebSocket responses
          if (response.status === 101) {
            return response;
          }
          
          // For non-WebSocket responses, add CORS headers
          const newHeaders = new Headers(response.headers);
          Object.entries(corsHeaders).forEach(([key, value]) => {
            newHeaders.set(key, value);
          });
          
          return new Response(response.body, {
            status: response.status,
            headers: newHeaders,
          });
        } else {
          // For non-WebSocket requests, handle normally
          const response = await room.fetch(new Request(`http://internal/${endpoint}${url.search}`, request));
          
          const newHeaders = new Headers(response.headers);
          Object.entries(corsHeaders).forEach(([key, value]) => {
            newHeaders.set(key, value);
          });
          
          return new Response(response.body, {
            status: response.status,
            headers: newHeaders,
          });
        }
      }

      // Route: /api/attachments/upload
      if (url.pathname === '/api/attachments/upload' && request.method === 'POST') {
        return this.handleFileUpload(request, env, corsHeaders);
      }

      // Route: /api/attachments/:fileId
      if (url.pathname.startsWith('/api/attachments/') && request.method === 'GET') {
        const fileId = url.pathname.split('/').pop();
        return this.handleFileDownload(fileId!, env, corsHeaders);
      }

      return new Response('Not found', { status: 404, headers: corsHeaders });
    } catch (error) {
      console.error('Worker error:', error);
      return new Response('Internal server error', { 
        status: 500, 
        headers: corsHeaders 
      });
    }
  },

  async handleFileUpload(request: Request, env: Env, corsHeaders: any): Promise<Response> {
    try {
      const formData = await request.formData();
      const file = formData.get('file');
      const channelId = formData.get('channelId');
      const userId = request.headers.get('X-User-Id');

      // Check if file is a File object
      if (!file || typeof file === 'string') {
        return new Response('No file provided', { 
          status: 400, 
          headers: corsHeaders 
        });
      }

      if (!channelId || typeof channelId !== 'string' || !userId) {
        return new Response('Missing required fields', { 
          status: 400, 
          headers: corsHeaders 
        });
      }

      // Now TypeScript knows file is a File object
      const fileObj = file as File;

      // Check file size
      if (fileObj.size > parseInt(env.MAX_FILE_SIZE)) {
        return new Response('File too large', { 
          status: 413, 
          headers: corsHeaders 
        });
      }

      // Generate unique key
      const fileId = crypto.randomUUID();
      const extension = fileObj.name.split('.').pop();
      const key = `attachments/${channelId}/${fileId}.${extension}`;

      // Upload to R2
      await env.ATTACHMENTS.put(key, fileObj.stream(), {
        httpMetadata: {
          contentType: fileObj.type,
        },
        customMetadata: {
          uploadedBy: userId,
          originalName: fileObj.name,
          channelId: channelId,
        },
      });

      const attachment = {
        id: fileId,
        filename: fileObj.name,
        size: fileObj.size,
        contentType: fileObj.type,
        url: `/api/attachments/${fileId}`,
      };

      return new Response(JSON.stringify(attachment), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Upload error:', error);
      return new Response('Upload failed', { 
        status: 500, 
        headers: corsHeaders 
      });
    }
  },

  async handleFileDownload(fileId: string, env: Env, corsHeaders: any): Promise<Response> {
    try {
      // Find file in R2
      const list = await env.ATTACHMENTS.list({ prefix: `attachments/` });
      const file = list.objects.find(obj => obj.key.includes(fileId));

      if (!file) {
        return new Response('File not found', { 
          status: 404, 
          headers: corsHeaders 
        });
      }

      const object = await env.ATTACHMENTS.get(file.key);
      if (!object) {
        return new Response('File not found', { 
          status: 404, 
          headers: corsHeaders 
        });
      }

      const headers = new Headers(corsHeaders);
      headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
      headers.set('Content-Length', object.size.toString());
      
      if (object.customMetadata?.originalName) {
        headers.set('Content-Disposition', `inline; filename="${object.customMetadata.originalName}"`);
      }

      return new Response(object.body, { headers });
    } catch (error) {
      console.error('Download error:', error);
      return new Response('Download failed', { 
        status: 500, 
        headers: corsHeaders 
      });
    }
  },
};

export default worker;