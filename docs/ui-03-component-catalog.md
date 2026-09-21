# OpenHall UI 0.3 shadcn catalog audit

Issue #24 deliverable. For every shadcn Maia / Base UI component, one decision:
**Use** (real shadcn implementation in production), **Not currently applicable**
(no production need yet), **Domain composition** (OpenHall-owned composition
built from shadcn primitives), or **Gap** (shadcn lacks it; rationale required).

## Primitives

| Component      | Decision                 | Representative usage                                                                                                     |
| -------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| AlertDialog    | Use                      | `features/admin/destinations/DestinationsPage.tsx` (archive confirm)                                                     |
| Alert          | Use                      | `app/auth/AuthPages.tsx` (sign-in / enrollment errors)                                                                   |
| Avatar         | Use                      | `app/school/UserMenu.tsx`                                                                                                |
| Badge          | Use                      | `app/school/SchoolChooser.tsx` (affiliations)                                                                            |
| Breadcrumb     | Use                      | `app/school/SchoolShell.tsx`                                                                                             |
| ButtonGroup    | Use                      | `features/requests/RequestsPage.tsx`                                                                                     |
| Button         | Use                      | `app/auth/AuthPages.tsx` (+ Spinner pending idiom everywhere)                                                            |
| Calendar       | Use                      | Gallery only (`design-system/reference/UIReferencePage.tsx`); date inputs use native date controls via `Input type=date` |
| Card           | Use                      | `app/auth/AuthPages.tsx` (focused auth cards)                                                                            |
| Checkbox       | Not currently applicable | In registry; product forms use native checkboxes inside labels (Policies) or Switch where a toggle reads better          |
| Collapsible    | Use                      | `features/setup/SetupWelcome.tsx`                                                                                        |
| Combobox       | Use                      | `features/setup/school-questions.tsx` (searchable pickers)                                                               |
| Dialog         | Use                      | `features/student/StudentPage.tsx` (bounded create/edit over workspace)                                                  |
| Drawer         | Use                      | Gallery only; Sheets cover the current secondary-management need                                                         |
| DropdownMenu   | Use                      | `app/school/UserMenu.tsx`, destination row actions                                                                       |
| Empty          | Use                      | `app/auth/AuthPages.tsx`, every resource list zero-state                                                                 |
| Field          | Use                      | `features/auth/RecoveryAccessPage.tsx` (+ FieldError/FieldLabel)                                                         |
| InputGroup     | Use                      | `features/admin/destinations/DestinationsPage.tsx` (search)                                                              |
| Input          | Use                      | `features/auth/RecoveryAccessPage.tsx`                                                                                   |
| Item           | Use                      | `app/school/SchoolChooser.tsx` (ItemGroup + Item + Badge)                                                                |
| Label          | Use                      | `features/student/StudentPage.tsx`                                                                                       |
| NativeSelect   | Use                      | `features/setup/ProviderChoiceForm.tsx`, policy/schedule/staff-access forms (preserves label + option semantics)         |
| Pagination     | Not currently applicable | Audit uses cursor-based "Next page"; no numbered pagination need yet                                                     |
| Popover        | Use                      | Gallery reference; product popovers arrive via Combobox/DropdownMenu                                                     |
| Progress       | Use                      | Gallery reference; used only where a real value exists                                                                   |
| Questionnaire  | Use                      | `features/setup/ReviewStep.tsx` (guided setup)                                                                           |
| RadioGroup     | Use                      | `features/student/StudentPage.tsx`                                                                                       |
| ScrollArea     | Not currently applicable | Dialog/Sheet content scrolls with the sticky-footer composition instead                                                  |
| Select         | Use                      | `features/admin/destinations/DestinationDetailPage.tsx`                                                                  |
| Separator      | Use                      | `app/school/SchoolShell.tsx`                                                                                             |
| Sheet          | Use                      | `features/admin/locations/LocationsPage.tsx` (contextual edit)                                                           |
| Sidebar        | Use                      | `app/school/UserMenu.tsx`, staff workspace shell                                                                         |
| Skeleton       | Use                      | `app/auth/AuthPages.tsx`, every initial table/list load                                                                  |
| Sonner (Toast) | Use                      | `main.tsx` (Toaster root; e.g. invitation copied)                                                                        |
| Spinner        | Use                      | `app/auth/AuthPages.tsx` (inside initiating Button, `data-icon="inline-start"`)                                          |
| Switch         | Use                      | `features/admin/destinations/DestinationDetailPage.tsx`                                                                  |
| Table          | Use                      | `features/admin/destinations/DestinationsPage.tsx` (TanStack + shadcn Table)                                             |
| Tabs           | Use                      | `features/admin/schedules/SchedulesPage.tsx`                                                                             |
| Textarea       | Not currently applicable | In registry (also composed inside InputGroup); no product long-text field yet                                            |
| Toggle         | Not currently applicable | In registry (composed inside ToggleGroup); Switch covers product toggles                                                 |
| ToggleGroup    | Not currently applicable | In registry; no product segmented-toggle need yet                                                                        |
| Tooltip        | Use                      | `main.tsx` (TooltipProvider)                                                                                             |

## Workspace and domain compositions

| Composition       | Decision           | Notes                                                                                               |
| ----------------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| PageHeader        | Domain composition | `components/workspace/PageHeader.tsx`: title + description + actions; no kicker                     |
| StatusAnnouncer   | Domain composition | `components/StatusAnnouncer.tsx`: polite/assertive live region (relocated out of legacy primitives) |
| PassCard          | Domain composition | `design-system/patterns/PassCard.tsx`: pass state card; shadcn Button inside                        |
| Route / RouteStop | Domain composition | `design-system/patterns/Route.tsx`: pass route evidence                                             |
| QueuePosition     | Domain composition | `design-system/patterns/QueuePosition.tsx`: numeric queue position, no invented estimates           |
| DestinationRow    | Domain composition | Gallery + destination display; lists use Table in production                                        |
| ConflictNotice    | Domain composition | `design-system/patterns/ConflictNotice.tsx`: 412 conflict review entry                              |
| ConnectionStatus  | Domain composition | `design-system/patterns/ConnectionStatus.tsx`: realtime interruption states                         |
| RecoveryBanner    | Domain composition | Break-glass session banner (role=alert)                                                             |
| SetupAccessBanner | Domain composition | Setup-session deadline banner                                                                       |

## Gaps

None. Every commodity need found during the redesign maps to a shadcn Maia /
Base UI implementation above; the three "Not currently applicable" entries are
available in the registry for future use, not missing.

## Removals (this issue)

- Deleted `apps/web/src/design-system/primitives/` (16 legacy modules, incl. all
  React Aria-based shadcn lookalikes) after migrating the last consumers
  (ConnectSignInPage, ConflictNotice, ConnectionStatus, reference StudentStates).
- Removed the `react-aria-components` dependency (no source usage remained).
- Deleted `apps/web/src/design-system/utilities.css` and pruned ~480 lines of
  dead `wf-*` rules from `components.css`; kept classes still referenced by
  domain patterns, the setup flow, and the `/__ui` gallery.
- No production `window.confirm()` / `window.alert()` remains.
- `e2e-product/journeys.pw.ts` staff-access test now uses table/row roles
  instead of the `.data-table__row` CSS selector.
