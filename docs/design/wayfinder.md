# Wayfinder v0.2 (legacy)

Wayfinder is the legacy OpenHall visual system. It is not the source of truth for new or redesigned
product UI.

The canonical UI 0.3 foundation is documented in [ui-foundation.md](./ui-foundation.md): shadcn/ui
`base-maia` on Base UI, Tailwind CSS v4, Hugeicons, Public Sans, a white canvas, and blue semantic
theme tokens.

The existing `apps/web/src/design-system/primitives`, `wf-*` classes, and compatibility variables
remain only while production screens are migrated in the ordered UI 0.3 PRs. Do not extend them or
copy their presentation into new features. Preserve genuine WayPass domain semantics when moving a
composition; replace commodity primitives with the generated components in
`apps/web/src/components/ui`.
