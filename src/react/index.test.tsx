// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from "vitest";
import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { makeFunctionReference } from "convex/server";
import usePresence, { type PresenceAPI } from "./index.js";

// Response latency of the fake backend, long enough that effect cleanups
// deterministically run while a heartbeat is still in flight.
const LATENCY = 100;

// A fake backend mirroring the presence component's semantics: state changes
// apply in dispatch order (Convex runs a client's mutations in order) while
// responses arrive after a delay; heartbeat reuses the session's token while
// the session is alive and mints a new one if it was disconnected.
const backend = vi.hoisted(() => {
  let nextToken = 0;
  const sessions = new Map<string, string>(); // sessionId -> live token
  const issuedTokens = new Set<string>();
  const disconnectedTokens = new Set<string>();
  const heartbeat = async ({ sessionId }: { sessionId: string }) => {
    let sessionToken = sessions.get(sessionId);
    if (sessionToken === undefined) {
      sessionToken = `token-${nextToken++}-${sessionId}`;
      sessions.set(sessionId, sessionToken);
    }
    issuedTokens.add(sessionToken);
    await new Promise((resolve) => setTimeout(resolve, LATENCY));
    return { roomToken: "room-token", sessionToken };
  };
  const disconnect = async ({ sessionToken }: { sessionToken: string }) => {
    disconnectedTokens.add(sessionToken);
    for (const [sessionId, token] of sessions) {
      if (token === sessionToken) {
        sessions.delete(sessionId);
      }
    }
  };
  const reset = () => {
    nextToken = 0;
    sessions.clear();
    issuedTokens.clear();
    disconnectedTokens.clear();
  };
  return {
    sessions,
    issuedTokens,
    disconnectedTokens,
    heartbeat,
    disconnect,
    reset,
  };
});

vi.mock("convex/react", () => ({
  useConvex: () => ({ url: "https://test.convex.cloud" }),
  // Identities must be stable across renders, like the real useMutation.
  useMutation: (ref: unknown) =>
    ref === "heartbeat" ? backend.heartbeat : backend.disconnect,
  useQuery: () => undefined,
}));

const presenceApi = {
  list: "list",
  heartbeat: "heartbeat",
  disconnect: "disconnect",
} as unknown as PresenceAPI;

function Component({
  roomId = "room1",
  userId = "user1",
  interval = 10000,
}: {
  roomId?: string;
  userId?: string;
  interval?: number;
}) {
  usePresence(presenceApi, roomId, userId, interval);
  return null;
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  backend.reset();
});

const sleep = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return createRoot(container);
}

test("strict mode reuses one session and disconnects it on unmount", async () => {
  const root = mount();

  // Strict mode mounts, unmounts, and remounts the component. The remount
  // cleanup runs before the first heartbeat's response (and thus its session
  // token) has arrived.
  await act(async () => {
    root.render(
      <StrictMode>
        <Component />
      </StrictMode>,
    );
  });

  // Let in-flight heartbeats resolve and their continuations run.
  await sleep(5 * LATENCY);

  // Both Strict Mode effect instances use the same stable session.
  expect(backend.issuedTokens.size).toBe(1);
  expect(backend.sessions.size).toBe(1);

  await act(async () => {
    root.unmount();
  });
  await sleep(LATENCY);

  // Every session the backend ever created must be disconnected by now.
  expect(backend.sessions.size).toBe(0);
  expect([...backend.disconnectedTokens].sort()).toEqual(
    [...backend.issuedTokens].sort(),
  );
});

test("a room change disconnects an in-flight session", async () => {
  const root = mount();

  await act(async () => {
    root.render(<Component roomId="room1" />);
  });

  // Change rooms before the first heartbeat response supplies its token.
  await act(async () => {
    root.render(<Component roomId="room2" />);
  });
  await sleep(5 * LATENCY);

  expect(backend.issuedTokens.size).toBe(2);
  expect(backend.disconnectedTokens.size).toBe(1);
  expect(backend.sessions.size).toBe(1);

  await act(async () => {
    root.unmount();
  });
  await sleep(LATENCY);
  expect(backend.sessions.size).toBe(0);
  expect([...backend.disconnectedTokens].sort()).toEqual(
    [...backend.issuedTokens].sort(),
  );
});

test("a session taken over by a re-run effect is not disconnected", async () => {
  const root = mount();

  await act(async () => {
    root.render(<Component interval={10000} />);
  });
  // Let the mount settle: one live session with its token stored.
  await sleep(5 * LATENCY);
  expect(backend.sessions.size).toBe(1);

  // Changing `interval` re-runs the heartbeat effect WITHOUT rotating the
  // sessionId, so the next effect instance heartbeats the same session...
  await act(async () => {
    root.render(<Component interval={20000} />);
  });
  // ...and before that heartbeat's response arrives, a second change cleans
  // that instance up too. Its canceled continuation must recognize that the
  // newest instance still owns the session and must NOT disconnect it.
  await sleep(LATENCY / 2);
  await act(async () => {
    root.render(<Component interval={30000} />);
  });
  await sleep(5 * LATENCY);

  // The user still has the original live session. Changing only the heartbeat
  // interval must not disconnect and recreate it.
  expect(backend.sessions.size).toBe(1);
  expect(backend.issuedTokens.size).toBe(1);
  expect(backend.disconnectedTokens.size).toBe(0);

  await act(async () => {
    root.unmount();
  });
  await sleep(LATENCY);
  expect(backend.sessions.size).toBe(0);
  expect([...backend.disconnectedTokens].sort()).toEqual(
    [...backend.issuedTokens].sort(),
  );
});

test("the unload beacon calls the disconnect function it was given", async () => {
  const sendBeacon = vi.fn((_url: string, _data: Blob) => true);
  Object.defineProperty(navigator, "sendBeacon", {
    value: sendBeacon,
    configurable: true,
  });
  // The app's functions live in convex/rooms/presence.ts, not convex/presence.ts.
  const presence = {
    ...presenceApi,
    disconnect: makeFunctionReference<"mutation">("rooms/presence:disconnect"),
  } as unknown as PresenceAPI;
  function Room() {
    usePresence(presence, "room1", "user1");
    return null;
  }
  const root = mount();
  await act(async () => {
    root.render(<Room />);
  });
  await sleep(5 * LATENCY);

  window.dispatchEvent(new Event("beforeunload"));

  expect(sendBeacon).toHaveBeenCalledTimes(1);
  const [, blob] = sendBeacon.mock.calls[0]!;
  expect(JSON.parse(await blob.text()).path).toBe("rooms/presence:disconnect");

  await act(async () => {
    root.unmount();
  });
});
