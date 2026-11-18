# Changelog

## 0.4.1

### Patch Changes

- fd1fbfa: Return the typed component API from the test registration helper.

## 0.4.0

- Replaces per-session scheduled disconnects with a deployment-wide batch
  worker, increasing scalability by avoiding one scheduled function per session.
- Upgrades in place without a migration; pre-upgrade sessions get a grace
  deadline and legacy scheduled disconnects are ignored.
- Fixes React Strict Mode remount races that could briefly disconnect an active
  session.
- Prevents duplicate heartbeat intervals in React Native.

## 0.3.2

- Patches instead of re-creating timeout documents for efficiency

## 0.3.1

- Avoids self-cancelation of scheduled functions, now that mutations aren't
  allowed to cancel themselves.

## 0.3.0

- Adds /test and /\_generated/component.js entrypoints
- Drops commonjs support
- Improves source mapping for generated files
- Changes to a statically generated component API
