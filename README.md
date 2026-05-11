# WaliChat Extended MCP

Extiende el MCP nativo de WaliChat con las capacidades que le faltan: leer conversaciones, escribir notas privadas, gestionar contactos y cambiar estados de chats.

## Herramientas disponibles

| Herramienta | Descripción |
|---|---|
| `read_conversation` | Lee el historial completo de mensajes (enviados y recibidos) de un chat |
| `create_chat_note` | Escribe una nota privada en el perfil de un chat (solo visible en WaliChat) |
| `get_contact` | Obtiene los detalles de un contacto (nombre, metadata, info de perfil) |
| `search_contacts` | Busca contactos por nombre o número |
| `update_contact` | Actualiza el nombre o metadata de un contacto |
| `update_chat_status` | Cambia el estado del chat: `active`, `resolved`, `pending` |
| `mark_chat_unread` | Marca un chat como no leído |
| `update_chat_labels` | Aplica etiquetas a un chat |
| `get_chat_details` | Obtiene los detalles y estadísticas de un chat |

## Setup

### Variables de entorno requeridas

| Variable | Descripción |
|---|---|
| `WALICHAT_API_KEY` | Tu API key de WaliChat |
| `WALICHAT_DEVICE_ID` | ID del dispositivo WhatsApp por defecto (24 caracteres hex) |

### Instalación manual (Claude Desktop)

Agrega esto a tu `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "walichat-extended": {
      "command": "node",
      "args": ["/ruta/al/plugin/servers/index.js"],
      "env": {
        "WALICHAT_API_KEY": "tu-api-key-aqui",
        "WALICHAT_DEVICE_ID": "tu-device-id-aqui"
      }
    }
  }
}
```

### Instalar dependencias

```bash
cd servers/
npm install
```

## Uso de ejemplo

```
read_conversation(chat="584126964574@c.us", limit=20)
create_chat_note(chat="584126964574", message="Cliente interesado en plan Enterprise")
update_chat_status(chat="584126964574", status="resolved")
search_contacts(query="Edimar")
```

## Endpoints REST utilizados

| Operación | Método | Path |
|---|---|---|
| Leer mensajes | GET | `/v1/chat/{device}/messages?chat={id}` |
| Crear nota | POST | `/v1/chat/{device}/chats/{id}/notes` |
| Ver contacto | GET | `/v1/chat/{device}/contacts/{id}` |
| Buscar contactos | GET | `/v1/chat/{device}/contacts?query=` |
| Actualizar contacto | PATCH | `/v1/chat/{device}/contacts/{id}` |
| Ver chat | GET | `/v1/chat/{device}/chats/{id}` |
| Cambiar estado | PATCH | `/v1/chat/{device}/chats/{id}/status` |
| Marcar no leído | PATCH | `/v1/chat/{device}/chats/{id}/unread` |
| Actualizar labels | PATCH | `/v1/chat/{device}/chats/{id}/labels` |
