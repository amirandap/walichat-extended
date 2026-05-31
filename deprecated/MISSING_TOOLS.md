# walichat-extended v2 — Guía de implementación para Claude Code

## Contexto y objetivo

Este repositorio contiene un MCP custom (`servers/index.js`) instalado en MCPJungle junto al MCP nativo de WaliChat. El objetivo es **consolidar ambos en uno solo**: añadir al `index.js` todos los tools que hoy viven en el MCP nativo, los tools de navegación del inbox que no existen en ninguno, y una capa SQLite local para prioridades e inteligencia de contactos.

Al terminar, el MCP nativo de WaliChat en MCPJungle puede desactivarse. Solo quedará este servidor.

---

## Arquitectura actual vs. objetivo

**Actual (dos servidores en MCPJungle):**
```
Claude → MCP nativo WaliChat   → api.wali.chat  (send, devices, etc.)
Claude → walichat-extended     → api.wali.chat  (read, notes, contacts, status)
```

**Objetivo (un solo servidor):**
```
Claude → walichat-extended v2  → api.wali.chat  (TODO)
                               → SQLite local   (prioridades, contexto, ignorados)
```

---

## Archivos a modificar

Solo hay un archivo que tocar: **`servers/index.js`**

El `package.json` necesita una dependencia nueva: `better-sqlite3`

---

## Paso 1 — Instalar dependencia

```bash
cd /ruta/al/repo/servers
npm install better-sqlite3
```

Verificar que queda en `servers/package.json` bajo `dependencies`.

---

## Paso 2 — Nuevos imports y setup de SQLite

Agregar al inicio de `servers/index.js`, **después de los imports existentes** y **antes de la línea `const API_KEY`**:

```js
import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

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
```

---

## Paso 3 — Tools nuevos a agregar a `servers/index.js`

Añadir cada bloque a continuación del último `server.tool(...)` existente (antes de la sección `// ─── Start`).

---

### Tool 10: `send_message`

Origen: MCP nativo de WaliChat. Envía un mensaje de texto.

```js
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
```

---

### Tool 11: `send_media`

Origen: MCP nativo de WaliChat. Envía imagen, documento, audio o video.

```js
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
```

---

### Tool 12: `get_device_status`

Origen: MCP nativo de WaliChat. Estado del dispositivo y métricas del inbox (chats sin leer, mensajes pendientes).

```js
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
```

---

### Tool 13: `list_labels`

Origen: MCP nativo de WaliChat. Lista las etiquetas disponibles en el dispositivo.

```js
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
```

---

### Tool 14: `create_contact`

Origen: MCP nativo de WaliChat. Crea un nuevo contacto.

```js
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
```

---

### Tool 15: `list_chats`

Nuevo. Navega el inbox con filtros por estado, no-leídos, etiqueta y búsqueda.

```js
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
```

---

### Tool 16: `list_pending_chats`

Nuevo. Lista específicamente chats en estado `pending`.

```js
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
```

---

### Tool 17: `get_inbox_summary` ⭐

Nuevo. El tool principal: trae los N chats más urgentes considerando prioridades locales (SQLite) e ignorados. Es el que responde "dame los 5 mensajes más importantes".

```js
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

    // 1. Traer chats del API (más de top para tener margen al filtrar)
    const params = new URLSearchParams({
      limit: String((top ?? 5) * 4),
      sort:  'lastMessageAt',
      order: 'desc',
    });
    if (onlyUnread) params.set('unread', 'true');
    if (status && status !== 'all') params.set('status', status);

    const chats = await wali('GET', `/v1/chat/${dev}/chats?${params}`);
    if (!Array.isArray(chats)) return ok(chats);

    // 2. Filtrar ignorados (SQLite)
    const ignoredRows = db.prepare('SELECT phone FROM ignored_numbers').all();
    const ignoredSet  = new Set(ignoredRows.map(r => r.phone));

    const filtered = chats
      .filter(c => !ignoredSet.has(c.wid) && !ignoredSet.has(c.phone))
      .filter(c => includeGroups || !String(c.wid ?? '').includes('@g.us'));

    // 3. Enriquecer con intel local (prioridad y contexto)
    const enriched = filtered.slice(0, (top ?? 5) * 2).map(c => {
      const intel = db.prepare('SELECT * FROM contact_intel WHERE phone = ?').get(c.wid || c.phone) || {};
      return { ...c, priority: intel.priority ?? 3, context: intel.context ?? '', tags: intel.tags ?? '' };
    });

    // 4. Ordenar: pending primero → prioridad (1=más urgente) → más reciente
    enriched.sort((a, b) => {
      if (a.status === 'pending' && b.status !== 'pending') return -1;
      if (b.status === 'pending' && a.status !== 'pending') return 1;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return new Date(b.lastMessageAt ?? 0) - new Date(a.lastMessageAt ?? 0);
    });

    const topChats = enriched.slice(0, top ?? 5);

    // 5. Leer el último mensaje real de cada chat
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

    // 6. Formatear respuesta
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
```

---

### Tool 18: `set_contact_intel`

SQLite. Asigna prioridad, contexto y tags a un contacto. Persiste entre sesiones.

```js
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
```

---

### Tool 19: `ignore_contact`

SQLite. Excluye un número de todos los resúmenes de inbox. Soporta deshacer.

```js
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
```

---

### Tool 20: `get_contact_intel`

SQLite. Consulta el contexto guardado de un contacto.

```js
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
```

---

### Tool 21: `list_contact_intel`

SQLite. Lista todos los contactos con intel guardada, con filtros opcionales.

```js
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
```

---

### Tool 22: `list_ignored`

SQLite. Lista todos los números en la lista de ignorados.

```js
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
```

---

## Paso 4 — Verificar antes de implementar

Antes de tocar código, confirmar que el endpoint de listado de chats existe en el plan actual:

```bash
curl -s -H "Authorization: Bearer $WALICHAT_API_KEY" \
  "https://api.wali.chat/v1/chat/$WALICHAT_DEVICE_ID/chats?limit=3&sort=lastMessageAt&order=desc&unread=true" \
  | jq '.[0] | {wid, name, status, unreadCount, lastMessageAt, lastMessage}'
```

Si retorna un objeto con esos campos, todo el código de las Secciones 2 y 3 funciona sin ajustes.

---

## Paso 5 — Deshabilitar el MCP nativo de WaliChat en MCPJungle

Una vez que los tools estén probados y funcionando, el MCP nativo de WaliChat en MCPJungle puede desactivarse desde la configuración del plugin. El custom server cubre todo.

---

## Tabla final de tools

| # | Tool | Tipo | Qué hace |
|---|------|------|----------|
| 1 | `read_conversation` | Existente | Lee historial de mensajes de un chat |
| 2 | `create_chat_note` | Existente | Nota privada en un chat |
| 3 | `get_contact` | Existente | Detalle de un contacto |
| 4 | `search_contacts` | Existente | Buscar contactos por nombre/número |
| 5 | `update_contact` | Existente | Actualizar nombre o metadata |
| 6 | `update_chat_status` | Existente | Cambiar estado: active/resolved/pending |
| 7 | `mark_chat_unread` | Existente | Marcar como no leído |
| 8 | `update_chat_labels` | Existente | Aplicar etiquetas |
| 9 | `get_chat_details` | Existente | Detalle y stats de un chat |
| 10 | `send_message` | ← Nativo | Enviar texto |
| 11 | `send_media` | ← Nativo | Enviar imagen/doc/audio/video |
| 12 | `get_device_status` | ← Nativo | Estado del dispositivo e inbox metrics |
| 13 | `list_labels` | ← Nativo | Etiquetas disponibles |
| 14 | `create_contact` | ← Nativo | Crear contacto nuevo |
| 15 | `list_chats` | 🆕 Nuevo | Listar inbox con filtros |
| 16 | `list_pending_chats` | 🆕 Nuevo | Solo chats pendientes |
| 17 | `get_inbox_summary` | 🆕 Nuevo ⭐ | Top N chats más urgentes (con SQLite) |
| 18 | `set_contact_intel` | 🆕 SQLite | Asignar prioridad + contexto + tags |
| 19 | `ignore_contact` | 🆕 SQLite | Ignorar número del inbox |
| 20 | `get_contact_intel` | 🆕 SQLite | Ver intel de un contacto |
| 21 | `list_contact_intel` | 🆕 SQLite | Ver todos los contactos con intel |
| 22 | `list_ignored` | 🆕 SQLite | Ver lista de ignorados |
