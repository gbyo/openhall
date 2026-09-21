# OpenHall UI 0.3 foundation

OpenHall's canonical frontend design system is:

> shadcn/ui `base-maia` → Base UI → Tailwind CSS v4 → Hugeicons → Public Sans

`apps/web/components.json`, `apps/web/src/index.css`, and
`apps/web/src/components/ui/*` are the source of truth. Commodity controls are generated from the
current shadcn Base UI registry and imported from `@/components/ui/*`. Product code must not add a
parallel OpenHall button, field, dialog, menu, table, card, or sidebar API.

## Theme

- The application canvas is `--background` and is white in the supported light theme.
- Blue is applied through `--primary`, `--ring`, and `--sidebar-primary` rather than feature hex
  values.
- Neutral surfaces use `--card`, `--popover`, `--muted`, `--accent`, and sidebar tokens.
- Destructive, success, warning, and information states retain separate semantic roles.
- Public Sans is the product typeface. Hugeicons is the product icon set.
- Stock Maia radii, control heights, spacing, shadows, focus rings, borders, and interaction states
  are retained.
- OpenHall does not expose a dark-mode setting.

`apps/web/src/design-system/tokens.css` now contains only temporary compatibility aliases for
legacy screens. New UI must use shadcn semantic variables and utilities directly. Those aliases
are removed when their remaining consumers are migrated in the legacy-retirement phase.

## Component selection

Use components by interaction semantics:

| Need                                         | Canonical component                                     |
| -------------------------------------------- | ------------------------------------------------------- |
| Explicit command                             | `Button`                                                |
| Closely related commands                     | `ButtonGroup`                                           |
| Form structure and errors                    | `Field`, `FieldGroup`, `FieldSet`, `FieldError`         |
| Search or input with local status            | `InputGroup`                                            |
| Small fixed choice set                       | `Select` or `NativeSelect`                              |
| Searchable people/resources                  | `Combobox`                                              |
| Short bounded create/edit task               | `Dialog`; `Drawer` when the narrow-screen task benefits |
| Secondary detail that preserves list context | `Sheet`                                                 |
| Consequential confirmation                   | `AlertDialog`                                           |
| Secondary row/account actions                | `DropdownMenu`                                          |
| Sibling views                                | `Tabs`                                                  |
| Readable action-oriented list                | `Item` / `ItemGroup`                                    |
| Simple tabular relationship                  | `Table`                                                 |
| Dense interactive data                       | shadcn `Table` + TanStack Table composition             |
| Bounded object or operational group          | `Card`                                                  |
| Initial loading                              | shape-correct `Skeleton`                                |
| Local indeterminate work                     | `Spinner`                                               |
| Real measurable progress                     | `Progress`                                              |
| Confirmed zero result                        | `Empty`                                                 |
| Persistent important feedback                | `Alert`                                                 |
| Brief noncritical confirmation               | Sonner `Toast`                                          |

Date Picker is intentionally not a separate registry primitive. Per shadcn's documented Base UI
composition it is `Popover` + `Calendar` + `Button`. Data Table is likewise a documented
composition rather than another generic grid component.

## Async interaction contract

An initiating button remains present during a command and composes the real `Spinner` with a
verb-specific label:

```tsx
<Button disabled={isPending} aria-busy={isPending}>
  {isPending ? <Spinner data-icon="inline-start" /> : null}
  {isPending ? 'Saving…' : 'Save'}
</Button>
```

- Disable only duplicate or conflicting actions.
- Keep Dialogs and Sheets open while submitting and preserve the draft on failure.
- Close only after confirmed success, then restore focus to the logical trigger.
- Preserve the logical command and idempotency key for uncertain outcomes; offer **Check again**.
- Keep confirmed content visible during background refresh.
- Use `Progress` only for a real bounded value.
- Render `Empty` only after loading has completed and zero results are confirmed.
- Use `FieldError` for a field, `Alert` for persistent/general failure, Toast for a brief
  noncritical confirmation, and `AlertDialog` only for consequential confirmation.

## Registry inventory

Installed for current or planned UI 0.3 workflows:

- identity/navigation: Avatar, Badge, Breadcrumb, Dropdown Menu, Pagination, Sidebar, Tooltip;
- forms: Button, Button Group, Checkbox, Combobox, Field, Input, Input Group, Native Select,
  Radio Group, Select, Switch, Textarea, Toggle, Toggle Group;
- task surfaces: Alert Dialog, Dialog, Drawer, Popover, Sheet;
- content: Calendar, Card, Collapsible, Empty, Item, Progress, Scroll Area, Separator, Skeleton,
  Spinner, Table, Tabs, Toast;
- guided setup: Questionnaire.

Not currently applicable and therefore not installed merely for coverage: Attachment, Bubble,
Carousel, Chart, Hover Card, Input OTP, Marker, Menubar, Message, Message Scroller, Navigation
Menu, Resizable, Slider. Accordion, Command, and Context Menu should be added only when a shipped
workflow establishes a real need. This inventory is a decision audit, not a requirement to display
every catalog item.

## Product composition boundary

OpenHall may own a component when it represents a WayPass concept: `SchoolSwitcher`, `UserMenu`,
`PassStateBadge`, `ConflictNotice`, `ConnectionStatus`, `StudentPassCard`, or `MovementRoute`.
Those compositions use the registry primitives internally. Names such as `OHButton`, `OHSelect`,
`OHDialog`, and `OHTable` are prohibited.

Legacy modules under `apps/web/src/design-system/primitives` remain migration-only until their
production consumers move in later UI 0.3 PRs. They must not receive new features or become
dependencies of redesigned surfaces.

## Development reference

Run the web app and open `http://localhost:5173/__ui`. The route is development-only and renders
the actual generated components for theme, form, async, feedback, list/table/card, date-picker,
Dialog, Drawer, Sheet, menu, tooltip, and destructive-confirmation states. `/__wayfinder` remains a
temporary compatibility alias for existing tooling and is not the design-system identity.

Run browser coverage with `pnpm test:ui` from the repository root. The suite checks semantic
interactions, serious/critical axe results, keyboard focus restoration, reduced motion, forced
colors, 320-pixel reflow, Chromebook sizing, and 200% text.
