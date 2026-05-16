#!/usr/bin/env node
/**
 * WaliChat Extended MCP Server v2
 * Consolidates the native WaliChat MCP + new inbox navigation tools + SQLite intel layer.
 *
 * Tools 1-9:   Original extended tools (read, notes, contacts, status, labels)
 * Tools 10-14: From native WaliChat MCP (send_message, send_media, get_device_status, list_labels, create_contact)
 * Tools 15-17: New inbox navigation (list_chats, list_pending_chats, get_inbox_summary)
 * Tools 18-22: SQLite contact intel (set/get/list contact intel, ignore_contact, list_ignored)
 *
 * Transport: set MCP_TRANSPORT=http to run as Streamable HTTP server (for MCPJungle).
 *            Default (stdio) is used by local MCP Router.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import http from 'node:http';

const API_KEY        = process.env.WALICHAT_API_KEY;
const DEFAULT_DEVICE = process.env.WALICHAT_DEVICE_ID || '';
const BASE_URL       = 'https://api.wali.chat';
const MCP_PORT       = parseInt(process.env.PORT || '8003', 10);
const TRANSPORT      = process.env.MCP_TRANSPORT || 'stdio'; // 'stdio' | 'http'

if (!API_KEY) {
  process.stderr.write('[walichat-extended] ERROR: WALICHAT_API_KEY env var is required\n');
  process.exit(1);
}

// ─── SQLite local ─────────────────────────────────────────────────────────────
const DB_PATH = process.env.WALICHAT_DB_PATH
  || path.join(os.homedir(), '.walichat-extended', 'contacts.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS contact_intel (
    phone      TEXT PRIMARY KEY,
    name       TEXT,
    priority   INTEGER DEFAULT 3,
    context    TEXT,
    tags       TEXT,
    ignored    INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ignored_numbers (
    phone      TEXT PRIMARY KEY,
    reason     TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toWid(chat) {
  if (!chat) return chat;
  if (chat.includes('@')) return chat;
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

// ─── Server factory ───────────────────────────────────────────────────────────
// In HTTP mode each request needs its own McpServer instance to avoid
// "Already connected to a transport" errors. db is shared (module-level).

function createServer() {
  const server = new McpServer({
    name: 'walichat-extended',
    version: '2.0.0',
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

// ── 10. Send message ──────────────────────────────────────────────────────────
server.tool(
  'send_message',
  {
    phone:   z.string().describe('Número de teléfono destino (ej. 18096459554)'),
    message: z.string().min(1).describe('Texto del mensaje a enviar'),
    device:  z.string().optional(),
  },
  async ({ phone, message, device }) => {
    const dev = device || DEFAULT_DEVICE;
    const wid = toWid(phone);
    const data = await wali('POST', '/v1/messages', {
      device: dev,
      to: wid,
      message: { type: 'text', text: message },
    });
    if (data.id) return ok(`✅ Mensaje enviado (ID: ${data.id}) a ${wid}`);
    return ok(data);
  }
);

// ── 11. Send media ────────────────────────────────────────────────────────────
server.tool(
  'send_media',
  {
    phone:    z.string().describe('Número destino'),
    url:      z.string().url().describe('URL pública del archivo'),
    type:     z.enum(['image', 'document', 'audio', 'video']).describe('Tipo de archivo'),
    caption:  z.string().optional().describe('Texto que acompaña el archivo'),
    filename: z.string().optional().describe('Nombre del archivo (para documentos)'),
    device:   z.string().optional(),
  },
  async ({ phone, url, type, caption, filename, device }) => {
    const dev = device || DEFAULT_DEVICE;
    const wid = toWid(phone);
    const mediaBody = { url };
    if (caption)  mediaBody.caption  = caption;
    if (filename) mediaBody.filename = filename;
    const data = await wali('POST', '/v1/messages', {
      device: dev,
      to: wid,
      message: { type, [type]: mediaBody },
    });
    if (data.id) return ok(`✅ Media enviada (ID: ${data.id}) a ${wid}`);
    return ok(data);
  }
);

// ── 12. Get device status ─────────────────────────────────────────────────────
server.tool(
  'get_device_status',
  {
    device: z.string().optional(),
  },
  async ({ device }) => {
    const dev = device || DEFAULT_DEVICE;
    const data = await wali('GET', `/v1/devices/${dev}`);
    if (!data.metrics) return ok(data);
    const m = data.metrics;
    return ok(
      `📱 Dispositivo: ${data.profile?.name || dev}\n` +
      `Estado sesión: ${data.session?.status || '?'}\n\n` +
      `📬 Chats personales sin leer: ${m.unreadChats}\n` +
      `   Mensajes sin leer: ${m.unreadMessages}\n\n` +
      `💬 Grupos sin leer: ${m.unreadGroupChats}\n` +
      `   Mensajes de grupo sin leer: ${m.unreadGroupMessages}`
    );
  }
);

// ── 13. List labels ───────────────────────────────────────────────────────────
server.tool(
  'list_labels',
  {
    device: z.string().optional(),
  },
  async ({ device }) => {
    const dev = device || DEFAULT_DEVICE;
    const data = await wali('GET', `/v1/chat/${dev}/labels`);
    if (!Array.isArray(data)) return ok(data);
    const lines = data.map(l => `• ${l.name} (${l.color || 'sin color'}) — scope: ${l.scope}`);
    return ok(`${data.length} etiqueta(s) disponibles:\n` + lines.join('\n'));
  }
);

// ── 14. Create contact ────────────────────────────────────────────────────────
server.tool(
  'create_contact',
  {
    phone:  z.string().describe('Número de teléfono del nuevo contacto'),
    name:   z.string().describe('Nombre del contacto'),
    device: z.string().optional(),
  },
  async ({ phone, name, device }) => {
    const dev = device || DEFAULT_DEVICE;
    const wid = toWid(phone);
    const data = await wali('POST', `/v1/chat/${dev}/contacts`, { phone: wid, name });
    return ok(data);
  }
);

// ── 15. List chats ────────────────────────────────────────────────────────────
server.tool(
  'list_chats',
  {
    device:  z.string().optional(),
    limit:   z.number().int().min(1).max(100).optional().default(20)
               .describe('Máximo de chats a retornar'),
    status:  z.enum(['active', 'resolved', 'pending']).optional()
               .describe('Filtrar por estado'),
    unread:  z.boolean().optional()
               .describe('Si true, solo chats con mensajes sin leer'),
    label:   z.string().optional()
               .describe('Filtrar por nombre de etiqueta'),
    query:   z.string().optional()
               .describe('Buscar por nombre o número'),
    page:    z.number().int().min(1).optional().default(1),
  },
  async ({ device, limit, status, unread, label, query, page }) => {
    const dev = device || DEFAULT_DEVICE;
    const params = new URLSearchParams({
      limit:  String(limit ?? 20),
      page:   String(page ?? 1),
      sort:   'lastMessageAt',
      order:  'desc',
    });
    if (status) params.set('status', status);
    if (unread) params.set('unread', 'true');
    if (label)  params.set('label', label);
    if (query)  params.set('query', query);

    const data = await wali('GET', `/v1/chat/${dev}/chats?${params}`);
    if (!Array.isArray(data)) return ok(data);

    const lines = data.map((c, i) => {
      const badge   = c.unreadCount > 0 ? ` [${c.unreadCount} sin leer]` : '';
      const lastMsg = c.lastMessage?.body?.slice(0, 70) || '[media]';
      const time    = c.lastMessageAt
        ? new Date(c.lastMessageAt).toLocaleString('es-DO', { timeZone: 'America/Santo_Domingo' })
        : '';
      return `${i + 1}. ${c.name || c.phone}${badge} (${c.status || 'active'})\n   ID: ${c.wid} | ${time}\n   "${lastMsg}"`;
    });

    return ok(`${data.length} chat(s):\n\n` + lines.join('\n\n'));
  }
);

// ── 16. List pending chats ────────────────────────────────────────────────────
server.tool(
  'list_pending_chats',
  {
    device: z.string().optional(),
    limit:  z.number().int().min(1).max(50).optional().default(10),
  },
  async ({ device, limit }) => {
    const dev = device || DEFAULT_DEVICE;
    const data = await wali(
      'GET',
      `/v1/chat/${dev}/chats?status=pending&limit=${limit ?? 10}&sort=lastMessageAt&order=desc`
    );
    if (!Array.isArray(data)) return ok(data);
    if (data.length === 0) return ok('✅ No hay chats pendientes en este momento.');

    const lines = data.map((c, i) => {
      const time = c.lastMessageAt
        ? new Date(c.lastMessageAt).toLocaleString('es-DO', { timeZone: 'America/Santo_Domingo' })
        : 'sin fecha';
      return `${i + 1}. 🔴 ${c.name || c.phone}\n   ID: ${c.wid}\n   ${time}\n   "${c.lastMessage?.body?.slice(0, 80) || '[media]'}"`;
    });

    return ok(`🔴 ${data.length} chat(s) pendiente(s):\n\n` + lines.join('\n\n'));
  }
);

// ── 17. Get inbox summary ─────────────────────────────────────────────────────
server.tool(
  'get_inbox_summary',
  {
    device:        z.string().optional(),
    top:           z.number().int().min(1).max(20).optional().default(5)
                     .describe('Cuántos chats retornar'),
    onlyUnread:    z.boolean().optional().default(true)
                     .describe('Solo chats con mensajes sin leer'),
    status:        z.enum(['active', 'resolved', 'pending', 'all']).optional().default('all'),
    includeGroups: z.boolean().optional().default(false)
                     .describe('Incluir grupos en el resumen'),
  },
  async ({ device, top, onlyUnread, status, includeGroups }) => {
    const dev = device || DEFAULT_DEVICE;

    const params = new URLSearchParams({
      limit: String((top ?? 5) * 4),
      sort:  'lastMessageAt',
      order: 'desc',
    });
    if (onlyUnread) params.set('unread', 'true');
    if (status && status !== 'all') params.set('status', status);

    const chats = await wali('GET', `/v1/chat/${dev}/chats?${params}`);
    if (!Array.isArray(chats)) return ok(chats);

    const ignoredRows = db.prepare('SELECT phone FROM ignored_numbers').all();
    const ignoredSet  = new Set(ignoredRows.map(r => r.phone));

    const filtered = chats
      .filter(c => !ignoredSet.has(c.wid) && !ignoredSet.has(c.phone))
      .filter(c => includeGroups || !String(c.wid ?? '').includes('@g.us'));

    const enriched = filtered.slice(0, (top ?? 5) * 2).map(c => {
      const intel = db.prepare('SELECT * FROM contact_intel WHERE phone = ?').get(c.wid || c.phone) || {};
      return { ...c, priority: intel.priority ?? 3, context: intel.context ?? '', tags: intel.tags ?? '' };
    });

    enriched.sort((a, b) => {
      if (a.status === 'pending' && b.status !== 'pending') return -1;
      if (b.status === 'pending' && a.status !== 'pending') return 1;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return new Date(b.lastMessageAt ?? 0) - new Date(a.lastMessageAt ?? 0);
    });

    const topChats = enriched.slice(0, top ?? 5);

    const summaries = await Promise.all(topChats.map(async c => {
      const enc  = encodeURIComponent(c.wid || toWid(c.phone));
      const msgs = await wali('GET', `/v1/chat/${dev}/messages?chat=${enc}&limit=3`);
      const last = Array.isArray(msgs) ? msgs[0] : null;
      const mins = c.lastMessageAt
        ? Math.round((Date.now() - new Date(c.lastMessageAt)) / 60000)
        : null;
      const ago = mins === null ? '' : mins < 60 ? `hace ${mins} min` : `hace ${Math.round(mins / 60)}h`;
      return { ...c, lastMsg: last?.body || c.lastMessage?.body || '[media]', ago };
    }));

    const icon = s => s === 'pending' ? '🔴' : '🟡';
    const lines = summaries.map((s, i) => {
      const ctx  = s.context ? `\n   Contexto: ${s.context}` : '';
      const tags = s.tags    ? ` [${s.tags}]` : '';
      const star = s.priority <= 2 ? ' ⭐' : '';
      return (
        `${i + 1}. ${icon(s.status)} *${s.name || s.phone}*${star}${tags}\n` +
        `   ID: ${s.wid} | ${s.ago} | ${s.unreadCount ?? 0} sin leer${ctx}\n` +
        `   "${s.lastMsg}"`
      );
    });

    return ok(`📬 Top ${summaries.length} chats más urgentes:\n\n` + lines.join('\n\n'));
  }
);

// ── 18. Set contact intel ─────────────────────────────────────────────────────
server.tool(
  'set_contact_intel',
  {
    phone:    z.string().describe('Número de teléfono o chat ID'),
    priority: z.number().int().min(1).max(5).optional()
                .describe('1=crítico, 2=alta, 3=normal, 4=baja, 5=muy baja'),
    context:  z.string().optional()
                .describe('Quién es, de qué empresa, qué relación tienes con esta persona'),
    tags:     z.array(z.string()).optional()
                .describe('Etiquetas: ["cliente", "proveedor", "familia", "urgente"]'),
    name:     z.string().optional()
                .describe('Nombre local (override del nombre en WhatsApp)'),
  },
  async ({ phone, priority, context, tags, name }) => {
    const wid      = toWid(phone);
    const existing = db.prepare('SELECT * FROM contact_intel WHERE phone = ?').get(wid) || {};
    const tagsStr  = tags ? tags.join(',') : (existing.tags ?? '');

    db.prepare(`
      INSERT INTO contact_intel (phone, name, priority, context, tags, updated_at)
      VALUES (@phone, @name, @priority, @context, @tags, datetime('now'))
      ON CONFLICT(phone) DO UPDATE SET
        name       = COALESCE(@name, name),
        priority   = COALESCE(@priority, priority),
        context    = COALESCE(@context, context),
        tags       = COALESCE(@tags, tags),
        updated_at = datetime('now')
    `).run({
      phone:    wid,
      name:     name     ?? existing.name     ?? null,
      priority: priority ?? existing.priority ?? 3,
      context:  context  ?? existing.context  ?? null,
      tags:     tagsStr  || null,
    });

    return ok(
      `✅ Intel guardada para ${wid}\n` +
      `  Prioridad: ${priority ?? existing.priority ?? 3}/5\n` +
      `  Contexto: ${context ?? existing.context ?? '(sin contexto)'}\n` +
      `  Tags: ${tagsStr || '(sin tags)'}`
    );
  }
);

// ── 19. Ignore contact ────────────────────────────────────────────────────────
server.tool(
  'ignore_contact',
  {
    phone:  z.string().describe('Número o chat ID a ignorar'),
    reason: z.string().optional().describe('Razón (spam, grupo irrelevante, etc.)'),
    undo:   z.boolean().optional().default(false)
              .describe('Si true, quita el número de la lista de ignorados'),
  },
  async ({ phone, reason, undo }) => {
    const wid = toWid(phone);
    if (undo) {
      db.prepare('DELETE FROM ignored_numbers WHERE phone = ?').run(wid);
      db.prepare('UPDATE contact_intel SET ignored = 0 WHERE phone = ?').run(wid);
      return ok(`✅ ${wid} eliminado de la lista de ignorados`);
    }
    db.prepare('INSERT OR REPLACE INTO ignored_numbers (phone, reason) VALUES (?, ?)').run(wid, reason ?? null);
    db.prepare(`
      INSERT INTO contact_intel (phone, ignored) VALUES (?, 1)
      ON CONFLICT(phone) DO UPDATE SET ignored = 1, updated_at = datetime('now')
    `).run(wid);
    return ok(`🔇 ${wid} añadido a ignorados${reason ? ` — motivo: ${reason}` : ''}`);
  }
);

// ── 20. Get contact intel ─────────────────────────────────────────────────────
server.tool(
  'get_contact_intel',
  {
    phone: z.string().describe('Número o chat ID'),
  },
  async ({ phone }) => {
    const wid   = toWid(phone);
    const intel = db.prepare('SELECT * FROM contact_intel WHERE phone = ?').get(wid);
    if (!intel) return ok(`No hay intel guardada para ${wid}`);
    return ok(
      `📇 Intel de ${intel.name || wid}:\n` +
      `  Prioridad: ${intel.priority}/5\n` +
      `  Contexto: ${intel.context || '(sin contexto)'}\n` +
      `  Tags: ${intel.tags || '(sin tags)'}\n` +
      `  Ignorado: ${intel.ignored ? 'Sí 🔇' : 'No'}\n` +
      `  Actualizado: ${intel.updated_at}`
    );
  }
);

// ── 21. List contact intel ────────────────────────────────────────────────────
server.tool(
  'list_contact_intel',
  {
    priority: z.number().int().min(1).max(5).optional()
                .describe('Filtrar por prioridad exacta'),
    tag:      z.string().optional()
                .describe('Filtrar por tag'),
    ignored:  z.boolean().optional()
                .describe('Si true, muestra solo los ignorados'),
  },
  async ({ priority, tag, ignored }) => {
    let query  = 'SELECT * FROM contact_intel WHERE 1=1';
    const args = [];
    if (priority !== undefined) { query += ' AND priority = ?'; args.push(priority); }
    if (tag)                    { query += ' AND tags LIKE ?';  args.push(`%${tag}%`); }
    if (ignored !== undefined)  { query += ' AND ignored = ?';  args.push(ignored ? 1 : 0); }
    query += ' ORDER BY priority ASC, updated_at DESC LIMIT 100';

    const rows = db.prepare(query).all(...args);
    if (rows.length === 0) return ok('No hay contactos con intel que coincidan con los filtros.');

    const lines = rows.map(r =>
      `P${r.priority} | ${r.name || r.phone}${r.ignored ? ' 🔇' : ''} | ${r.tags || '-'}\n  ${r.context || '(sin contexto)'}`
    );
    return ok(`${rows.length} contacto(s) con intel:\n\n` + lines.join('\n\n'));
  }
);

// ── 22. List ignored ──────────────────────────────────────────────────────────
server.tool(
  'list_ignored',
  {},
  async () => {
    const rows = db.prepare('SELECT * FROM ignored_numbers ORDER BY created_at DESC').all();
    if (rows.length === 0) return ok('No hay números ignorados.');
    const lines = rows.map(r => `🔇 ${r.phone}${r.reason ? ` — ${r.reason}` : ''} (desde ${r.created_at.slice(0, 10)})`);
    return ok(`${rows.length} número(s) ignorado(s):\n` + lines.join('\n'));
  }
);

  return server;
}

// ─── Start ────────────────────────────────────────────────────────────────────

if (TRANSPORT === 'http') {
  // Streamable HTTP mode — for MCPJungle cloud deployment
  // Each request gets its own McpServer instance (stateless). db is shared module-level.
  const httpServer = http.createServer(async (req, res) => {
    if (req.url === '/mcp' || req.url === '/') {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } else if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'walichat-extended', version: '2.0.0' }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  httpServer.listen(MCP_PORT, '0.0.0.0', () => {
    process.stderr.write(`[walichat-extended] HTTP MCP server v2.0.0 on 0.0.0.0:${MCP_PORT}/mcp\n`);
  });
} else {
  // Stdio mode — for local MCP Router
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[walichat-extended] MCP server v2.0.0 running (stdio)\n');
}
