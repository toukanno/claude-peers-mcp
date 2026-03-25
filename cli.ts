#!/usr/bin/env bun
/**
 * claude-peers CLI
 *
 * Utility commands for managing the broker and inspecting peers.
 *
 * Usage:
 *   bun cli.ts status          — Show broker status and all peers
 *   bun cli.ts peers           — List all peers
 *   bun cli.ts send <id> <msg> — Send a message to a peer
 *   bun cli.ts broadcast <msg> — Send a message to all peers
 *   bun cli.ts logs [N]        — Show last N messages (default: 20)
 *   bun cli.ts kill-broker     — Stop the broker daemon
 */

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : {};
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

const cmd = process.argv[2];

switch (cmd) {
  case "status": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker: ${health.status} (${health.peers} peer(s) registered)`);
      console.log(`URL: ${BROKER_URL}`);

      if (health.peers > 0) {
        const peers = await brokerFetch<
          Array<{
            id: string;
            pid: number;
            cwd: string;
            git_root: string | null;
            tty: string | null;
            summary: string;
            last_seen: string;
          }>
        >("/list-peers", {
          scope: "machine",
          cwd: "/",
          git_root: null,
        });

        console.log("\nPeers:");
        for (const p of peers) {
          console.log(`  ${p.id}  PID:${p.pid}  ${p.cwd}`);
          if (p.summary) console.log(`         ${p.summary}`);
          if (p.tty) console.log(`         TTY: ${p.tty}`);
          console.log(`         Last seen: ${p.last_seen}`);
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "peers": {
    try {
      const peers = await brokerFetch<
        Array<{
          id: string;
          pid: number;
          cwd: string;
          git_root: string | null;
          tty: string | null;
          summary: string;
          last_seen: string;
        }>
      >("/list-peers", {
        scope: "machine",
        cwd: "/",
        git_root: null,
      });

      if (peers.length === 0) {
        console.log("No peers registered.");
      } else {
        for (const p of peers) {
          const parts = [`${p.id}  PID:${p.pid}  ${p.cwd}`];
          if (p.summary) parts.push(`  Summary: ${p.summary}`);
          console.log(parts.join("\n"));
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "send": {
    const toId = process.argv[3];
    const msg = process.argv.slice(4).join(" ");
    if (!toId || !msg) {
      console.error("Usage: bun cli.ts send <peer-id> <message>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
        from_id: "cli",
        to_id: toId,
        text: msg,
      });
      if (result.ok) {
        console.log(`Message sent to ${toId}`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "broadcast": {
    const msg = process.argv.slice(3).join(" ");
    if (!msg) {
      console.error("Usage: bun cli.ts broadcast <message>");
      process.exit(1);
    }
    try {
      const peers = await brokerFetch<
        Array<{ id: string; pid: number; cwd: string; summary: string }>
      >("/list-peers", {
        scope: "machine",
        cwd: "/",
        git_root: null,
      });

      if (peers.length === 0) {
        console.log("No peers registered. Message not sent.");
        break;
      }

      let sent = 0;
      let failed = 0;
      for (const p of peers) {
        try {
          const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
            from_id: "cli",
            to_id: p.id,
            text: msg,
          });
          if (result.ok) {
            sent++;
          } else {
            failed++;
            console.error(`  Failed to send to ${p.id}: ${result.error}`);
          }
        } catch (e) {
          failed++;
          console.error(`  Error sending to ${p.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      console.log(`Broadcast complete: ${sent} sent, ${failed} failed (${peers.length} peers total)`);
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "logs": {
    const limit = parseInt(process.argv[3] ?? "20", 10);
    const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(DB_PATH, { readonly: true });
      const rows = db
        .query(
          `SELECT id, from_id, to_id, text, sent_at, delivered
           FROM messages
           ORDER BY sent_at DESC
           LIMIT ?`
        )
        .all(limit) as Array<{
        id: number;
        from_id: string;
        to_id: string;
        text: string;
        sent_at: string;
        delivered: number;
      }>;
      db.close();

      if (rows.length === 0) {
        console.log("No messages found.");
        break;
      }

      // Display in chronological order (oldest first)
      rows.reverse();
      for (const r of rows) {
        const status = r.delivered ? "delivered" : "pending";
        const time = r.sent_at.replace("T", " ").replace(/\.\d+Z$/, "Z");
        console.log(`[${time}] ${r.from_id} -> ${r.to_id} (${status})`);
        console.log(`  ${r.text}`);
        console.log();
      }
      console.log(`Showing ${rows.length} message(s).`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "SQLITE_CANTOPEN" || String(e).includes("unable to open")) {
        console.log("No database found. Broker has not been started yet.");
      } else {
        console.error(`Error reading logs: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    break;
  }

  case "kill-broker": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker has ${health.peers} peer(s). Shutting down...`);
      // Find and kill the broker process on the port
      const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
      const pids = new TextDecoder()
        .decode(proc.stdout)
        .trim()
        .split("\n")
        .filter((p) => p);
      for (const pid of pids) {
        process.kill(parseInt(pid), "SIGTERM");
      }
      console.log("Broker stopped.");
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  default:
    console.log(`claude-peers CLI

Usage:
  bun cli.ts status          Show broker status and all peers
  bun cli.ts peers           List all peers
  bun cli.ts send <id> <msg> Send a message to a peer
  bun cli.ts broadcast <msg> Send a message to all peers
  bun cli.ts logs [N]        Show last N messages (default: 20)
  bun cli.ts kill-broker     Stop the broker daemon`);
}
