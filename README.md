# Presence Convex Component

[![npm version](https://badge.fury.io/js/@convex-dev%2Fpresence.svg)](https://badge.fury.io/js/@convex-dev%2Fpresence)

A Convex component for managing presence functionality, i.e., a live-updating
list of users in a "room" including their status for when they were last online.

![Demo of presence component](https://raw.githubusercontent.com/convex/presence/main/presence.gif)

It can be tricky to implement presence efficiently, without any polling and
without re-running queries every time a user sends a heartbeat message. This
component implements presence via a single deployment-wide worker (a
[batch-worker](https://github.com/convex/batch-worker) loop) that sleeps
until the next session timeout is due, such that clients only receive updates
when a user joins or leaves the room and heartbeats don't schedule any work.

The most common use case for this component is via the usePresence hook, which
takes care of sending heartbeart messages to the server and gracefully
disconnecting a user when the tab is closed.

[![The Presence Component Video](https://img.youtube.com/vi/ZZTm_NtWJrs/0.jpg)](https://www.youtube.com/watch?v=ZZTm_NtWJrs)

## Installation

```bash
npm install @convex-dev/presence
```

## Examples

See the `example` directory for a simple example of how to use this component.
The `example-with-auth` directory shows how to use the component with
authentication.

There's a hosted version of `example-with-auth` at
https://presence.previews.convex.dev.

## Usage

First, add the component to your Convex app:

`convex/convex.config.ts`

```ts
import { defineApp } from "convex/server";
import presence from "@convex-dev/presence/convex.config.js";

const app = defineApp();
app.use(presence);
export default app;
```

`convex/presence.ts`

```ts
import { mutation, query } from "./_generated/server";
import { components } from "./_generated/api";
import { v } from "convex/values";
import { Presence } from "@convex-dev/presence";

export const presence = new Presence(components.presence);

export const heartbeat = mutation({
  args: {
    roomId: v.string(),
    userId: v.string(),
    sessionId: v.string(),
    interval: v.number(),
  },
  handler: async (ctx, { roomId, userId, sessionId, interval }) => {
    // TODO: Add your auth checks here.
    return await presence.heartbeat(ctx, roomId, userId, sessionId, interval);
  },
});

export const list = query({
  args: { roomToken: v.string() },
  handler: async (ctx, { roomToken }) => {
    // Avoid adding per-user reads so all subscriptions can share same cache.
    return await presence.list(ctx, roomToken);
  },
});

export const disconnect = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    // Can't check auth here because it's called over http from sendBeacon.
    return await presence.disconnect(ctx, sessionToken);
  },
});
```

A `Presence` React component can be instantiated from your client code like
this:

`src/App.tsx`

```tsx
import { api } from "../convex/_generated/api";
import usePresence from "@convex-dev/presence/react";
import FacePile from "@convex-dev/presence/facepile";

export default function App(): React.ReactElement {
  const [name] = useState(() => "User " + Math.floor(Math.random() * 10000));
  const presenceState = usePresence(api.presence, "my-chat-room", name);

  return (
    <main>
      <FacePile presenceState={presenceState ?? []} />
    </main>
  );
}
```

This uses the basic `FacePile` component included with this package but you can
easily copy this code and use the `usePresence` hook directly to implement your
own styling.

### React Native support

If you're using React Native, install these optional dependencies:

```sh
npx expo install react-native expo-crypto
```

and then import the `usePresence` hook from `@convex-dev/presence/react-native`:

```ts
import { usePresence } from "@convex-dev/presence/react-native";
```

_Note: The <FacePile /> component currently doesn't have a React Native
equivalent, but you can easily create your own._

## Additional functionality

The component interface for the `Presence` class is defined in
`src/client/index.ts`. It includes additional functions for maintaining presence
state and for querying presence for a given user or room.

e.g., you can use the `listUser` function to check if a user is online in any
room.

Reach out or join the [Convex Discord Community](https://convex.dev/community)
if you have any questions or feedback!
