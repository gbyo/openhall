# Wayfinder Design & UX Foundation v0.2

Wayfinder is the visual and interaction foundation for the future WayPass experience. This document records the normative decisions supplied with the implementation brief and explains how the reference environment is used. It is not Phase 9 product implementation and does not define API or database behavior.

## Product principles

These rules outrank component-level implementation guidance:

1. The interface only visualizes movement evidence OpenHall actually has.
2. The server is authoritative.
3. The next meaningful action should be obvious.
4. Students should not feel like they are using enterprise software.
5. There is no silent offline mutation queue.
6. WayPass never fabricates movement.
7. The visual language must feel specific to WayPass, not like generic AI/SaaS software.

Wayfinder should feel clear, grounded, warm, spatial, and restrained. Personality comes from Public Sans, Way blue, a warm canvas, carefully limited signal yellow, movement-route language, state hierarchy, and plain copy. It does not use gradients, glass, glow, heavy shadows, excessive rounding, decorative dashboards, or status-pill collections.

## Product semantics

WayPass distinguishes facts from intent. A `RouteStop` accepts only one of two evidence values:

- `recorded`: OpenHall received an explicit event or fact.
- `intended`: a destination or return is planned, but no movement event is implied.

There is intentionally no generic `completed` property and no representation of a student's current physical position. Lightweight passes show recorded departure, destination intent, elapsed time, and the action that the student can take. Arrival appears only for a mock workflow that includes an explicit station event.

Connectivity failures preserve the last confirmed state. Commands are not silently queued. Healthy connectivity is normally invisible; only reconnecting, stale, and unreachable states have a visible treatment.

Recovery access is persistent and non-dismissible. It is important but is not presented as a catastrophic application failure.

## Visual foundations

Semantic tokens live in `apps/web/src/design-system/tokens.css`. Components consume the token names rather than literal colors. The initial palette uses warm canvas and surface colors, dark green-black text, Way blue for primary action, green for readiness, ochre for waiting, red for danger, and signal yellow only as a small wayfinding accent.

The spacing scale is 2, 4, 8, 12, 16, 24, 32, 48, and 64 pixels. Radii range from 4 pixels for details to 16 pixels for a focal pass surface. Ordinary content uses borders without shadows. Shadow is reserved for real floating UI such as menus, popovers, and dialogs.

Public Sans is delivered from `@fontsource-variable/public-sans` as the normal variable-weight face. The app imports `wght.css`, so fonts are same-origin and no third-party request is made. System UI fonts remain in the fallback stack and the interface is usable before the font loads.

## Primitive strategy

Native HTML is used for buttons, icon buttons, text inputs, fieldsets, headings, links, and alerts where platform semantics are sufficient. React Aria Components supplies interaction behavior for SearchField, ComboBox, Select, Checkbox, Switch, Tabs, Menu, Popover, Dialog, and Tooltip. Wayfinder owns their appearance; no React Spectrum styling is used.

All controls have accessible names. Labels remain visible. Errors are associated with their inputs and do not rely on color. Dialogs provide a specific consequence, contain and restore focus, close on Escape, and have an accessible title. Tooltips are supplementary only.

## WayPass patterns

Patterns live in `apps/web/src/design-system/patterns`:

- `Route` and `RouteStop` distinguish recorded evidence from intent structurally and visually.
- `PassCard` provides presentation slots without embedding fetching or lifecycle logic.
- `DestinationRow` is a touch-comfortable task row, not a floating card.
- `QueuePosition` handles zero, singular, and plural language without inventing wait time.
- `ConflictNotice` preserves unsaved work and describes concurrent change in user language.
- `ConnectionStatus` supports reconnecting, stale, and unreachable states.
- `RecoveryBanner` persistently explains temporary break-glass access.

Static canonical student-state compositions are kept under `design-system/reference`. They have no API client and import no Phase 8 contracts.

## Development reference

Run the web app and open:

```text
http://localhost:5173/__wayfinder
```

The route is guarded by `import.meta.env.DEV` and dynamically imports the reference page. A production build does not render the reference experience; `/__wayfinder` falls through to the normal app behavior. The reference-only stylesheet and mock states are in the lazy development chunk and are tree-shaken from production.

The reference page includes foundations, primitives, WayPass patterns, all canonical student states, product truthfulness examples, and stress controls for density, example state, and constrained widths.

## Testing

Run browser checks from the repository root:

```bash
pnpm --filter @openhall/web exec playwright install chromium
pnpm test:wayfinder
```

The dedicated Playwright configuration starts only Vite. Tests cover reference smoke, serious/critical axe findings, representative keyboard interaction, 320-pixel reflow, a 1366×768 viewport, 200% text, reduced motion, and forced colors. The tests live in `apps/web/e2e-wayfinder` so Vitest does not discover them.

## Adding to Wayfinder

Add global semantic decisions only to the small foundation stylesheets (`tokens`, `reset`, `typography`, `motion`, and `utilities`). Add a native or React Aria primitive under `primitives` when it solves reusable interaction behavior. Add a pattern under `patterns` only when it expresses a WayPass product concept. Reference-only controls, mock data, and canonical compositions remain under `reference` and must not import backend contracts.

Phase 9 applies these foundations to the real product shell. Ready makes the deadline and Start pass
action dominant without a giant status surface; tracked movement gives `Route` visual priority;
completion is intentionally quiet. Student, teacher, station, operations, and administrator layouts
reuse these primitives rather than defining feature-local design systems. Connection treatment is
wired to one school-level EventSource and reports only transport health; authoritative successful
GETs, not heartbeats, update the last-confirmed time. Heavy administration routes are lazy-loaded,
while the focused student route remains free of an administrator sidebar.

Dark mode, school color themes, native applications, push notifications, and offline mutation
queues remain intentionally deferred.
