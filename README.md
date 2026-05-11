# WaliChat Extended MCP

Extends the native WaliChat MCP with the capabilities it's missing: reading conversations, writing private notes, managing contacts, and changing chat statuses.

## Available Tools

| Tool | Description |
|---|---|
| `read_conversation` | Reads the full message history (sent and received) from a chat |
| `create_chat_note` | Writes a private note on a chat profile (only visible in WaliChat) |
| `get_contact` | Retrieves contact details (name, metadata, profile info) |
| `search_contacts` | Searches contacts by name or phone number |
| `update_contact` | Updates a contact's name or metadata |
| `update_chat_status` | Changes chat status: `active`, `resolved`, or `pending` |
| `mark_chat_unread` | Marks a chat as unread |
| `update_chat_labels` | Applies labels to a chat |
| `get_chat_details` | Retrieves chat details and statistics |

## Setup

### Required Environment Variables

| Variable | Description |
|---|---|
| `WALICHAT_API_KEY` | Your WaliChat API key (found at app.wali.chat → Settings → API) |
| `WALICHAT_DEVICE_ID` | Default WhatsApp device ID (24-char hex, found at app.wali.chat → Devices) |

### Install Dependencies

```bash
cd servers/
npm install
```

### Claude Desktop (manual install)

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "walichat-extended": {
      "command": "node",
      "args": ["/path/to/walichat-extended/servers/index.js"],
      "env": {
        "WALICHAT_API_KEY": "your-api-key-here",
        "WALICHAT_DEVICE_ID": "your-device-id-here"
      }
    }
  }
}
```

## Usage Examples

```
read_conversation(chat="584126964574@c.us", limit=20)
create_chat_note(chat="584126964574", message="Client interested in Enterprise plan")
update_chat_status(chat="584126964574", status="resolved")
search_contacts(query="John")
```

## REST Endpoints Used

| Operation | Method | Path |
|---|---|---|
| Read messages | GET | `/v1/chat/{device}/messages?chat={id}` |
| Create note | POST | `/v1/chat/{device}/chats/{id}/notes` |
| Get contact | GET | `/v1/chat/{device}/contacts/{id}` |
| Search contacts | GET | `/v1/chat/{device}/contacts?query=` |
| Update contact | PATCH | `/v1/chat/{device}/contacts/{id}` |
| Get chat | GET | `/v1/chat/{device}/chats/{id}` |
| Change status | PATCH | `/v1/chat/{device}/chats/{id}/status` |
| Mark unread | PATCH | `/v1/chat/{device}/chats/{id}/unread` |
| Update labels | PATCH | `/v1/chat/{device}/chats/{id}/labels` |

## License

MIT
