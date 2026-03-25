# Troubleshooting

## Quick Diagnostics

Run these commands first to understand the current state:

```bash
bun cli.ts status     # Is the broker running? How many peers?
bun cli.ts peers      # Are peers registered and alive?
bun cli.ts logs 10    # Are messages being sent/delivered?
```

---

## Broker Issues

### Broker does not start

**Symptoms:** "Broker is not running" from CLI, or MCP server fails with "Failed to start broker daemon after 6 seconds".

**Causes and fixes:**

1. **Port already in use** -- Another process occupies port 7899.
   ```bash
   lsof -ti :7899          # Check what's using the port
   kill $(lsof -ti :7899)  # Kill it
   bun broker.ts           # Restart manually
   ```

2. **Bun not installed or not in PATH**
   ```bash
   which bun               # Should print a path
   bun --version           # Should print version number
   ```

3. **SQLite database is locked or corrupted**
   ```bash
   ls -la ~/.claude-peers.db      # Check if it exists
   rm ~/.claude-peers.db          # Delete and let broker recreate
   bun broker.ts                  # Restart
   ```

4. **Permission error on database path**
   ```bash
   # Use a custom path if the default location is not writable
   CLAUDE_PEERS_DB=/tmp/claude-peers.db bun broker.ts
   ```

### Broker crashes on startup

Check stderr output:

```bash
bun broker.ts 2>&1 | head -20
```

Common causes:
- Incompatible Bun version. Requires Bun with `bun:sqlite` support (any recent version).
- Missing dependencies. Run `bun install` in the project directory.

### Broker is running but not responding

```bash
curl http://127.0.0.1:7899/health    # Should return {"status":"ok","peers":N}
```

If curl hangs, the broker process may be stuck. Kill and restart:

```bash
bun cli.ts kill-broker
bun broker.ts &
```

---

## Message Delivery Issues

### Messages are not delivered

**Symptoms:** `bun cli.ts send <id> <msg>` says "Message sent" but the recipient never receives it.

1. **Recipient's MCP server is not polling.** Check if the recipient's Claude Code session is still active. The MCP server polls every 1 second; if the session ended, messages accumulate undelivered.
   ```bash
   bun cli.ts logs 10    # Check delivered column: "pending" means undelivered
   ```

2. **Channel mode not enabled.** The recipient must be running Claude Code with:
   ```bash
   claude --dangerously-load-development-channels server:claude-peers
   ```
   Without the channel flag, messages are received but not pushed into the conversation. The recipient can still use `check_messages` manually.

3. **Peer ID is stale.** The recipient may have restarted and received a new ID.
   ```bash
   bun cli.ts peers      # Get the current peer list
   ```

### Messages are delayed

The polling interval is 1 second. If messages take longer:

- The broker may be under load from many peers. Check `bun cli.ts status` for the peer count.
- Network localhost resolution may be slow. Ensure `127.0.0.1` is used (it is by default).

### Broadcast sends to zero peers

```bash
bun cli.ts peers     # Verify peers are registered
```

If no peers are listed, no Claude Code sessions are actively running with the MCP server connected.

---

## Peer Discovery Issues

### Peer not found / no peers listed

1. **MCP server not registered.** The Claude Code session must be started with the MCP server configured:
   ```bash
   claude mcp add --scope user --transport stdio claude-peers -- bun ~/claude-peers-mcp/server.ts
   ```

2. **Broker was restarted.** Peers must re-register after a broker restart. Existing Claude Code sessions will not automatically re-register. Restart the Claude Code sessions.

3. **Stale peer cleanup removed it.** If the MCP server's process died without unregistering, the broker's 30-second cleanup cycle will remove it.

4. **Wrong scope.** If using `list_peers` with scope "repo" but the peer is in a different git repository, it will not appear. Try scope "machine" to see all peers.

### Peer shows in list but is not responsive

The peer's PID may still be alive (keeping it in the list) but the MCP server connection to Claude Code may have broken.

```bash
# Check if the peer's process is actually a running MCP server
ps -p <PID> -o command=
```

If the process is not a Bun/MCP server process, it is a PID reuse collision. The broker will eventually clean it up, or you can restart the broker.

---

## MCP Connection Issues

### "Not registered with broker yet"

The MCP server has not completed its startup sequence. This can happen if:

- The broker took too long to start (>6 seconds).
- The `/register` call failed.

Check the MCP server's stderr output for `[claude-peers]` log lines.

### Tools not appearing in Claude Code

1. Verify the MCP server is registered:
   ```bash
   claude mcp list         # Should show claude-peers
   ```

2. Verify the server path is correct:
   ```bash
   bun ~/claude-peers-mcp/server.ts   # Should start without errors (Ctrl+C to stop)
   ```

3. Re-add the MCP server:
   ```bash
   claude mcp remove claude-peers
   claude mcp add --scope user --transport stdio claude-peers -- bun ~/claude-peers-mcp/server.ts
   ```

---

## Auto-Summary Issues

### Summary is empty

Auto-summary requires `OPENAI_API_KEY` in the environment. Without it, the summary stays empty until Claude calls `set_summary`.

```bash
echo $OPENAI_API_KEY    # Should print a key starting with sk-
```

### Summary generation is slow

The summary is generated with a 5-second timeout and does not block startup. If the OpenAI API is slow, the summary will be applied after registration via a late update.

---

## Environment & Configuration

### Custom port

If port 7899 conflicts with another service:

```bash
export CLAUDE_PEERS_PORT=7900
```

Set this in all terminals. The broker, MCP servers, and CLI all read this variable.

### Custom database path

```bash
export CLAUDE_PEERS_DB=/path/to/custom.db
```

### Reset everything

```bash
bun cli.ts kill-broker
rm ~/.claude-peers.db
# Restart Claude Code sessions
```
