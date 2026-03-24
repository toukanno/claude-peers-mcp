/**
 * Broker integration tests
 *
 * Spawns a real broker on a random high port with a temporary SQLite DB,
 * then exercises the HTTP API directly. No external services are called.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import type {
  Peer,
  RegisterResponse,
  PollMessagesResponse,
} from "../shared/types.ts";

// --- Helpers ---

const TEST_PORT = 17800 + Math.floor(Math.random() * 1000);
const TEST_DB = join(tmpdir(), `claude-peers-test-${TEST_PORT}.db`);
const BROKER_URL = `http://127.0.0.1:${TEST_PORT}`;

let brokerProc: Subprocess;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : {};
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

async function waitForBroker(maxMs = 10000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BROKER_URL}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Broker did not start in time");
}

// --- Lifecycle ---

beforeAll(async () => {
  brokerProc = Bun.spawn(["bun", join(import.meta.dir, "..", "broker.ts")], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(TEST_PORT),
      CLAUDE_PEERS_DB: TEST_DB,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForBroker();
});

afterAll(() => {
  try {
    brokerProc.kill();
  } catch {
    // already exited
  }
  try {
    unlinkSync(TEST_DB);
    unlinkSync(TEST_DB + "-wal");
    unlinkSync(TEST_DB + "-shm");
  } catch {
    // may not exist
  }
});

// --- Tests ---

describe("Broker: Health", () => {
  test("GET /health returns ok", async () => {
    const data = await api<{ status: string; peers: number }>("/health");
    expect(data.status).toBe("ok");
    expect(typeof data.peers).toBe("number");
  });

  test("GET / returns text", async () => {
    const res = await fetch(BROKER_URL + "/");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("claude-peers broker");
  });
});

describe("Broker: SQLite database initialisation", () => {
  test("database file is created with correct tables", () => {
    const db = new Database(TEST_DB, { readonly: true });
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("peers");
    expect(names).toContain("messages");
    db.close();
  });

  test("peers table has expected columns", () => {
    const db = new Database(TEST_DB, { readonly: true });
    const cols = db.query("PRAGMA table_info(peers)").all() as {
      name: string;
    }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("pid");
    expect(colNames).toContain("cwd");
    expect(colNames).toContain("git_root");
    expect(colNames).toContain("tty");
    expect(colNames).toContain("summary");
    expect(colNames).toContain("registered_at");
    expect(colNames).toContain("last_seen");
    db.close();
  });

  test("messages table has expected columns", () => {
    const db = new Database(TEST_DB, { readonly: true });
    const cols = db.query("PRAGMA table_info(messages)").all() as {
      name: string;
    }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("from_id");
    expect(colNames).toContain("to_id");
    expect(colNames).toContain("text");
    expect(colNames).toContain("sent_at");
    expect(colNames).toContain("delivered");
    db.close();
  });
});

describe("Broker: Peer registration", () => {
  let peerId: string;

  test("POST /register returns an id", async () => {
    const res = await api<RegisterResponse>("/register", {
      pid: process.pid,
      cwd: "/tmp/test-workspace",
      git_root: null,
      tty: null,
      summary: "running tests",
    });
    expect(typeof res.id).toBe("string");
    expect(res.id.length).toBe(8);
    peerId = res.id;
  });

  test("registered peer appears in /list-peers (scope: machine)", async () => {
    const peers = await api<Peer[]>("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
    const found = peers.find((p) => p.id === peerId);
    expect(found).toBeDefined();
    expect(found!.cwd).toBe("/tmp/test-workspace");
    expect(found!.summary).toBe("running tests");
  });

  test("re-registration with same PID replaces old entry", async () => {
    const res2 = await api<RegisterResponse>("/register", {
      pid: process.pid,
      cwd: "/tmp/test-workspace-2",
      git_root: null,
      tty: null,
      summary: "re-registered",
    });
    expect(res2.id).not.toBe(peerId);

    const peers = await api<Peer[]>("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
    const old = peers.find((p) => p.id === peerId);
    expect(old).toBeUndefined();
    const fresh = peers.find((p) => p.id === res2.id);
    expect(fresh).toBeDefined();
    expect(fresh!.summary).toBe("re-registered");

    // Update peerId for subsequent tests
    peerId = res2.id;
  });

  test("POST /unregister removes the peer", async () => {
    await api<{ ok: boolean }>("/unregister", { id: peerId });
    const peers = await api<Peer[]>("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
    const found = peers.find((p) => p.id === peerId);
    expect(found).toBeUndefined();
  });
});

describe("Broker: Summary and heartbeat", () => {
  let peerId: string;

  test("set-summary updates the peer's summary", async () => {
    const reg = await api<RegisterResponse>("/register", {
      pid: process.pid,
      cwd: "/tmp/summary-test",
      git_root: null,
      tty: null,
      summary: "initial",
    });
    peerId = reg.id;

    await api<{ ok: boolean }>("/set-summary", {
      id: peerId,
      summary: "updated summary",
    });

    const peers = await api<Peer[]>("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
    const found = peers.find((p) => p.id === peerId);
    expect(found!.summary).toBe("updated summary");
  });

  test("heartbeat updates last_seen", async () => {
    const peersBefore = await api<Peer[]>("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
    const before = peersBefore.find((p) => p.id === peerId)!.last_seen;

    // Small delay so timestamp changes
    await new Promise((r) => setTimeout(r, 50));

    await api<{ ok: boolean }>("/heartbeat", { id: peerId });

    const peersAfter = await api<Peer[]>("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
    const after = peersAfter.find((p) => p.id === peerId)!.last_seen;
    expect(after >= before).toBe(true);

    // Cleanup
    await api<{ ok: boolean }>("/unregister", { id: peerId });
  });
});

describe("Broker: List peers scoping", () => {
  let peerA: string;
  let peerB: string;
  // Spawn real background processes so the broker's PID-alive check passes
  let helperA: ChildProcess;
  let helperB: ChildProcess;

  beforeAll(async () => {
    helperA = nodeSpawn("sleep", ["300"], { stdio: "ignore", detached: true });
    helperB = nodeSpawn("sleep", ["300"], { stdio: "ignore", detached: true });

    const regA = await api<RegisterResponse>("/register", {
      pid: helperA.pid!,
      cwd: "/projects/alpha",
      git_root: "/projects/alpha",
      tty: null,
      summary: "peer A",
    });
    peerA = regA.id;

    const regB = await api<RegisterResponse>("/register", {
      pid: helperB.pid!,
      cwd: "/projects/beta",
      git_root: "/projects/beta",
      tty: null,
      summary: "peer B",
    });
    peerB = regB.id;
  });

  afterAll(async () => {
    await api<{ ok: boolean }>("/unregister", { id: peerA });
    await api<{ ok: boolean }>("/unregister", { id: peerB });
    helperA.kill();
    helperB.kill();
  });

  test("scope=machine returns all peers", async () => {
    const peers = await api<Peer[]>("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
    const ids = peers.map((p) => p.id);
    expect(ids).toContain(peerA);
    expect(ids).toContain(peerB);
  });

  test("scope=directory filters by cwd", async () => {
    const peers = await api<Peer[]>("/list-peers", {
      scope: "directory",
      cwd: "/projects/alpha",
      git_root: null,
    });
    const ids = peers.map((p) => p.id);
    expect(ids).toContain(peerA);
    expect(ids).not.toContain(peerB);
  });

  test("scope=repo filters by git_root", async () => {
    const peers = await api<Peer[]>("/list-peers", {
      scope: "repo",
      cwd: "/projects/beta",
      git_root: "/projects/beta",
    });
    const ids = peers.map((p) => p.id);
    expect(ids).toContain(peerB);
    expect(ids).not.toContain(peerA);
  });

  test("exclude_id filters out the requesting peer", async () => {
    const peers = await api<Peer[]>("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
      exclude_id: peerA,
    });
    const ids = peers.map((p) => p.id);
    expect(ids).not.toContain(peerA);
    expect(ids).toContain(peerB);
  });
});

describe("Broker: Messaging", () => {
  let sender: string;
  let receiver: string;
  let helperS: ChildProcess;
  let helperR: ChildProcess;

  beforeAll(async () => {
    helperS = nodeSpawn("sleep", ["300"], { stdio: "ignore", detached: true });
    helperR = nodeSpawn("sleep", ["300"], { stdio: "ignore", detached: true });

    const regS = await api<RegisterResponse>("/register", {
      pid: helperS.pid!,
      cwd: "/tmp/msg-sender",
      git_root: null,
      tty: null,
      summary: "sender",
    });
    sender = regS.id;

    const regR = await api<RegisterResponse>("/register", {
      pid: helperR.pid!,
      cwd: "/tmp/msg-receiver",
      git_root: null,
      tty: null,
      summary: "receiver",
    });
    receiver = regR.id;
  });

  afterAll(async () => {
    await api<{ ok: boolean }>("/unregister", { id: sender });
    await api<{ ok: boolean }>("/unregister", { id: receiver });
    helperS.kill();
    helperR.kill();
  });

  test("send-message to valid peer returns ok", async () => {
    const res = await api<{ ok: boolean }>("/send-message", {
      from_id: sender,
      to_id: receiver,
      text: "hello from test",
    });
    expect(res.ok).toBe(true);
  });

  test("send-message to invalid peer returns error", async () => {
    const res = await api<{ ok: boolean; error?: string }>("/send-message", {
      from_id: sender,
      to_id: "nonexistent",
      text: "should fail",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not found");
  });

  test("poll-messages retrieves undelivered messages", async () => {
    const res = await api<PollMessagesResponse>("/poll-messages", {
      id: receiver,
    });
    expect(res.messages.length).toBeGreaterThanOrEqual(1);
    const msg = res.messages.find((m) => m.text === "hello from test");
    expect(msg).toBeDefined();
    expect(msg!.from_id).toBe(sender);
    expect(msg!.to_id).toBe(receiver);
  });

  test("messages are marked as delivered after polling", async () => {
    const res = await api<PollMessagesResponse>("/poll-messages", {
      id: receiver,
    });
    // The "hello from test" message should not appear again
    const msg = res.messages.find((m) => m.text === "hello from test");
    expect(msg).toBeUndefined();
  });

  test("multiple messages are delivered in order", async () => {
    await api<{ ok: boolean }>("/send-message", {
      from_id: sender,
      to_id: receiver,
      text: "msg-1",
    });
    await api<{ ok: boolean }>("/send-message", {
      from_id: sender,
      to_id: receiver,
      text: "msg-2",
    });
    await api<{ ok: boolean }>("/send-message", {
      from_id: sender,
      to_id: receiver,
      text: "msg-3",
    });

    const res = await api<PollMessagesResponse>("/poll-messages", {
      id: receiver,
    });
    expect(res.messages.length).toBe(3);
    expect(res.messages[0]!.text).toBe("msg-1");
    expect(res.messages[1]!.text).toBe("msg-2");
    expect(res.messages[2]!.text).toBe("msg-3");
  });
});

describe("Broker: Error handling", () => {
  test("unknown route returns 404", async () => {
    const res = await fetch(`${BROKER_URL}/does-not-exist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  test("invalid JSON returns 500", async () => {
    const res = await fetch(`${BROKER_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(500);
  });
});
