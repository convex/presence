import { useQuery, useMutation, useConvex } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import * as Crypto from "expo-crypto";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";

import useSingleFlight from "../react/useSingleFlight.js";

export type PresenceAPI = {
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
};

// Presence state for a user within the given room.
export type PresenceState = {
  userId: string;
  online: boolean;
  lastDisconnected: number;
};

export function usePresence(
  presence: PresenceAPI,
  roomId: string,
  userId: string,
  interval: number = 10000,
  convexUrl?: string,
) {
  const convex = useConvex();
  const baseUrl = convexUrl ?? convex.url;

  // Each hook instance has a stable ID. Including the room and user gives each
  // presence identity a distinct server session.
  const [instanceId] = useState(() => Crypto.randomUUID());
  const sessionId = JSON.stringify([instanceId, roomId, userId]);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [roomToken, setRoomToken] = useState<string | null>(null);

  const sessionTokenRef = useRef<string | null>(null);
  // A newer effect may adopt the same session when only `interval` changes.
  const activeSessionIdRef = useRef<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const heartbeat = useSingleFlight(useMutation(presence.heartbeat));
  const disconnect = useMutation(presence.disconnect);
  const disconnectPath = getFunctionName(presence.disconnect);

  const fireAndForgetDisconnect = useCallback(
    (token: string) => {
      fetch(`${baseUrl}/api/mutation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: disconnectPath,
          args: { sessionToken: token },
        }),
      }).catch(() => {});
    },
    [baseUrl, disconnectPath],
  );

  // Reset session when roomId/userId changes
  useEffect(() => {
    if (sessionTokenRef.current) {
      void disconnect({ sessionToken: sessionTokenRef.current });
    }
    sessionTokenRef.current = null;
    setSessionToken(null);
    setRoomToken(null);
  }, [roomId, userId, disconnect]);

  useEffect(() => {
    sessionTokenRef.current = sessionToken;
  }, [sessionToken]);

  useEffect(() => {
    let canceled = false;
    activeSessionIdRef.current = sessionId;

    const disconnectIfOrphaned = (token: string) => {
      queueMicrotask(() => {
        if (activeSessionIdRef.current !== sessionId) {
          fireAndForgetDisconnect(token);
        }
      });
    };

    const sendHeartbeat = async () => {
      const result = await heartbeat({ roomId, userId, sessionId, interval });
      if (canceled) {
        disconnectIfOrphaned(result.sessionToken);
        return;
      }
      setRoomToken(result.roomToken);
      setSessionToken(result.sessionToken);
    };

    // initial heartbeat + interval
    void sendHeartbeat();
    intervalRef.current = setInterval(sendHeartbeat, interval);

    // handle app state changes instead of beforeunload/visibility
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") {
        if (intervalRef.current) clearInterval(intervalRef.current);
        if (sessionTokenRef.current)
          fireAndForgetDisconnect(sessionTokenRef.current);
      } else if (state === "active") {
        void sendHeartbeat();
        // iOS can go inactive -> active without entering the background.
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
        }
        intervalRef.current = setInterval(sendHeartbeat, interval);
      }
    });

    return () => {
      canceled = true;
      activeSessionIdRef.current = null;
      const token = sessionTokenRef.current;

      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }

      subscription.remove();

      if (token) {
        disconnectIfOrphaned(token);
      }
    };
  }, [roomId, userId, sessionId, interval, heartbeat, fireAndForgetDisconnect]);

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
