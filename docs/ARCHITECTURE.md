# Architecture

## System Overview

claude-peers is a peer-discovery and messaging system for Claude Code instances running on the same machine. It consists of three components: a shared **broker daemon**, per-session **MCP servers**, and a **CLI** for manual interaction.

```
                         ┌─────────────────────────────────────┐
                         │         Broker Daemon                │
                         │     localhost:7899  (HTTP + SQLite)  │
                         │                                      │
                         │  /register      /send-message        │
                         │  /heartbeat     /poll-messages       │
                         │  /set-summary   /unregister          │
                         │  /list-peers    /health              │
                         └──────┬──────────────┬───────────┬────┘
                                │              │           │
                           HTTP POST      HTTP POST    HTTP POST
                                │              │           │
                   ┌────────────┴──┐   ┌───────┴──────┐   │
                   │ MCP Server A  │   │ MCP Server B │   │
                   │ (stdio)       │   │ (stdio)      │   │
                   └──────┬────────┘   └──────┬───────┘   │
                          │                   │           │
                     Claude Code A       Claude Code B   CLI
                     (Terminal 1)        (Terminal 2)    (ad hoc)
```

## Communication Flow

### 1. Startup Sequence

```
Claude Code starts
  └─> spawns MCP Server (stdio transport)
        ├─> ensureBroker(): checks /health, launches broker.ts if needed
        ├─> gathers context: cwd, git_root, tty
        ├─> generates auto-summary via gpt-5.4-nano (optional, non-blocking)
        ├─> POST /register -> receives peer ID
        ├─> connects MCP over stdio
        ├─> starts poll loop (every 1s)
        └─> starts heartbeat loop (every 15s)
```

### 2. Sending a Message

```
Claude A calls send_message tool
  └─> MCP Server A: POST /send-message { from_id, to_id, text }
        └─> Broker: INSERT INTO messages (from_id, to_id, text, sent_at, delivered=0)
              └─> returns { ok: true }

MCP Server B poll loop (1s interval):
  └─> POST /poll-messages { id: B }
        └─> Broker: SELECT * FROM messages WHERE to_id=B AND delivered=0
              └─> UPDATE messages SET delivered=1 WHERE id=...
                    └─> MCP Server B: pushes channel notification
                          └─> Claude B receives <channel> message instantly
```

### 3. Peer Discovery

```
Claude A calls list_peers { scope: "repo" }
  └─> MCP Server A: POST /list-peers { scope, cwd, git_root, exclude_id }
        └─> Broker: SELECT from peers (filtered by scope)
              └─> verifies each peer's PID is alive (kill(pid, 0))
                    └─> returns live peers only
```

### 4. Heartbeat & Cleanup

```
Every 15s: MCP Server -> POST /heartbeat { id } -> updates last_seen
Every 30s: Broker -> cleanStalePeers() -> kill(pid, 0) for each peer
  └─> dead PIDs: DELETE from peers, DELETE pending messages
On MCP exit: POST /unregister { id }
```

## SQLite Schema

The broker stores all state in a single SQLite database at `~/.claude-peers.db` (configurable via `CLAUDE_PEERS_DB`).

### peers

| Column          | Type    | Description                                |
| --------------- | ------- | ------------------------------------------ |
| `id`            | TEXT PK | Randomly generated 8-char alphanumeric ID  |
| `pid`           | INTEGER | OS process ID of the MCP server            |
| `cwd`           | TEXT    | Working directory of the Claude session     |
| `git_root`      | TEXT    | Git repository root (nullable)             |
| `tty`           | TEXT    | Terminal device (nullable)                 |
| `summary`       | TEXT    | Human-readable summary of current work     |
| `registered_at` | TEXT    | ISO 8601 timestamp of registration         |
| `last_seen`     | TEXT    | ISO 8601 timestamp of last heartbeat       |

### messages

| Column      | Type        | Description                                  |
| ----------- | ----------- | -------------------------------------------- |
| `id`        | INTEGER PK  | Auto-incrementing message ID                 |
| `from_id`   | TEXT FK     | Sender peer ID (references peers.id)         |
| `to_id`     | TEXT FK     | Recipient peer ID (references peers.id)      |
| `text`      | TEXT        | Message body                                 |
| `sent_at`   | TEXT        | ISO 8601 timestamp                           |
| `delivered` | INTEGER     | 0 = pending, 1 = delivered                   |

**Pragmas:** `journal_mode = WAL`, `busy_timeout = 3000`

## MCP Tools

The MCP server exposes four tools to Claude Code:

### list_peers

Discover other Claude Code instances.

- **Input:** `scope` ("machine" | "directory" | "repo")
- **Behavior:** Queries the broker filtered by scope. "machine" returns all peers. "directory" matches on `cwd`. "repo" matches on `git_root` (falls back to directory if not in a git repo). The requesting peer is excluded from results. Dead processes are filtered out.
- **Output:** Peer list with ID, PID, CWD, repo, TTY, summary, last_seen.

### send_message

Send a text message to another Claude Code instance.

- **Input:** `to_id` (peer ID), `message` (text)
- **Behavior:** Posts to broker `/send-message`. The message is stored in SQLite and delivered to the recipient on their next poll cycle (within 1 second). Delivered via `notifications/claude/channel` so it appears immediately in the recipient's session.
- **Output:** Confirmation or error.

### set_summary

Set a brief description of current work.

- **Input:** `summary` (1-2 sentences)
- **Behavior:** Updates the peer's summary in the broker. Visible to other peers when they call `list_peers`.
- **Output:** Confirmation.

### check_messages

Manually poll for new messages.

- **Input:** None
- **Behavior:** Calls `/poll-messages` and returns any undelivered messages. This is a fallback; normally messages are pushed automatically via the channel notification system.
- **Output:** Messages or "no new messages".

## CLI Commands

| Command                        | Description                                 |
| ------------------------------ | ------------------------------------------- |
| `bun cli.ts status`            | Show broker health and list all peers       |
| `bun cli.ts peers`             | List registered peers                       |
| `bun cli.ts send <id> <msg>`   | Send a message to a specific peer           |
| `bun cli.ts broadcast <msg>`   | Send a message to all registered peers      |
| `bun cli.ts logs [N]`          | Show last N messages from SQLite (default 20)|
| `bun cli.ts kill-broker`       | Find and terminate the broker process       |

## Key Design Decisions

1. **SQLite over in-memory:** Survives broker restarts. Messages are not lost if the broker crashes.
2. **Polling over WebSocket:** Simpler implementation. 1-second poll interval is fast enough for conversational messaging between Claude instances.
3. **Auto-launch broker:** The first MCP server to start spawns the broker if it is not running. No manual setup required.
4. **Process-level liveness:** The broker verifies peer PIDs with `kill(pid, 0)` rather than relying solely on heartbeat timeouts. This immediately detects crashed processes.
5. **Channel notifications:** Messages are pushed via MCP's experimental `claude/channel` capability, so Claude sees them mid-conversation without needing to explicitly check.
