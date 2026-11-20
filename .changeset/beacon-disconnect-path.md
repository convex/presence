---
"@convex-dev/presence": patch
---

`usePresence` now disconnects on tab close (web) and on going to the background
(React Native) through the `disconnect` function it was given, instead of
`presence:disconnect`, so this works when the presence functions live outside
`convex/presence.ts`.
