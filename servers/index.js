#!/usr/bin/env node
/**
 * WaliChat Extended MCP Server
 * Fills the gaps in the native WaliChat MCP:
 *  - Read full conversation history (inbound + outbound)
 *  - Create private notes on chat profiles
 *  - Get / search / update contacts
 *  - Change chat status (resolved, active, pending)
 *  - Mark chat as unread
 *  - Update chat labels
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_KEY    = process.env.WALICHAT_API_KEY;
const DEFAULT_DEVICE = process.env.WALICHAT_DEVICE_ID || '';
const BASE_URL   = 'https://api.wali.chat';

if (!API_KEY) {
  process.stderr.write('[walichat-extended] ERROR: WALICHAT_API_KEY env var is required\n');
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toWid(chat) {
  if (!chat) return chat;
  if (chat.includes('@')) return chat;
  // Strip leading + if present
  const digits = chat.replace(/^\+/, '').replace(/\D/g, '');
  return `${digits}@c.us`;
}

async function wali(method, path, body = null) {
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== null) options.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, options);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, status: res.status };
  }
}

function ok(data) {
  return {
    content: [{
      type: 'text',
      text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    }],
  };
}

function formatMessages(messages) {
  if (!Array.isArray(messages)) return ok(messages);
  const lines = messages.map(m => {
    const dir  = m.flow === 'inbound' ? '←' : '→';
    const time = m.date ? m.date.slice(0, 16).replace('T', ' ') : '';
    const from = m.flow === 'inbound'
      ? (m.meta?.notifyName || m.fromNumber || m.from || '')
      : 'Tú';
    const body = m.body || m.caption || '[media]';
    const note = m.scope === 'note' ? ' [NOTA]' : '';
    return `${time}  ${dir} ${from}${note}: ${body}`;
  });
  return ok(lines.join('\n'));
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'walichat-extended',
  version: '1.0.0',
});

// ── 1. Read conversation ───────────────────────────────────────────────────────
server.tool(
  'read_conversation',
  {
    chat:   z.string().describe('Chat ID (e.g. 584126964574@c.us) o número de teléfono'),
    device: z.string().optional().describe('Device ID de WaliChat (usa el default si se omite)'),
    limit:  z.number().int().min(1).max(100).optional().default(30)
              .describe('Cantidad de mensajes a traer (default 30)'),
    flow:   z.enum(['all', 'inbound', 'outbound']).optional().default('all')
              .describe('Filtrar por dirección: all | inbound | outbound'),
  },
  async ({ chat, device, limit, flow }) => {
    const dev = device || DEFAULT_DEVICE;
    const wid = toWid(chat);
    const enc = encodeURIComponent(wid);
    let url = `/v1/chat/${dev}/messages?chat=${enc}&limit=${limit ?? 30}`;
    if (flow && flow !== 'all') url += `&flow=${flow}`;
    const data = await wali('GET', url);
    return formatMessages(data);
  }
);

// ── 2. Create private note ─────────────────────────────────────────────────────
server.tool(
  'create_chat_note',
  {
    chat:    z.string().describe('Chat ID o número de teléfono del contacto'),
    message: z.string().min(1).describe('Contenido de la nota privada'),
    device:  z.string().optional(),
  },
  async ({ chat, message, device }) => {
    const dev = device || DEFAULT_DEVICE;
    const wid = toWid(chat);
    const enc = encodeURIComponent(wid);
    const data = await wali('POST', `/v1/chat/${dev}/chats/${enc}/notes`, { message });
    if (data.id) {
      return ok(`✅ Nota creada (ID: ${data.id}) en el chat de ${wid}`);
    }
    return ok(data);
  }
);

// ── 3. Get contact ─────────────────────────────────────────────────────────────
server.tool(
  'get_contact',
  {
    chat:   z.string().describe('Chat ID o número de teléfono del contacto'),
    device: z.string().optional(),
  },
  async ({ chat, device }) => {
    const dev = device || DEFAULT_DEVICE;
    const wid = toWid(chat);
    const enc = encodeURIComponent(wid);
    const data = await wali('GET', `/v1/chat/${dev}/contacts/${enc}`);
    return ok(data);
  }
);

// ── 4. Search contacts ─────────────────────────────────────────────────────────
server.tool(
  'search_contacts',
  {
    query:  z.string().describe('Nombre, número o texto para buscar en los contactos'),
    device: z.string().optional(),
    limit:  z.number().int().min(1).max(50).optional().default(10),
  },
  async ({ query, device, limit }) => {
    const dev = device || DEFAULT_DEVICE;
    const q = encodeURIComponent(query);
    const data = await wali('GET', `/v1/chat/${dev}/contacts?query=${q}&limit=${limit ?? 10}`);
    if (Array.isArray(data)) {
      const lines = data.map(c =>
        `${c.displayName || c.name || '?'} | ${c.phone || c.wid}`
      );
      return ok(`${data.length} contacto(s) encontrado(s):\n` + lines.join('\n'));
    }
    return ok(data);
  }
);

// ── 5. Update contact ──────────────────────────────────────────────────────────
server.tool(
  'update_contact',
  {
    chat:      z.string().describe('Chat ID o número de teléfono del contacto'),
    name:      z.string().optional().describe('Nuevo nombre para el contacto'),
    shortName: z.string().optional().describe('Nombre corto'),
    metadata:  z.record(z.string()).optional().describe('Campos de metadata custom (key-value)'),
    device:    z.string().optional(),
  },
  async ({ chat, name, shortName, metadata, device }) => {
    const dev = device || DEFAULT_DEVICE;
    const wid = toWid(chat);
    const enc = encodeURIComponent(wid);
    const body = {};
    if (name)      body.name = name;
    if (shortName) body.shortName = shortName;
    if (metadata)  body.metadata = metadata;
    const data = await wali('PATCH', `/v1/chat/${dev}/contacts/${enc}`, body);
    return ok(data);
  }
);

// ── 6. Update chat status ──────────────────────────────────────────────────────
server.tool(
  'update_chat_status',
  {
    chat:   z.string().describe('Chat ID o número de teléfono'),
    status: z.enum(['active', 'resolved', 'pending'])
              .describe('Nuevo estado del chat: active | resolved | pending'),
    device: z.string().optional(),
  },
  async ({ chat, status, device }) => {
    const dev = device || DEFAULT_DEVICE;
    const wid = toWid(chat);
    const enc = encodeURIComponent(wid);
    const data = await wali('PATCH', `/v1/chat/${dev}/chats/${enc}/status`, { status });
    if (data.status) {
      return ok(`✅ Chat ${wid} ahora está en estado: ${data.status}`);
    }
    return ok(data);
  }
);

// ── 7. Mark chat as unread ─────────────────────────────────────────────────────
server.tool(
  'mark_chat_unread',
  {
    chat:   z.string().describe('Chat ID o número de teléfono'),
    device: z.string().optional(),
  },
  async ({ chat, device }) => {
    const dev = device || DEFAULT_DEVICE;
    const wid = toWid(chat);
    const enc = encodeURIComponent(wid);
    const data = await wali('PATCH', `/v1/chat/${dev}/chats/${enc}/unread`);
    return ok(data.id ? `✅ Chat ${wid} marcado como no leído` : data);
  }
);

// ── 8. Update chat labels ──────────────────────────────────────────────────────
server.tool(
  'update_chat_labels',
  {
    chat:   z.string().describe('Chat ID o número de teléfono'),
    labels: z.array(z.string()).describe('Array de nombres de etiquetas a aplicar'),
    device: z.string().optional(),
  },
  async ({ chat, labels, device }) => {
    const dev = device || DEFAULT_DEVICE;
    const wid = toWid(chat);
    const enc = encodeURIComponent(wid);
    const data = await wali('PATCH', `/v1/chat/${dev}/chats/${enc}/labels`, labels);
    return ok(data);
  }
);

// ── 9. Get chat details ────────────────────────────────────────────────────────
server.tool(
  'get_chat_details',
  {
    chat:   z.string().describe('Chat ID o número de teléfono'),
    device: z.string().optional(),
  },
  async ({ chat, device }) => {
    const dev = device || DEFAULT_DEVICE;
    const wid = toWid(chat);
    const enc = encodeURIComponent(wid);
    const data = await wali('GET', `/v1/chat/${dev}/chats/${enc}`);
    return ok(data);
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[walichat-extended] MCP server running\n');
