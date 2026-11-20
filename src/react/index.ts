"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useConvex } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import useSingleFlight from "./useSingleFlight.js";

// Interface in your Convex app /convex directory that implements these
// functions by calling into the presence component, e.g., like this:
//
// export const presence = new Presence(components.presence);
//
// export const heartbeat = mutation({
//   args: { roomId: v.string(), userId: v.string(), sessionId: v.string(), interval: v.number() },
//   handler: async (ctx, { roomId, userId, sessionId, interval }) => {
//     // TODO: Add your auth checks here.
//     return await presence.heartbeat(ctx, roomId, userId, sessionId, interval);
//   },
// });
//
// export const list = query({
//   args: { roomToken: v.string() },
//   handler: async (ctx, { roomToken }) => {
//     // Avoid adding per-user reads so all subscriptions can share same cache.
//     return await presence.list(ctx, roomToken);
//   },
// });
//
// export const disconnect = mutation({
//   args: { sessionToken: v.string() },
//   handler: async (ctx, { sessionToken }) => {
//     // Can't check auth here because it's called over http from sendBeacon.
//     return await presence.disconnect(ctx, sessionToken);
//   },
// });
export interface PresenceAPI {
  list: FunctionReference<
    "query",
    "public",
    { roomToken: string },
    PresenceState[]
  >;
  heartbeat: FunctionReference<
    "mutation",
    "public",
    { roomId: string; userId: string; sessionId: string; interval: number },
    { roomToken: string; sessionToken: string }
  >;
  disconnect: FunctionReference<"mutation", "public", { sessionToken: string }>;
}

// Presence state for a user within the given room.
export interface PresenceState {
  userId: string;
  online: boolean;
  lastDisconnected: number;
  data?: unknown;
  // Set these accordingly in your Convex app.
  // See ../../example-with-auth/convex/presence.ts for an example.
  name?: string;
  image?: string;
}

// React hook for maintaining presence state.
//
// This hook is designed to be efficient and only sends a message to users
// whenever a member joins or leaves the room, not on every heartbeat.
//
// Use of this hook requires passing in a reference to the Convex presence
// component defined in your Convex app. See ../../example/src/App.tsx for an
// example of how to incorporate this hook into your application.
export default function usePresence(
  presence: PresenceAPI,
  roomId: string,
  userId: string,
  interval: number = 10000,
  convexUrl?: string,
): PresenceState[] | undefined {
  const convex = useConvex();
  const baseUrl = convexUrl ?? convex.url;

  // Each hook instance has a stable ID. Including the room and user gives each
  // presence identity a distinct server session.
  const [instanceId] = useState(() => crypto.randomUUID());
  const sessionId = JSON.stringify([instanceId, roomId, userId]);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const sessionTokenRef = useRef<string | null>(null);
  // A newer effect may adopt the same session when only `interval` changes.
  const activeSessionIdRef = useRef<string | null>(null);

  const [roomToken, setRoomToken] = useState<string | null>(null);
  const roomTokenRef = useRef<string | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const heartbeat = useSingleFlight(useMutation(presence.heartbeat));
  const disconnect = useMutation(presence.disconnect);
  const disconnectPath = getFunctionName(presence.disconnect);

  useEffect(() => {
    // The heartbeat effect cleans up the old session.
    sessionTokenRef.current = null;
    roomTokenRef.current = null;
    setSessionToken(null);
    setRoomToken(null);
  }, [roomId, userId]);

  useEffect(() => {
    // Update refs whenever tokens change.
    sessionTokenRef.current = sessionToken;
    roomTokenRef.current = roomToken;
  }, [sessionToken, roomToken]);

  useEffect(() => {
    let canceled = false;
    activeSessionIdRef.current = sessionId;

    const disconnectIfOrphaned = (token: string) => {
      queueMicrotask(() => {
        if (activeSessionIdRef.current !== sessionId) {
          void disconnect({ sessionToken: token });
        }
      });
    };

    // Periodic heartbeats.
    const sendHeartbeat = async () => {
      const result = await heartbeat({ roomId, userId, sessionId, interval });
      if (canceled) {
        disconnectIfOrphaned(result.sessionToken);
        return;
      }
      setRoomToken(result.roomToken);
      setSessionToken(result.sessionToken);
    };

    // Send initial heartbeat
    void sendHeartbeat();

    // Clear any existing interval before setting a new one
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    intervalRef.current = setInterval(sendHeartbeat, interval);

    // Handle page unload.
    const handleUnload = () => {
      if (sessionTokenRef.current) {
        const blob = new Blob(
          [
            JSON.stringify({
              path: disconnectPath,
              args: { sessionToken: sessionTokenRef.current },
            }),
          ],
          {
            type: "application/json",
          },
        );
        navigator.sendBeacon(`${baseUrl}/api/mutation`, blob);
      }
    };
    window.addEventListener("beforeunload", handleUnload);

    // Handle visibility changes.
    const handleVisibility = async () => {
      if (document.hidden) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        if (sessionTokenRef.current) {
          await disconnect({ sessionToken: sessionTokenRef.current });
        }
      } else {
        void sendHeartbeat();
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
        }
        intervalRef.current = setInterval(sendHeartbeat, interval);
      }
    };
    const wrappedHandleVisibility = () => {
      handleVisibility().catch(console.error);
    };
    document.addEventListener("visibilitychange", wrappedHandleVisibility);

    // Cleanup.
    return () => {
      canceled = true;
      activeSessionIdRef.current = null;
      const token = sessionTokenRef.current;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      document.removeEventListener("visibilitychange", wrappedHandleVisibility);
      window.removeEventListener("beforeunload", handleUnload);
      if (token) {
        disconnectIfOrphaned(token);
      }
    };
  }, [
    heartbeat,
    disconnect,
    disconnectPath,
    roomId,
    userId,
    baseUrl,
    interval,
    sessionId,
  ]);

  const state = useQuery(presence.list, roomToken ? { roomToken } : "skip");
  return useMemo(
    () =>
      state?.slice().sort((a, b) => {
        if (a.userId === userId) return -1;
        if (b.userId === userId) return 1;
        return 0;
      }),
    [state, userId],
  );
}
