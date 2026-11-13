// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { usePresence, type PresenceAPI } from "./index.js";

const appState = vi.hoisted(() => {
  let listener: ((state: string) => void) | undefined;
  return {
    addEventListener: vi.fn(
      (_event: string, nextListener: (state: string) => void) => {
        listener = nextListener;
        return { remove: vi.fn() };
      },
    ),
    emit: (state: string) => listener?.(state),
    reset: () => {
      listener = undefined;
    },
  };
});

const backend = vi.hoisted(() => ({
  heartbeat: vi.fn(() => new Promise<never>(() => {})),
  disconnect: vi.fn(async () => null),
}));

vi.mock("convex/react", () => ({
  useConvex: () => ({ url: "https://test.convex.cloud" }),
  useMutation: (ref: unknown) =>
    ref === "heartbeat" ? backend.heartbeat : backend.disconnect,
  useQuery: () => undefined,
}));

vi.mock("expo-crypto", () => ({
  randomUUID: () => "instance-id",
}));

vi.mock("react-native", () => ({
  AppState: { addEventListener: appState.addEventListener },
}));

const presenceApi = {
  list: "list",
  heartbeat: "heartbeat",
  disconnect: "disconnect",
} as unknown as PresenceAPI;

function Component() {
  usePresence(presenceApi, "room", "user");
  return null;
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.useFakeTimers();
  appState.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

test("returning from inactive replaces the heartbeat interval", async () => {
  const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
  const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Component />));

  const initialInterval =
    setIntervalSpy.mock.results[setIntervalSpy.mock.results.length - 1]?.value;

  act(() => appState.emit("inactive"));
  expect(clearIntervalSpy).not.toHaveBeenCalled();

  act(() => appState.emit("active"));
  expect(clearIntervalSpy).toHaveBeenCalledWith(initialInterval);
  const replacementInterval =
    setIntervalSpy.mock.results[setIntervalSpy.mock.results.length - 1]?.value;
  expect(replacementInterval).not.toBe(initialInterval);

  await act(async () => root.unmount());
  expect(clearIntervalSpy).toHaveBeenCalledWith(replacementInterval);
});

test("going to the background calls the disconnect function it was given", async () => {
  backend.heartbeat.mockResolvedValueOnce({
    roomToken: "room-token",
    sessionToken: "session-token",
  } as never);
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null));
  // The app's functions live in convex/rooms/presence.ts, not convex/presence.ts.
  const presence = {
    ...presenceApi,
    disconnect: makeFunctionReference<"mutation">("rooms/presence:disconnect"),
  } as unknown as PresenceAPI;
  function Room() {
    usePresence(presence, "room", "user");
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Room />));

  act(() => appState.emit("background"));

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [, init] = fetchSpy.mock.calls[0]!;
  expect(JSON.parse(init!.body as string).path).toBe(
    "rooms/presence:disconnect",
  );

  fetchSpy.mockRestore();
  await act(async () => root.unmount());
});
