/**
 * Type definition validation tests
 *
 * Ensures the shared type interfaces are structurally correct and
 * that objects conforming to them behave as expected at runtime.
 * No external API calls are made.
 */

import { describe, test, expect } from "bun:test";
import type {
  PeerId,
  Peer,
  Message,
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
} from "../shared/types.ts";

describe("Types: Peer", () => {
  const peer: Peer = {
    id: "abc12345",
    pid: 12345,
    cwd: "/home/user/project",
    git_root: "/home/user/project",
    tty: "ttys001",
    summary: "Working on feature X",
    registered_at: "2026-03-24T00:00:00.000Z",
    last_seen: "2026-03-24T00:01:00.000Z",
  };

  test("Peer has all required fields", () => {
    expect(peer.id).toBeDefined();
    expect(peer.pid).toBeDefined();
    expect(peer.cwd).toBeDefined();
    expect(peer.summary).toBeDefined();
    expect(peer.registered_at).toBeDefined();
    expect(peer.last_seen).toBeDefined();
  });

  test("Peer nullable fields accept null", () => {
    const peerNoOptionals: Peer = {
      ...peer,
      git_root: null,
      tty: null,
    };
    expect(peerNoOptionals.git_root).toBeNull();
    expect(peerNoOptionals.tty).toBeNull();
  });

  test("PeerId is a string type", () => {
    const id: PeerId = "test1234";
    expect(typeof id).toBe("string");
  });

  test("Peer timestamps are valid ISO strings", () => {
    expect(new Date(peer.registered_at).toISOString()).toBe(peer.registered_at);
    expect(new Date(peer.last_seen).toISOString()).toBe(peer.last_seen);
  });
});

describe("Types: Message", () => {
  const message: Message = {
    id: 1,
    from_id: "sender01",
    to_id: "recv0001",
    text: "Hello, peer!",
    sent_at: "2026-03-24T00:00:00.000Z",
    delivered: false,
  };

  test("Message has all required fields", () => {
    expect(message.id).toBeDefined();
    expect(message.from_id).toBeDefined();
    expect(message.to_id).toBeDefined();
    expect(message.text).toBeDefined();
    expect(message.sent_at).toBeDefined();
    expect(typeof message.delivered).toBe("boolean");
  });

  test("Message id is numeric", () => {
    expect(typeof message.id).toBe("number");
  });

  test("Message sent_at is valid ISO string", () => {
    expect(new Date(message.sent_at).toISOString()).toBe(message.sent_at);
  });
});

describe("Types: Broker API request types", () => {
  test("RegisterRequest has correct shape", () => {
    const req: RegisterRequest = {
      pid: 99999,
      cwd: "/tmp/test",
      git_root: null,
      tty: null,
      summary: "testing",
    };
    expect(req.pid).toBe(99999);
    expect(req.cwd).toBe("/tmp/test");
    expect(req.git_root).toBeNull();
    expect(req.tty).toBeNull();
    expect(req.summary).toBe("testing");
  });

  test("RegisterResponse has id field", () => {
    const res: RegisterResponse = { id: "abcd1234" };
    expect(typeof res.id).toBe("string");
  });

  test("HeartbeatRequest has id field", () => {
    const req: HeartbeatRequest = { id: "abcd1234" };
    expect(typeof req.id).toBe("string");
  });

  test("SetSummaryRequest has id and summary", () => {
    const req: SetSummaryRequest = {
      id: "abcd1234",
      summary: "doing work",
    };
    expect(req.id).toBe("abcd1234");
    expect(req.summary).toBe("doing work");
  });

  test("ListPeersRequest accepts all scope values", () => {
    const scopes: Array<"machine" | "directory" | "repo"> = [
      "machine",
      "directory",
      "repo",
    ];
    for (const scope of scopes) {
      const req: ListPeersRequest = {
        scope,
        cwd: "/tmp",
        git_root: null,
      };
      expect(req.scope).toBe(scope);
    }
  });

  test("ListPeersRequest exclude_id is optional", () => {
    const withExclude: ListPeersRequest = {
      scope: "machine",
      cwd: "/tmp",
      git_root: null,
      exclude_id: "skip_me",
    };
    expect(withExclude.exclude_id).toBe("skip_me");

    const without: ListPeersRequest = {
      scope: "machine",
      cwd: "/tmp",
      git_root: null,
    };
    expect(without.exclude_id).toBeUndefined();
  });

  test("SendMessageRequest has from_id, to_id, text", () => {
    const req: SendMessageRequest = {
      from_id: "aaa",
      to_id: "bbb",
      text: "hi",
    };
    expect(req.from_id).toBe("aaa");
    expect(req.to_id).toBe("bbb");
    expect(req.text).toBe("hi");
  });

  test("PollMessagesRequest has id", () => {
    const req: PollMessagesRequest = { id: "abcd1234" };
    expect(typeof req.id).toBe("string");
  });

  test("PollMessagesResponse contains messages array", () => {
    const res: PollMessagesResponse = {
      messages: [
        {
          id: 1,
          from_id: "a",
          to_id: "b",
          text: "test",
          sent_at: "2026-03-24T00:00:00.000Z",
          delivered: false,
        },
      ],
    };
    expect(Array.isArray(res.messages)).toBe(true);
    expect(res.messages.length).toBe(1);
  });

  test("PollMessagesResponse can be empty", () => {
    const res: PollMessagesResponse = { messages: [] };
    expect(res.messages.length).toBe(0);
  });
});
