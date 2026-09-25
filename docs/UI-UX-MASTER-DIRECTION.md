# Hajj & Umrah Hotel Operations System — UI/UX Master Direction

Status: **APPROVED (2026-09-25).** Decisions D1–D15 are resolved (§44) and the contract changes S1–S14 are integrated into the Phase 1 plan (§42). This is design direction only: no UI code has been written, no UI dependency installed, no Phase 1 task started, and no production file changed.

**Constraints this document treats as fixed:** `docs/ARCHITECTURE.md`; the Phase 0 codebase as it exists on `main`; the Phase 1 plan `docs/superpowers/plans/2026-09-25-phase-1-hotel-inventory-foundation.md` with its approved rulings (Q1–Q6) and decisions (D1–D16). Where the UI needed something the plan did not provide, §42 names the change and the task that owns it; those changes (S1–S14) are approved and now part of the plan.

**What the codebase has today (inspected):** `app/` holds a placeholder `index.vue` and empty `components/`, `layouts/`, `composables/`, `stores/` folders. No UI library, CSS framework, i18n module or state library is installed. Session auth is `nuxt-auth-utils`. `shared/` already holds the permission and role catalogs and is where the Phase 1 plan puts Zod schemas, inventory constants, `dates.ts` and `normalizeRoomNumber`. The client can import all of these, which is how the UI validates input the same way the server does without copying rules.

**How to read this document:** Part I (§1–§20) is the foundation: principles, navigation, hotel context, and the design system. Part II (§21–§33) specifies the dashboard and every Phase 1 screen. Part III (§34–§41) covers cross-cutting architecture and fit with later phases. Part IV (§42–§45) holds the API/DTO reconciliation, the persona check, the decisions that need approval, and the acceptance criteria.

**Sequencing:** the Phase 1 plan builds no UI (Part C §2 of the plan). The Phase 1 UI becomes its own implementation plan after this direction is approved. The application shell and design system can start once Task 7 (`/api/auth/me`) exists. Each screen starts once its API task is merged.

---

# Part I — Foundations

## 1. Product UX principles

1. **The hotel context is never ambiguous.** Every screen that reads or writes hotel data shows which hotel it is acting on. Every form and confirmation that writes data repeats it (§6).
2. **Business truth comes from the server.** Effective capacity, averages, inventory status, period and block phases, and the hotel's own "today" are computed by the backend's domain functions and displayed as received. Vue never re-derives them. The client does only presentation arithmetic, such as counting nights between two dates the user typed.
3. **The night is the unit.** Inventory dates are nights in hotel time. The UI always says "5 nights (3–7 May)" and "Available again from 8 May", never a bare end date that could be read either way.
4. **Two numbers, never one.** Physical beds and sellable Haji capacity are always shown as two labelled values ("6 Haji, 6 beds"), even when they are equal.
5. **History is visible, never editable.** Past nights, ended seasons and finished blocks stay on screen, visibly marked as history. Anything locked shows why it is locked.
6. **Dense but calm.** Borders and spacing separate content; shadows are reserved for floating layers. Color carries meaning (status, selection, season), never decoration.
7. **Keep the user where they are.** Creating, editing and inspecting happens in drawers over the list or calendar the user came from. Every drawer and filter state can be deep-linked.
8. **Show only what exists.** Modules that are not built do not appear in navigation. The architecture reserves their places without showing dead items.
9. **Every state is designed.** Loading, empty (nothing exists vs nothing matches), error, forbidden, inaccessible hotel, inactive hotel and locked history each have an explicit treatment (§20).
10. **Keyboard first on desktop, thumb first on mobile.** The same task is optimised differently per device, not scaled down (§15).

### 1.1 Visual identity: "marble and dusk"

The product's world is Makkah and Madinah hotel operations run under seasonal pressure. The identity takes two materials from that world and avoids decorative religious motifs (no patterns, domes or calligraphy flourishes), which would look like tourism marketing rather than an operations tool.

- **Marble:** calm, cool near-white surfaces with slate ink text. The large quiet areas of the app are this.
- **Green, used sparingly:** one deep green is used only for primary actions, selection and focus. It is familiar in the region, but here it signals "you can act", not branding.
- **Dusk indigo:** the color of the season layer. Everything that comes from a capacity period (Hajj 2027, Ramadan 2027) carries this hue and nothing else does. The user learns quickly that indigo means "seasonal capacity is in effect".

**The one signature element** is the two-layer room calendar and capacity ribbon (§29, §31): a thin indigo band shows seasonal capacity and the fill underneath shows operational status. It is the most-used screen and it visualises the product's core idea: capacity and availability are independent layers. Everything around it stays quiet.

### 1.2 Vocabulary (system term to user term)

Users never see database terms. This glossary is binding for all UI copy in both languages.

| System term | English UI term | Notes |
|---|---|---|
| `room_base_config` version | **Normal capacity** | "Permanent change" when a new version starts on a date |
| `capacity_period` | **Season** (nav: **Seasonal capacity**) | Kind shown as a label: Hajj, Ramadan, Special |
| `room_capacity_override` | **Seasonal capacity** for that room | "Room 401 has seasonal capacity in Hajj 2027" |
| `sellableCapacity` | **Haji capacity** | Always paired with beds |
| `physicalBeds` | **Beds** | |
| `NOT_IN_INVENTORY` | **Not in inventory** | Never "Out of service", which is a block kind |
| Retire (close last base version) | **Retire room** / **Retired** | "Retired from 1 Oct 2026" |
| Reactivate | **Return to inventory** | |
| `OPERATIONAL_BLOCK` | **Blocked** | e.g. "Reserved for management" |
| `MAINTENANCE` | **Maintenance** | |
| `OUT_OF_SERVICE` | **Out of service** | |
| Period phase FUTURE / ACTIVE / ENDED | **Upcoming / Running / Ended** | |
| Block phase | **Upcoming / Running / Ended / Cancelled / Ended early** | |
| `allHotels` | **All hotels** access | |
| Organization slug | **Organization ID** (sign-in) | |

---

## 2. Information architecture

### 2.1 Target navigation (all phases)

```text
Overview                                   P1 (inventory) → P8 (full dashboard)
Hotels                                     P1   portfolio list + hotel profiles
Inventory
  Room calendar                            P1
  Rooms                                    P1
  Seasonal capacity                        P1
  Blocks & maintenance                     P1 blocks → P4 adds maintenance tickets
  Room types                               P1   organization-wide catalog
  Housekeeping                             P4   feature-flagged
Front office
  Bookings                                 P2
  Holds                                    P2
  Arrivals & departures                    P4   check-in / check-out
  Customers                                P2
  Agents                                   P2
Finance
  Overview                                 P5
  Invoices                                 P3
  Payments                                 P3
  Receivables                              P3
  Expenses                                 P5
  Hotel contracts                          P5
People
  Employees                                P6
  Payroll                                  P6
  Compliance                               P6
Reports
  Report center                            P8
  Hotel performance, Occupancy, Financial, Agents   P8
Administration
  Users & access                           later (Users & Roles work)
  Organization settings                    later
  Audit log (organization-wide)            later
  Demo data                                P1, demo organization only
```

**Changes from the suggested structure, and why:**

- **"Hotels" is a top-level item, not a child of "Hotel Operations".** Multi-hotel is the defining concept, and the hotel list is where portfolio managers start. Hotel-scoped work (calendar, rooms) lives under Inventory and takes its hotel from the hotel context (§6).
- **"Inventory" replaces "Hotel Operations" for Phase 1–4 items.** Calendar, rooms, seasons, blocks and room types are all inventory. "Dashboard" is not repeated inside a group because Overview already is the dashboard.
- **"Front office" instead of "Reservations".** It holds bookings and holds (Phase 2) plus arrivals and departures (Phase 4), which a front desk uses together. Check-in/out does not get its own group.
- **Maintenance merges with Blocks.** Phase 1 blocks are the manual form of maintenance, and Phase 4 tickets create blocks. One destination avoids two lists of "rooms that can't be sold".
- **"People" instead of "Employees > Employees".** This avoids a group and an item with the same name.
- **Room types sit in Inventory, marked organization-wide**, not in Administration. Managers look for them next to rooms.
- **Hotel audit history lives in each hotel's profile (Activity tab).** Phase 1 only has a per-hotel audit API. The organization-wide audit log appears under Administration when its API exists.

### 2.2 Visibility rules

1. A navigation item is shown only if its module is implemented **and** the user holds its read permission. A group is shown only if at least one of its items is shown.
2. Phase 1 therefore shows at most: **Overview, Hotels, Inventory (Room calendar, Rooms, Seasonal capacity, Blocks & maintenance, Room types), Administration (Demo data)**.
3. There are no "coming soon" items. Later modules are added by registering a route and a nav entry with a permission (§40), not by redesigning the shell.

| Persona (Task 20) | Phase 1 navigation |
|---|---|
| Super Admin (`admin`) | Overview, Hotels, Inventory (all 5 items), Administration: Demo data |
| Hotel Manager (`manager.grand`, `manager.madinah`) | Overview, Hotels, Inventory (all 5, room types read-only) |
| Reservation Manager (`reservations`) | Overview, Hotels, Inventory (read-only) |
| Reception (`reception.grand`, `reception.ajyad`) | Overview, Hotels, Inventory (read-only) |
| Read-only Management (`management`) | Overview, Hotels, Inventory (read-only) |
| Accountant (`accountant`), HR Manager (`hr`) | Hotels only (neither role has `room.view`; §43) |

---

## 3. Desktop navigation (≥ 1024 px)

```text
┌────────────────┬──────────────────────────────────────────────────────────────────────┐
│ Al Safa Hotels │ [GR] Al Safa Grand Makkah  ▾   [ Search rooms and pages   Ctrl K ]  ع  (FA) │  header 56
│ Demo           ├──────────────────────────────────────────────────────────────────────┤
│                │ Inventory / Room calendar                                             │  breadcrumb
│ Overview       │ Room calendar                              [Legend] [Block rooms]     │  page header
│ Hotels         │ [Today] [‹] 1–31 Oct 2026 [›] [7|14|31|90|Custom]  Floor ▾ Type ▾ …    │  toolbar
│ Inventory      │                                                                       │
│ ▍Room calendar │                         content                                       │
│  Rooms         │                                                                       │
│  Seasonal cap. │                                                                       │
│  Blocks & mnt. │                                                                       │
│  Room types    │                                                                       │
│ Administration │                                                                       │
│  Demo data     │                                                                       │
│ [«] Collapse   │                                                                       │
└────────────────┴──────────────────────────────────────────────────────────────────────┘
```

**Sidebar**
- Expanded width **248 px**. Collapsed rail **64 px** (icons only, tooltip with the label on hover and focus).
- Default: expanded at ≥ 1280 px, collapsed at 1024–1279 px. The user's choice is saved in a cookie (`ui.sidebar`) and wins over the default on later visits.
- Toggle: the collapse button at the sidebar foot, or `Ctrl/⌘ + \`.
- Top block: organization name and, for the demo organization, a **Demo** tag (neutral outline badge, never green). The hotel switcher is **not** in the sidebar. It sits in the header where it stays visible when the sidebar is collapsed.
- Groups have a quiet sentence-case label (13 px, muted, no uppercase). Groups do not collapse in Phase 1; there are too few items to justify it. In the rail, groups are separated by a 1 px divider.
- Active item: 3 px bar on the inline-start edge in primary, medium-weight label, `surface-2` background. Hover: `surface-2` only.
- Nav items are links (`<a>`), so middle-click and "open in new tab" work.

**Header (56 px):** hotel switcher at the start; search field in the centre, 320–480 px wide (a click opens the command palette, §7); then language toggle, and the user menu at the end. The notifications bell is added in Phase 7 between search and language; it is not shown before notifications exist.

**Page header (inside content):** breadcrumb (13 px), page title (22 px), and page-level actions aligned to the end: at most **one** primary button, up to two secondary buttons, the rest in an overflow menu. Filters sit in a toolbar row below the title, never inside the global header.

---

## 4. Tablet navigation (768–1023 px)

- **Navigation rail, 72 px**, always visible: one icon with a short label under it (12 px) for each top-level destination: Overview, Hotels, Inventory, Admin. Tapping a destination that has children (Inventory, Admin) opens a **flyout panel** (256 px, over the content, with a scrim) listing its children. Tapping outside or choosing an item closes it.
- Why a rail and not a hamburger: tablets are used by hotel staff moving between the same three or four screens. A permanently visible rail saves a tap on every switch and costs only 72 px.
- **Header 56 px:** hotel switcher chip (monogram + short name), search icon button (opens the command palette full-width), user avatar. The language toggle moves into the user menu.
- No bottom tab bar on tablets.
- A landscape tablet ≥ 1024 px wide gets the laptop layout, with touch sizing because its pointer is coarse (§15).

---

## 5. Mobile navigation (< 768 px)

```text
┌──────────────────────────────┐
│ [GR] Grand Makkah ▾      🔍 ◯ │  header 52
├──────────────────────────────┤
│ Rooms                         │  large title, shrinks on scroll
│ ‹ Thu 1 | Fri 2 | Sat 3 … ›   │
│ …                             │
├──────────────────────────────┤
│  Home   Rooms   Blocks   More │  tab bar 64 + safe area
└──────────────────────────────┘
```

- **Header 52 px:** hotel chip at the start (tap opens the hotel sheet, §6.5). Search icon and avatar at the end. No hamburger; navigation lives in the tab bar.
- **Bottom tab bar, Phase 1: Home, Rooms, Blocks, More.**
  - **Home** is the Overview for the current scope.
  - **Rooms** is the mobile room board: every room's status for one night, with search. It is the mobile form of the calendar (§31), so there is no separate Calendar tab.
  - **Blocks** lists what is out of order now and next. It is the most frequent operational task in Phase 1.
  - **More** opens a full-height sheet: the hotel switcher, all other permitted destinations grouped as in §2, language, theme, and sign out.
- **Target tab bar from Phase 2 onward: Home, Rooms, Bookings, Alerts, More** (five items, the maximum). Blocks moves into More and stays one tap away from any room. Alerts arrives with the Phase 7 notification centre. The rule: tabs hold daily lookup destinations; configuration is never in the tab bar.
- **Floating action button:** none in Phase 1. From Phase 2, the Bookings tab only gets a "New booking" floating button, because creating a booking is the single dominant mobile action there. Other actions live in the page or the item's sheet.
- Tab items show an icon plus a label (never icon-only) and have 48 px targets. The active tab uses primary color **and** a filled icon, so the state does not rely on color alone.

---

## 6. Multi-hotel context model

### 6.1 The canonical rule

**The URL is the single source of truth for hotel scope.** There is no second, independent "selected hotel" that can disagree with the page.

| Page class | Examples | Hotel in URL | Scope options |
|---|---|---|---|
| **Hotel-scoped** | Room calendar, Rooms, Room detail, Seasonal capacity, Blocks, Hotel profile | Path: `/hotels/:hotel/...` | Exactly one hotel |
| **Portfolio** | Overview; later Bookings, Finance, People, Reports | Query: `?hotel=MKK-GRAND` (absent = all in scope) | All in scope, or one hotel |
| **Organization** | Hotels list, Room types, Administration | None | Not applicable |

The client store keeps only two things: `lastHotel` (persisted per user in local storage, used to resolve navigation links) and the current scope derived from the route. The switcher never writes the store directly; it navigates, and the store follows the route.

### 6.2 Switcher behaviour by page class

- **Hotel-scoped page:** choosing another hotel navigates to the same sub-page for that hotel, keeping hotel-independent state (the calendar date range, the active tab) and dropping hotel-specific state (floor and room-type filters, selections, open drawers). "All hotels" is not offered on these pages. The switcher shows the hotel list only, with a note "This page shows one hotel at a time."
- **Portfolio page:** choosing a hotel sets `?hotel=`; choosing "All hotels" removes it.
- **Organization page:** the switcher stays visible, shows the last-used hotel dimmed with the caption "Not used on this page", and choosing a hotel just updates `lastHotel`.
- **Sidebar links to hotel-scoped modules** resolve to `/hotels/<lastHotel>/<module>`. If there is no `lastHotel`, they go to `/select-hotel?next=<module>`, a hotel chooser that lists the accessible hotels with their key figures.

### 6.3 Switcher states

| User's access | Switcher |
|---|---|
| One hotel | A static label (monogram + name), no dropdown. No "All hotels". Overview shows that hotel. |
| Several hotels (restricted) | Dropdown: "All my hotels (3)" plus the list. |
| `allHotels` | Dropdown: "All hotels (5)" plus a searchable list grouped by city (Makkah, Madinah). Inactive hotels appear in a collapsed "Inactive" group at the end. |
| No hotels | The switcher is hidden. Overview shows "You don't have access to any hotel yet. Ask an administrator to assign one." |

### 6.4 Edge cases

- **Access removed while in use.** Authorization is resolved on every request, so the next call for that hotel returns 404. The page is replaced by a full-page state: "Al Safa Grand Makkah isn't available to your account", with "Choose another hotel" and "Go to Overview". The client reloads `/api/auth/me` and the hotel list, and clears `lastHotel` if it pointed at that hotel.
- **Hotel deactivated.** Still readable. A persistent banner under the page header reads "This hotel is inactive. Inventory changes are turned off until it's reactivated." Write actions are **disabled with that reason** rather than hidden, because the state is temporary (§34). The server enforces it anyway (`409 HOTEL_INACTIVE`).
- **Unknown or mistyped hotel in the URL** gets the same inaccessible-hotel state as above. The client cannot tell "does not exist" from "no access", by design.
- **Session expired (8 h).** Any 401 sends the user to sign-in with `?redirect=` to the current URL. If a drawer had unsaved changes, the sign-in page says "Your session ended before your changes were saved" so the loss is not silent.

### 6.5 Visibility and write safety

- **Hotel marker.** Each hotel gets a two-letter monogram tile (taken from the last segment of its code: `MKK-GRAND` becomes "GR") with a tint derived deterministically from the hotel id, from an 8-hue marker palette (§8.4). It appears in the switcher, page headers of hotel-scoped pages, and write surfaces. The name is always next to it; the tint only speeds recognition.
- **Context stamp on every write surface.** Drawer and dialog headers for anything that writes hotel data show the marker, hotel name and code, e.g. "Al Safa Grand Makkah (MKK-GRAND)". Confirmation text names the hotel ("Block 12 rooms at Al Safa Grand Makkah?").
- **Switching hotel with work in progress.** Open drawers are closed first, with an unsaved-changes prompt if needed. Bulk selections are cleared and the toast says so ("Selection cleared because you switched hotel").

### 6.6 By breakpoint

- **Desktop:** header switcher button (monogram, full name, chevron; max width 320 px). The dropdown is 360 px wide with a search field at the top when there are more than 6 hotels. Opens with `Ctrl/⌘ + Shift + H` or from the command palette ("Switch hotel").
- **Tablet:** header chip with monogram and short name (truncated at 18 characters). The same dropdown opens as a popover.
- **Mobile:** header chip. Opens a bottom sheet (up to 85 % height) with search, "All hotels" (when allowed), and hotel rows 56 px tall showing monogram, name, city and an "Inactive" badge where it applies. The current hotel has a check icon and bold text.

---

## 7. Global header

| Element | Phase 1 | Later |
|---|---|---|
| Hotel switcher | §6 | unchanged |
| Search / command palette | Pages, hotels, rooms in the current hotel, actions | Bookings, customers, agents, employees, invoices |
| Notifications | not shown | Phase 7 bell with unread count |
| Language | toggle button | unchanged |
| Theme | in user menu | unchanged |
| User menu | name, email, roles, organization, theme, language (mobile/tablet), keyboard shortcuts, sign out | profile, 2FA (Phase 9) |

**Command palette (`Ctrl/⌘ + K`, or the search field).** One overlay, 640 px wide on desktop, full-screen on mobile. Results are grouped: **Rooms** (current hotel; uses the existing `GET …/rooms?q=` prefix search, debounced 200 ms, from 1 character), **Hotels** (client-side over the loaded hotel list), **Pages**, **Actions** ("Block a room", "New season", "Switch hotel"), each filtered by permission. Room results show number, type and floor; choosing one opens the room detail. Arrow keys move, Enter opens, `Esc` closes. Later phases add result groups from a future `/api/search` endpoint without changing the palette. Searching rooms across all hotels needs that future endpoint; in Phase 1 the palette says "Searching Al Safa Grand Makkah" and offers "Switch hotel" in the same list.

**Language toggle.** A text button showing the *other* language in its own script: "العربية" in English and "English" in Arabic. It is never a flag, because languages are not countries.

---

## 8. Design tokens

All tokens are CSS custom properties defined once for light and once for dark (§12), mapped into Tailwind v4 `@theme` and into the UI library's color configuration. Components reference tokens, never raw hex values. The hex values below are targets. Every text/background pair is verified with a contrast checker when implemented; body text must reach ≥ 4.5:1 and non-text UI parts ≥ 3:1.

### 8.1 Surfaces, text, borders

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#F4F6F5` | `#0F1416` | App background behind panels |
| `--surface-1` | `#FFFFFF` | `#161C1E` | Panels, tables, drawers |
| `--surface-2` | `#EEF1F0` | `#1D2426` | Hover, active nav, table header |
| `--surface-3` | `#E4E8E7` | `#252D30` | Pressed, selected rows (with primary edge) |
| `--overlay` | `rgb(15 20 22 / 0.40)` | `rgb(0 0 0 / 0.60)` | Scrim behind drawers and sheets |
| `--fg` | `#18211F` | `#E6ECEA` | Primary text |
| `--fg-muted` | `#56625F` | `#A3AFAC` | Secondary text, labels |
| `--fg-subtle` | `#6B7774` | `#8C9895` | Helper text, placeholders (still ≥ 4.5:1) |
| `--fg-disabled` | `#9AA4A1` | `#5E6A67` | Disabled text (exempt from contrast, never the only cue) |
| `--border` | `#DCE2E0` | `#2B3437` | Default dividers and inputs |
| `--border-strong` | `#B9C3C0` | `#3C474A` | Input hover, table outer edge |

### 8.2 Brand and interaction

| Token | Light | Dark | Use |
|---|---|---|---|
| `--primary` | `#0E6B4F` | `#3BBE92` | Primary buttons, links, selection, focus |
| `--primary-hover` | `#0B5A42` | `#57CFA6` | |
| `--primary-fg` | `#FFFFFF` | `#062A1E` | Text on primary |
| `--primary-soft` | `#E3F2EC` | `#12302A` | Selected row tint, active filter chip |
| `--focus-ring` | `#0E6B4F` | `#57CFA6` | 2 px ring, 2 px offset |
| `--season` | `#5140A8` | `#A79BF0` | Season layer: band, badge text, timeline |
| `--season-soft` | `#EEEBFA` | `#262045` | Season badge background, ribbon fill |

### 8.3 Semantic tones (foreground on soft background)

| Tone | Light fg / soft | Dark fg / soft | Meaning |
|---|---|---|---|
| `success` | `#1D7A3E` / `#E6F4EA` | `#6FD394` / `#12301D` | Done, valid, paid |
| `warning` | `#8F5200` / `#FCF1DC` | `#F1B560` / `#33260F` | Attention soon, maintenance |
| `danger` | `#B3261E` / `#FCEAE8` | `#F28B82` / `#3A1715` | Blocked, overdue, expired, destructive |
| `info` | `#1F5FAF` / `#E7F0FB` | `#86B5F2` / `#14253D` | Informational, held (Phase 2) |
| `neutral` | `#4A5553` / `#ECEFEE` | `#B8C2BF` / `#242C2E` | Inactive, operational block, cancelled |

Each tone also has `--{tone}-border` (a mid value for outlines) and `--{tone}-solid` (for rare solid badges, with white or dark text chosen to pass contrast).

### 8.4 Hotel marker palette

Eight hues used **only** in hotel monograms: `#2F6FAE`, `#B5542F`, `#6B7F1F`, `#8E3F86`, `#1F8A87`, `#A8761A`, `#4F5BB8`, `#9C3A4B` (dark mode uses lighter variants). The hotel id is hashed to pick one. They never appear in charts or status, so they cannot be confused with meaning.

### 8.5 Charts (later phases)

A categorical series palette separate from status tones: primary green, season indigo, and four more hues checked for color-blind distinguishability. A chart never uses red or green to mean "series 1 / series 2".

---

## 9. Typography

**Typefaces: IBM Plex Sans and IBM Plex Sans Arabic** (open font licence, self-hosted). Plex Sans Arabic was designed as Plex Sans's Arabic companion, with matched weights and vertical metrics. That matters here more than any stylistic preference: Arabic and Latin sit on the same line constantly (hotel names, room numbers inside Arabic sentences), and a mismatched pair looks broken. Plex's engineered character suits an operations tool, and it has true tabular figures. One family, two scripts, no display face.

No monospace face in the UI. Room numbers, codes and money use Plex Sans with `font-variant-numeric: tabular-nums`.

| Style | Size / line height | Weight | Use |
|---|---|---|---|
| Page title | 22 / 30 | 600 | One per page |
| Section title | 17 / 24 | 600 | Panel and section headings |
| Subsection | 15 / 22 | 600 | Drawer sections, card titles |
| Body | 14 / 21 | 400 | Default text, table cells |
| Body strong | 14 / 21 | 500 | Emphasis, active items |
| Small | 13 / 18 | 400 | Secondary cell text, helper text |
| Caption | 12 / 16 | 500 | Badges, column headers, chart axes |
| Metric | 24 / 30 | 600, tabular | Overview figures |
| Metric large | 32 / 38 | 600, tabular | Only the single hero figure on a detail page |

Rules:
- **Mobile body is 15 px, and form inputs are 16 px** on touch devices so iOS does not zoom on focus.
- **Arabic (`:lang(ar)`) body line height is 1.65** (vs 1.5) because of taller ascenders and descenders. Sizes stay the same; Plex Arabic's x-height already reads at the Latin size.
- **No uppercase transforms, no letter-spacing** anywhere. Uppercase does not exist in Arabic, and tracked caps would make the two languages look like different products.
- Emphasis comes from weight and color, never italics. Arabic has no true italic.
- Running text (helper text, empty states, descriptions) is capped at about 70 characters per line (`max-width: 65ch`).
- Numbers that line up in columns are always tabular and end-aligned (§16).

---

## 10. Spacing, shape, elevation and primitives

### 10.1 Spacing and layout

- **Scale (4 px base):** 0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64.
- **Page padding:** 32 px at ≥ 1440, 24 px at 1024–1439, 20 px on tablet, 16 px on mobile.
- **Gaps:** 8 inside controls, 12–16 between related fields, 24 between form sections and panels, 32 between page regions.
- **Content width:** tables and the calendar are full width. Forms and detail text are capped at 720 px so labels stay near their fields.
- **Control heights:** 36 px (desktop default), 32 px (dense table toolbars), 44 px when the pointer is coarse. Touch targets are ≥ 44 × 44 px on touch devices and ≥ 24 × 24 px everywhere (WCAG 2.5.8).

### 10.2 Radius (by role, not one value everywhere)

4 px badges and chips; 6 px buttons and inputs; 8 px panels, menus, popovers; 12 px dialogs, drawers' inner corners and bottom sheets' top corners; fully round only for avatars and toggle thumbs.

### 10.3 Elevation and surfaces

| Level | Surfaces | Light | Dark |
|---|---|---|---|
| 0 | Page, panels, tables | Border only, no shadow | Border only |
| 1 | Dropdowns, popovers, tooltips, sticky table header while scrolling | `0 4px 12px rgb(16 24 22 / 0.08)` + border | `surface-3` + border, no shadow |
| 2 | Drawers, dialogs, bottom sheets | `0 12px 32px rgb(16 24 22 / 0.14)` | `surface-2` + border + scrim |
| 3 | Toasts | Level 2 shadow | Level 2 treatment |

Cards are not the default container. A page is panels divided by borders. Separate cards are used only for things that are genuinely separate objects the user compares (hotels in the hotel chooser, persona tiles on the demo sign-in).

### 10.4 Icons

Lucide, through Iconify. Sizes 16 px in dense tables and badges, 20 px in buttons and navigation, 24 px in empty states. Stroke width 1.75. Icons with direction (chevrons, arrows, "back", undo, send) are mirrored in RTL (§13). Icons that carry status always sit next to text.

### 10.5 Interaction states

| State | Treatment |
|---|---|
| Hover | Background step up one surface level; never the only feedback |
| Focus | 2 px `--focus-ring` outline with 2 px offset on `:focus-visible` only; never removed |
| Pressed | `surface-3` |
| Selected | `primary-soft` background, 2 px primary inline-start edge, and a check or selected icon |
| Disabled | `fg-disabled` text, no hover, `aria-disabled`, and a reason in a tooltip or hint text when the cause isn't obvious |
| Read-only | Normal text, no input border, a lock icon when the user might expect to edit it (e.g. room number) |
| Loading | Skeleton for content; spinner only inside buttons that are saving |

### 10.6 Primitive rules

- **Tooltips:** only for labels of icon-only controls and short explanations of truncated or disabled items. Never the only place important information lives, because touch devices have no hover. Delay 400 ms, `Esc` dismisses.
- **Dropdowns and menus:** row actions and overflow only. Destructive items are last, separated by a divider, and use danger text.
- **Popovers:** small in-context tools: calendar legend, a date picker, the calendar's range-selection actions.
- **Drawers:** §18. Width 440 px (standard) or 640 px (wide, for multi-section forms), sliding from the inline-end edge.
- **Dialogs:** confirmations only (§18; tiers in §35.4). Max width 480 px.
- **Bottom sheets (mobile):** the mobile form of drawers and menus, with a grab handle and snap points at 50 % and 90 %.
- **Tabs:** only for sibling views of one object (hotel profile). Never for steps. Tabs scroll horizontally on small screens with a fade at the edge.
- **Accordions:** only for optional detail inside drawers ("Advanced"). Never to hide required fields.
- **Breadcrumbs:** desktop and tablet only; mobile shows a back button in the header instead.
- **Pagination:** §16.
- **Toasts:** bottom inline-end on desktop, bottom above the tab bar on mobile. Success disappears after 5 s; errors stay until dismissed. There is no "Undo" in Phase 1 because no Phase 1 write is reversible through the API. Toasts are announced through a polite live region.

---

## 11. Color semantics

1. **Primary green** is for the single primary action in a region, links, selection and focus. It never means "good" or "available".
2. **Semantic tones** are for status and validation only.
3. **Season indigo** means exactly one thing: capacity from a season is in effect.
4. **Hotel marker hues** appear only in hotel monograms.
5. **Status is never communicated by color alone.** Every status has a text label and, in compact places, an icon or pattern (§19).
6. **Available is quiet.** In the calendar and room lists, "Available" is the normal state and gets no fill. Only exceptions get color. A calendar full of green would bury what matters.
7. **Red is reserved** for things that stop sales or need action now (out of service, overdue, expired) and for destructive buttons.

---

## 12. Light and dark mode

- One token set, two value sets (§8). Components never branch on theme.
- Default is **System**; the user can choose Light or Dark in the user menu. The choice is stored in a cookie and applied before first paint so there is no flash.
- Dark mode specifics:
  - **Tables:** zebra striping is off in both themes. Row separators use `--border`; hover uses `surface-2`. The selected-row edge stays visible in dark.
  - **Calendar:** status fills use the soft tones, which are low-saturation in dark. Patterns (out of service stripes, not-in-inventory hatch) are drawn with alpha on `--fg` so they stay visible without glowing. The season band uses `--season` at full strength, since it is thin.
  - **Charts:** gridlines at `--border`, series from the dark categorical palette, tooltips on `surface-3`.
  - **Badges:** soft background plus light foreground (e.g. warning `#F1B560` on `#33260F`).
  - **Disabled:** `--fg-disabled` plus the absence of a border. Dark disabled states must still read as "there, but not usable".
  - **Selected:** `primary-soft` plus the inline-start edge. Tint alone is too weak on dark surfaces.
  - **Borders** carry more of the structure in dark, because shadows are not used.
  - **Tooltips:** inverse (dark on light, light on dark) in light mode; `surface-3` with a border in dark mode.
  - **Forms:** inputs on `surface-1` with `--border`; focus ring `#57CFA6`.

---

## 13. RTL strategy

The UI is built direction-agnostic from the first component. It is not an LTR app with `dir="rtl"` switched on.

1. **`<html lang dir>` is set from the active locale** by the i18n module. The UI library receives the same direction globally (its app wrapper has a `dir` setting), so menus, popovers and focus handling follow it.
2. **Logical CSS only.** Tailwind logical utilities (`ms-*`, `me-*`, `ps-*`, `pe-*`, `start-*`, `end-*`, `text-start`, `border-s`, `rounded-s-*`). Physical `left`/`right` classes are banned by a lint rule, with an explicit allow-list for the few cases that are physical by nature.
3. **Library props that take physical sides** (for example a sidebar or drawer `side: 'left' | 'right'`) are always computed from the direction, never hard-coded.
4. **Mirrored:** sidebar (right in RTL), drawers (from the left in RTL), breadcrumbs and their separators, pagination arrows, back buttons, the calendar's time axis and previous/next buttons, the capacity timeline, progress direction, and directional icons (flipped with `rtl:-scale-x-100`).
5. **Time axes run right-to-left in Arabic by default, and the direction is a setting, not a structure (D6).** In the calendar, the room column is on the right and later dates are further left; "Next" points left. This matches Arabic reading order and keeps the calendar, timeline and (later) charts consistent. The room number column stays pinned on the reading-start side. **The chronological direction is a single configuration value** (`timeAxisDirection: 'reading' | 'ltr'`, default `'reading'`) read by the calendar, the capacity timeline and later charts; the components position dates through one direction-aware helper instead of hard-coding `right`/`left`, so switching Arabic time axes to left-to-right is a configuration change, not a redesign. **Usability-validation item:** test both directions with Arabic-speaking hotel staff (reception and reservations) before the first Arabic-speaking customer goes live, and set the default from the result.
6. **Not mirrored:** numbers, room numbers, codes, times, phone numbers, email addresses, media controls, and icons without direction (search, settings, check).
7. **Bidirectional isolation.** Every piece of user data in a sentence is wrapped in `<bdi>` (or `unicode-bidi: isolate`): hotel names, room numbers, codes, person names. Identifiers render `dir="ltr"` so "A-12" never becomes "12-A".
8. **Tables in RTL:** column order mirrors (the first column is on the right). Numeric columns stay end-aligned, which in RTL is the left side.
9. **Digits and calendar.** Arabic UI uses Western digits (0–9) and the Gregorian calendar: formatting uses `ar-SA-u-nu-latn-ca-gregory`. Without this, JavaScript's `ar-SA` defaults to Arabic-Indic digits and the Islamic (Umm al-Qura) calendar, which would silently show different dates from the ones stored. The Gregorian calendar is the authoritative operational calendar (D5). Hijri dates may later appear as optional secondary context, never as a source: season dates are always the configured ones and are never derived from a religious calendar.
10. **Text:** all strings come from locale files; no string concatenation (ICU message format with named arguments and plural rules, which Arabic needs for its six plural forms).
11. **Entity names** (hotel, room type, floor label) have a single name in Phase 1 and are shown as entered in both languages (D14). **Required pre-production review item:** bilingual / localized entity names and other localized business content must be reviewed before onboarding Arabic-speaking production customers. Phase 1 keeps names in a single column that a later translation table can extend without rewriting existing data. The UI chrome itself (every label, message and layout) supports English LTR and Arabic RTL from the start.
12. **Testing:** every screen is reviewed in Arabic in both themes before it is accepted (§45).

---

## 14. Accessibility (WCAG 2.2 AA)

- **Semantics:** landmarks (`header`, `nav`, `main`, `aside` for drawers); one `h1` per page; real tables (`<table>`, `<th scope>`) for tabular data; the calendar uses the ARIA grid pattern (§31).
- **Keyboard:** every workflow in §22–§32 can be completed without a mouse. Focus order follows visual order in both directions. A "Skip to content" link is the first focusable element. Drawers and dialogs trap focus and return it to the trigger when closed.
- **Shortcuts:** global shortcuts use a modifier (`Ctrl/⌘ + K`, `Ctrl/⌘ + \`). Single-key shortcuts (`T` for today, `B` for block in the calendar) work only while the calendar grid has focus, and can be turned off in the user menu (WCAG 2.1.4). A `?` dialog lists all shortcuts.
- **Visible focus:** §10.5. Focus is never hidden behind sticky headers (scroll padding accounts for the header height, WCAG 2.4.11).
- **Contrast:** §8 targets; checked for both themes.
- **Non-color cues:** §11.5 and §19.
- **Targets:** §10.1.
- **Screen readers:** icon-only buttons have labels; status changes and toasts use live regions; the calendar's active cell has a full spoken description (§31); form errors are linked with `aria-describedby` and summarised at the top on submit.
- **Motion:** transitions are 150–200 ms and only show what changed (drawer opening, row expanding, filter applied). With `prefers-reduced-motion`, slides become fades and skeleton shimmer stops.
- **Zoom and reflow:** usable at 200 % zoom and at 320 px width without two-dimensional scrolling, except the calendar grid and wide data tables, which are allowed their own horizontal scroll region (WCAG 1.4.10 exception for data tables).
- **Language:** `lang` on `<html>`, and `lang` on any embedded phrase in the other language.
- **Timeouts:** the 8-hour session is announced 5 minutes before expiry with a "Stay signed in" button, if Phase 9 adds session renewal. Until then, the expiry behaviour in §6.4 applies.

---

## 15. Responsive breakpoints

| Name | Width | Layout |
|---|---|---|
| `mobile` | < 640 | Tab bar, single column, sheets, cards/compact rows |
| `mobile-lg` | 640–767 | As mobile; two-column forms allowed; wider sheets become centred |
| `tablet` | 768–1023 | Navigation rail, hybrid tables, filter drawer, bottom sheets for details |
| `laptop` | 1024–1439 | Sidebar (collapsed by default below 1280), full tables, drawers |
| `desktop` | ≥ 1440 | Expanded sidebar, wider calendar columns, side-by-side panels |

**Refinement:** width decides layout; **pointer type decides sizing.** `(pointer: coarse)` switches controls to 44 px and removes hover-only affordances regardless of width, so an iPad Pro in landscape (1366 px) gets the laptop layout with touch-sized controls, and a small laptop window keeps precise sizing. Tailwind is configured with these breakpoints plus a `touch:` variant for `(pointer: coarse)`.

---

## 16. Table behaviour

One table system (`DataTable`, built on the UI library's TanStack-based table) with features switched on per table, not all at once.

| Feature | When to enable |
|---|---|
| Sort | Columns users compare (room number, capacity, dates). Server sort when the API sorts; client sort for small complete sets |
| Filter | Via the page's filter bar (§23), never per-column filter popups |
| Pagination | Server lists (rooms, blocks, audit). Not for lists under 100 items |
| Selection + bulk bar | Only where a Phase 1 bulk API exists: rooms, override rooms (§33) |
| Column visibility | Rooms table only in Phase 1 |
| Sticky header | Always on scrolling tables |
| Row actions | One visible primary action per row where it is frequent (e.g. "Block"), others in an overflow menu at the row end |
| Row click | Opens the detail drawer or page. The whole row is clickable, and the room number is also a real link for keyboard users and new tabs |

- **Row height** 44 px (desktop), 52 px (coarse pointer). A compact 36 px density is a later user preference.
- **Alignment:** text starts at the reading start; numbers and money end-aligned and tabular; dates start-aligned in one consistent format; status badges start-aligned.
- **Numbers:** a column header names the unit ("Haji", "Beds") so cells hold only the number.
- **Truncation:** text truncates with an ellipsis and a tooltip; numbers never truncate.
- **Pagination control:** "1–50 of 312" plus previous/next and a page-size menu (25, 50, 100). Page and size live in the URL.
- **Loading:** skeleton rows at the real column widths, 8 rows. Page changes keep the old rows dimmed with a top progress bar, so the table does not jump.
- **Mobile transformation** is chosen per table, never "shrink the table":

| Table | Mobile form |
|---|---|
| Hotels | Card per hotel (the only card list; hotels are few and are compared as objects) |
| Rooms | Compact two-line row: "401", type and floor on line 1; capacity and status on line 2 |
| Floors, room types, seasons, blocks | Compact rows with the key figure at the end |
| Audit | Vertical timeline |
| Room calendar | Room board or week grid (§31) |

---

## 17. Form behaviour

Every field defines: **label** (always visible, above the input), **required state**, **helper text** (only when it prevents a mistake), **validation message**, **disabled/read-only state**, **loading state** (for async options), and the form's **save state**.

- **Required vs optional.** The shorter set gets marked. Hotel forms mark required fields with an asterisk explained once at the top. Forms where almost everything is required mark the optional fields "(optional)" instead.
- **Validation timing.** Format checks run on blur. After a field has shown an error, it re-validates on every change so the error clears as soon as it is fixed. Cross-field rules (end ≥ start) run when both fields have values. The client uses the **same shared Zod schemas** the server uses (`shared/schemas/*`), with a localized error map, so client and server rules cannot drift.
- **Server errors.** A `422` maps `issues[].path` to fields. Anything unmapped goes to a summary banner at the top. A `409` (conflict) shows a banner with the translated message for its `data.code` and, when `details` lists conflicting rooms or levels, highlights them. Raw server text is never shown in Arabic; each code has a translation (§45).
- **Submit button** stays enabled. On submit with errors, focus moves to an error summary that links to each field. While saving, the button shows a spinner and "Saving…", and the form is not editable.
- **Grouping.** Fields are grouped into titled sections of three to six fields. No section holds unrelated fields.
- **Sticky footer** with Save and Cancel in drawers, and in page forms taller than the viewport.
- **Unsaved changes.** Leaving a dirty form (route change, drawer close, `Esc`, hotel switch) asks "Discard unsaved changes?". Browser unload also warns.
- **Dates.** A date field is a text input that accepts the typed format plus a calendar popover. It always shows the weekday and, for ranges, the night count and the first available date ("5 nights. Available again from Sat 8 May 2027").
- **Success.** Drawers close and show a toast naming what happened ("Room 401 blocked for 5 nights"). Inline settings show "Saved" next to the section title for 3 seconds.

---

## 18. Drawer, modal, page and bottom sheet rules

| Surface | Use for | Never for |
|---|---|---|
| **Page** | Lists; records with several sections (hotel profile, room detail, season detail); large workflows (create hotel, apply seasonal capacity) | Quick edits |
| **Drawer** (inline-end, 440 / 640 px) | Create/edit of one small record while keeping the list or calendar visible: floor, room, room type, block, season basics; calendar cell details | Multi-step flows, anything with its own navigation |
| **Dialog** | Confirmations and consequences (tiers in §35.4); at most one short input (a reason) | Forms with sections; anything scrolling |
| **Bottom sheet** (mobile, and tablet for details) | The mobile form of drawers, menus and detail panels | Desktop |
| **Popover** | Small tools attached to a control (legend, date picker, range actions) | Content the user must read carefully |

Rules: only one drawer at a time (a second level replaces the content with a back arrow inside the drawer); dialogs can sit over a drawer; drawers have URLs where the content is worth sharing (`?room=…&night=…` in the calendar, `?block=…` in the blocks list).

---

## 19. Status system

One `StatusBadge` component reads a **registry**: `(domain, value) → { labelKey, tone, icon, variant }`. The server sends the status value; the registry only decides how it looks. The same registry drives table badges, calendar fills, detail headers and mobile rows.

### 19.1 Registry

| Domain | Value | Label | Tone | Icon (Lucide) | Calendar treatment |
|---|---|---|---|---|---|
| inventory | `AVAILABLE` | Available | neutral (quiet) | none | No fill; capacity number only |
| inventory | `OPERATIONAL_BLOCK` | Blocked | neutral (strong) | `lock` | Neutral soft fill, lock icon |
| inventory | `MAINTENANCE` | Maintenance | warning | `wrench` | Warning soft fill, wrench icon |
| inventory | `MAINTENANCE` + `sellable: true` | Maintenance (sellable) | warning | `wrench` | Warning outline only, no fill |
| inventory | `OUT_OF_SERVICE` | Out of service | danger | `ban` | Danger soft fill with diagonal stripes, ban icon |
| inventory | `NOT_IN_INVENTORY` | Not in inventory | neutral | `circle-dashed` | Crosshatch on background, dashed outline |
| inventory (P2) | `HELD` | Held | info | `clock` | Info dashed outline, booking reference text |
| inventory (P2) | `BOOKED` | Booked | primary | `calendar-check` | Primary soft fill, reference text |
| inventory (P2) | `OCCUPIED` | Occupied | primary (solid) | `user-round` | Primary solid fill, white text |
| season phase | `FUTURE` / `ACTIVE` / `ENDED` | Upcoming / Running / Ended | season / success / neutral | `calendar-clock` / `play` / `history` | — |
| block phase | upcoming / running / ended / cancelled / ended early | as named | info / warning / neutral / neutral / neutral | per kind icon | — |
| hotel | `ACTIVE` / `INACTIVE` | Active / Inactive | success / neutral | `circle-check` / `circle-pause` | — |
| booking (P2) | draft, hold, confirmed, checked in, checked out, cancelled, no show | as named | neutral, info, primary, success, neutral, neutral, danger | `file-pen`, `clock`, `calendar-check`, `log-in`, `log-out`, `x`, `user-x` | — |
| finance (P3) | unpaid, partially paid, paid, overdue, refunded | as named | warning, warning, success, danger, neutral | `circle`, `circle-dot-dashed`, `circle-check`, `circle-alert`, `undo-2` | — |
| compliance (P6) | valid, expiring soon, expired, renewal in progress | as named | success, warning, danger, info | `shield-check`, `shield-alert`, `shield-x`, `refresh-cw` | — |

### 19.2 Appearance by context

| Context | Form |
|---|---|
| Table | Soft badge: icon + label, 24 px tall |
| Card / compact row | Same badge; labels are never abbreviated, they wrap |
| Calendar | Fill or pattern + icon (≥ 28 px columns) + label (≥ 96 px of bar width) (§31) |
| Detail header | Larger badge (28 px) plus one explanatory line: "Maintenance until Tue 7 Oct. AC repair." |
| Mobile list | Badge at the end of the row |

---

## 20. Loading, empty and error states

### 20.1 Loading

Skeletons match the final layout (table rows at column widths, calendar rows with a room column, metric strip placeholders). After the first load, refetches keep the existing content visible with a thin progress bar instead of flashing skeletons. Nothing shows a spinner in the middle of the page.

### 20.2 Empty: two different situations

| Situation | Pattern | Examples |
|---|---|---|
| **Nothing exists yet** | Short explanation, the one action that fixes it (if the user may take it), and a link to learn more | "No hotels yet. Add your first hotel to start setting up rooms." [Add hotel]. "This hotel has no rooms yet." [Add rooms]. "No seasons yet. Seasons let rooms hold more (or fewer) Haji for dates you choose." [New season]. "No blocks. Every room is available unless it is blocked, under maintenance or out of service." |
| **Filters returned nothing** | Names the active filters and offers "Clear filters" | "No rooms match Floor 4 and Quint." [Clear filters]. "No rooms are in inventory between 1 and 31 Jan 2025." [Show rooms not in inventory] |

Users without the permission to fix an empty state see the explanation without the button.

### 20.3 Errors

| Cause | Message pattern | Action |
|---|---|---|
| Network / timeout | "Couldn't reach the server. Check your connection." | Retry (keeps stale data visible) |
| 401 | Redirect to sign-in (§6.4) | — |
| 403 | "You don't have permission to do this." (for actions) or a full-page "You don't have access to this page." | Back |
| 404 hotel | Inaccessible-hotel state (§6.4) | Choose another hotel |
| 404 record | "This room doesn't exist at Al Safa Grand Makkah, or you can't see it." | Back to rooms |
| 409 | Translated message for the code, with conflicting items listed | Adjust and retry |
| 422 | Field errors (§17) | Fix fields |
| 5xx | "Something went wrong on our side. Try again in a moment." | Retry |

Errors say what failed and what to do, in the interface's voice, with no apology and no raw backend text.

---

# Part II — Dashboard and Phase 1 screens

Screen specs use the required format. "`…`" in API paths means `/api/hotels/:hotelId`. References such as **§42-S6** point to the approved contract change that supplies the screen's data; its exact shape is defined in the owning task of the Phase 1 plan.

## 21. Dashboard architecture

### 21.1 Target structure (all phases)

The Overview answers four questions in order. It is a set of sections, not a wall of cards: each level has one layout, and each figure links to where it came from.

| Level | Question | Form | Eventual content |
|---|---|---|---|
| **1. Critical now** | "Is anything wrong right now, and how full are we?" | One metric strip: at most 5 figures, divided by rules, not separate cards | Occupancy tonight, sellable rooms tonight, Haji capacity available, collections today vs due, compliance alerts count |
| **2. Trend** | "Where are we heading?" | One chart and one comparison table | Occupancy and sales for the next 30/90 days, this Hajj vs last Hajj, forecast vs actual kept visually separate (forecast dashed) |
| **3. Needs action** | "What must someone do?" | A prioritised list, grouped by type, each item a deep link | Expiring holds, overdue payments, documents expiring, rooms out of service, seasons with no rooms configured, unsold inventory for the next season |
| **4. Performance** | "How is each hotel doing?" | Per-hotel table (All hotels) or per-floor / per-type breakdown (one hotel) | Rooms, occupancy, ADR, RevPAR, room nights, average stay, capacity utilisation |

**Drill-down rule:** every figure is a link to the list that produces it, pre-filtered. Examples: *Available rooms* → calendar filtered to available for tonight → floor → room. *Due* (P3) → receivables by agent → agent statement → booking → invoice → payment. A figure that cannot be drilled into is not put on the dashboard.

**Figure anatomy:** label (what it is, in plain words), value (tabular, large), comparison (only when meaningful: "vs last Hajj", never an unexplained arrow), period ("Tonight, 25 Sep" or "Next 30 nights"), and a definition tooltip (e.g. "Haji capacity: the number of pilgrims all sellable rooms can take tonight, including seasonal capacity").

**All hotels vs one hotel:** same layout. All-hotels figures are weighted sums from the server (never an average of hotel averages). Level 4 becomes a per-hotel table.

### 21.2 Phase 1 Overview (inventory only)

**PURPOSE:** A quick, truthful status of inventory for the current scope.
**PRIMARY USER:** Super Admin, Hotel Manager, Read-only Management; Reception on mobile.
**ROUTE:** `/overview` (all in scope) or `/overview?hotel=MKK-GRAND`.

**DESKTOP LAYOUT:**
```text
Overview                                            Tonight, Thu 25 Sep 2026
─────────────────────────────────────────────────────────────────────────────
Rooms in inventory │ Sellable tonight │ Haji capacity tonight │ Average Haji per room
      358          │  341 of 358      │        1,512          │   4.43   (normal 4.38)
─────────────────────────────────────────────────────────────────────────────
Capacity outlook, next 90 nights                          [30 | 90 nights]
 ▁▁▁▁▁▁▁▁▂▂▂▂▂▂▂▂▂▂▂  sellable Haji capacity, season bands shaded indigo
─────────────────────────────────────────────────────────────────────────────
Needs attention                          │ Seasons
 • 6 rooms out of service (2 hotels)     │ Umrah Peak Dec 2026, Upcoming, 15 Dec–15 Jan
 • 4 maintenance blocks end tomorrow     │ Ramadan 2027, Upcoming, 8 Feb–9 Mar, 214 rooms
 • Hajj 2027 at Madinah Central has      │ Hajj 2027, Upcoming, 1 May–31 Jul, 268 rooms
   no rooms configured                   │
─────────────────────────────────────────────────────────────────────────────
Hotels                                                    (All hotels scope)
 Hotel                    Rooms  Sellable  Haji cap.  Average  Unavailable  Season now
 [GR] Al Safa Grand Makkah  98     93        451      4.60        5            —
 …
```
In one-hotel scope, the "Hotels" table is replaced by "Room types" (count and capacity per type in inventory tonight) and the header shows the hotel.

**TABLET LAYOUT:** metric strip becomes 2 × 2; outlook chart full width; "Needs attention" and "Seasons" stack; hotels table keeps Hotel, Sellable, Haji cap., Unavailable (other columns in the row's expand).
**MOBILE LAYOUT:** metric strip becomes a 2 × 2 grid of compact figures; outlook chart 30 nights only; "Needs attention" as a list of tappable rows; hotels as cards with name, sellable/total and Haji capacity; seasons collapsed under a "Seasons" row.
**PRIMARY ACTION:** none. The Overview is for reading; actions happen where the data lives.
**SECONDARY ACTIONS:** scope switch; outlook range (30/90 nights).
**FILTERS:** hotel scope only.
**DATA DISPLAYED:** from `daily-summary` (rooms in inventory, sellable rooms, per-status counts, `sellableRoomCapacity`); from averages (date-effective and base); seasons list; running and ending blocks.
**INTERACTIONS:** each figure links to the calendar or list, pre-filtered (e.g. "6 rooms out of service" opens the Blocks list filtered to Out of service, now). Hovering a chart night shows that night's figures.
**PERMISSION RULES:** requires `room.view`. Users without it (Accountant, HR) are sent to `/hotels` instead of seeing an empty page.
**LOADING STATE:** metric strip and chart skeletons; each section loads independently so one slow call does not block the page.
**EMPTY STATE:** no hotels accessible: see §6.3; hotels exist but no rooms: "No rooms in inventory yet." with [Add rooms] for `room.manage` users.
**ERROR STATE:** per section, with retry; the rest of the page stays usable.
**CONFIRMATIONS:** none.
**ACCESSIBILITY NOTES:** the metric strip is a description list (`dl`); the chart has a text summary ("Lowest sellable capacity: 1,180 Haji on 12 Oct") and a "View as table" toggle.
**API DATA REQUIRED:** one-hotel scope: `GET …/inventory/daily-summary?from=today&to=today+89`, `GET …/capacity/averages?date=today`, `GET …/capacity-periods`, `GET …/room-blocks?from=today&to=today+1`. All-hotels scope: `GET /api/capacity/averages` (with `perHotel`) plus one `daily-summary` call per accessible active hotel (fan-out is acceptable up to 10 hotels; §42-N10). "Today" per hotel comes from the server (§42-S2).

---

## 22. Hotels list

**PURPOSE:** See the portfolio, find a hotel, open its profile, add a hotel.
**PRIMARY USER:** Super Admin; any user with `hotel.view` (restricted users see only their hotels).
**ROUTE:** `/hotels?q=&status=&city=&sort=`

**DESKTOP LAYOUT:** page header "Hotels" with [Add hotel] (Super Admin only). Filter bar: search (name or code), Status (Active / Inactive / All; default Active), City. Table:

| Column | Content |
|---|---|
| Hotel | Monogram, name (link), code under it in small muted text |
| City | "Makkah" |
| Status | Badge |
| Timezone | "Asia/Riyadh (UTC+3)" |
| Floors | Active floors |
| Rooms | Rooms in inventory today |
| Haji capacity | Effective capacity tonight (end-aligned) |
| Average | Date-effective average ("4.60") with the normal average in a tooltip |
| (actions) | Overflow: Open, Settings, Activity (permission-dependent) |

Sort by name (default), city, rooms, capacity. No pagination: an organization's hotels load at once (client-side filter and sort).
**TABLET LAYOUT:** columns Hotel, City, Status, Rooms, Haji capacity; the rest appear in the row's expand panel.
**MOBILE LAYOUT:** one card per hotel:
```text
┌─────────────────────────────────────┐
│ [GR] Al Safa Grand Makkah    Active │
│ MKK-GRAND, Makkah                   │
│ 98 rooms    451 Haji    avg 4.60    │
└─────────────────────────────────────┘
```
Tap opens the profile. Filters open in a bottom sheet; the search field stays visible above the list.
**PRIMARY ACTION:** Add hotel (requires `hotel.manage` and `allHotels`).
**SECONDARY ACTIONS:** per-row open, settings, activity.
**FILTERS:** search, status, city (inline; few enough to not need a drawer). Stored in the URL.
**DATA DISPLAYED:** hotel summary fields; capacity figures from the averages endpoint (inactive hotels show "—" because they are excluded from averages by default).
**INTERACTIONS:** row click opens the profile; the name is a link.
**PERMISSION RULES:** list needs `hotel.view`. Floors/Rooms/Haji capacity/Average columns need `room.view`; without it (Accountant, HR) they are not rendered. Add hotel needs `hotel.manage` + `allHotels`.
**LOADING STATE:** 5 skeleton rows.
**EMPTY STATE:** "No hotels yet. Add your first hotel to start setting up floors and rooms." (with the button for Super Admin; for others: "No hotels have been assigned to you yet.") Filtered: "No hotels match 'Quba' and Inactive." [Clear filters].
**ERROR STATE:** table-level error with retry.
**CONFIRMATIONS:** none on this screen.
**ACCESSIBILITY NOTES:** real table with column headers; monogram is decorative (`aria-hidden`), the name carries meaning.
**API DATA REQUIRED:** `GET /api/hotels` (summary with `floorCount`, `roomCount`, `today`: §42-S2); `GET /api/capacity/averages` (`perHotel`: §42-S12).

---

## 23. Hotel detail (hotel profile)

**PURPOSE:** Everything *about* one hotel: its summary, structure, settings, documents and history. Operational work (calendar, rooms, seasons, blocks) happens in the Inventory pages for this hotel, linked from here.

**Why these tabs and not all eight:** the profile's tabs are **Overview, Floors, Settings, Documents, Activity**. Rooms, Capacity and Calendar are not tabs because they are daily-use pages that need the full width, their own filters and URL state, and a hotel switcher that keeps the user in the same page when changing hotel. Putting them in both the sidebar and the profile tabs would create two paths to the same screen at the same level. The Overview tab links into each of them.

**PRIMARY USER:** Hotel Manager, Super Admin.
**ROUTE:** `/hotels/:hotel` (Overview), `/hotels/:hotel/floors`, `/hotels/:hotel/settings`, `/hotels/:hotel/documents`, `/hotels/:hotel/activity`.

**DESKTOP LAYOUT (Overview tab):**
```text
[GR] Al Safa Grand Makkah   Active                        [Open room calendar]
MKK-GRAND, Makkah, Asia/Riyadh. Check-in 15:00, check-out 12:00
Overview | Floors | Settings | Documents | Activity
───────────────────────────────────────────────────────────────────────────
Tonight   98 rooms in inventory │ 93 sellable │ 451 Haji │ average 4.60
───────────────────────────────────────────────────────────────────────────
Structure                         │ Needs attention
 10 floors (2–11)                 │ 3 rooms out of service        View
 98 rooms in inventory, 2 retired │ 2 maintenance blocks running  View
 Room types: Quad 40, Quint 30,   │ 2 rooms retire on 1 Sep 2027  View
 Six-bed 20, Triple 8             │
 [View rooms]                     │
───────────────────────────────────────────────────────────────────────────
Seasons                                                     [View seasons]
 Hajj 2027    Upcoming   1 May–31 Jul 2027   76 rooms   +152 Haji
 Hajj 2026    Ended      1 May–31 Jul 2026   74 rooms   +148 Haji
```
The page header carries one primary action, "Open room calendar", because that is what managers most often do next.

**New hotel setup checklist:** when a hotel has no floors or no rooms, the Overview tab shows a three-step checklist in place of the structure panel: "Add floors", "Add rooms", "Set up seasons (optional)". Each step shows done/not done and links to the action. This is a real sequence, so it is numbered.

**TABLET LAYOUT:** same tabs (scrollable); structure and "Needs attention" stack.
**MOBILE LAYOUT:** hotel header compacts to name + status; tabs become a horizontally scrolling segmented control; sections stack. The primary action becomes a full-width button under the header.
**PRIMARY ACTION:** Open room calendar.
**SECONDARY ACTIONS:** Settings (edit), Activate/Deactivate (in Settings, §24).
**FILTERS:** none on Overview; Activity filters by action type (the approved audit endpoint filters by entity and action, not by date).
**DATA DISPLAYED:** hotel detail fields; tonight's figures (daily summary for today, averages); structure counts; seasons with impact (§42-S7); attention items from running blocks, retirements and seasons.
**INTERACTIONS:** every figure links to the pre-filtered page (e.g. "3 rooms out of service" opens Blocks filtered to Out of service, Running).
**PERMISSION RULES:** `hotel.view` for the profile; `room.view` for structure/tonight/seasons panels (without it, only hotel details show); Settings editable with `hotel.manage`; Activity tab exists only with `audit.view`; Documents tab exists only if Task 19 shipped.
**LOADING / EMPTY / ERROR:** per panel. Empty hotel: setup checklist.
**CONFIRMATIONS:** none on Overview.
**ACCESSIBILITY NOTES:** tabs use the ARIA tabs pattern but each tab is also a route (links), so each is bookmarkable and works with the back button.
**API DATA REQUIRED:** `GET …` (HotelDetail with `today`, `floorCount`, `roomCount`: §42-S2); `GET …/inventory/daily-summary?from=today&to=today`; `GET …/capacity/averages`; `GET …/capacity-periods?includePast=true` (with `phase`, `overrideCount`, `impact`: §42-S7); `GET …/room-blocks?from=today&to=today`.

**Activity tab:** a vertical timeline of audit entries for the hotel: who (full name), what (translated action: "Blocked room 401 for maintenance"), when (hotel time), and an expandable before/after comparison. Filter by action type. Paginated by "Load older" (keyset cursor). Data from the audit history endpoint with entity filters and actor names (§42-S3).

**Documents tab (Task 19):** table of documents (type, title, uploaded by, date, size) with Download and Archive; [Upload document] opens a drawer (type, title, file with type and size limits stated before selection: "PDF, PNG or JPEG, up to 10 MB"). Archived documents are hidden behind an "Include archived" toggle. The tab is not rendered if Task 19 is deferred.

---

## 24. Hotel create and edit

**Decision: create is a dedicated page with one structured form in three sections; edit happens in the profile's Settings tab.**

- **Why a page and not a drawer:** creating a hotel is rare, consequential, and has about 14 fields; a drawer would be cramped and would sit over a list the user doesn't need to see.
- **Why not a stepper:** every field is known up front, most have sensible defaults, and a stepper would hide validation errors on earlier steps. Three titled sections on one page do the same job with less navigation.
- **Why edit lives in Settings:** "Settings" is where a manager expects to change a hotel. Putting the details form, the inventory rules and the activate/deactivate control together avoids a separate edit page with the same fields.

**PURPOSE:** Add a hotel to the organization; change its details and rules.
**PRIMARY USER:** Super Admin (create); Hotel Manager and Super Admin (edit).
**ROUTE:** `/hotels/new`; edit at `/hotels/:hotel/settings`.

**DESKTOP LAYOUT (create):** single column, max 720 px, three sections, sticky footer [Cancel] [Create hotel].

| Section | Fields |
|---|---|
| **Hotel** | Name (required), Code (required; helper: "Short unique ID used in reports, e.g. MKK-GRAND. It can't be changed later."), Ownership (Owned / Leased / Contracted, segmented), License reference (optional) |
| **Location and time** | City (required), Country (default Saudi Arabia), Address, Timezone (required; searchable, default Asia/Riyadh, showing the current UTC offset), Currency (default SAR) |
| **Operations** | Check-in time (default 15:00), Check-out time (default 12:00), Phone, Email, Notes |

Code is upper-cased as the user types and validated against the shared schema. After creation, the user lands on the new hotel's Overview with the setup checklist and a toast "Al Safa Quba Suites created".

**Settings tab (edit):** three panels, each saved independently (so a mistake in one does not block another):
1. **Hotel details:** the same fields as create; Code is shown read-only with a lock icon and "Codes can't be changed".
2. **Inventory rules:** "Maintenance stops sales" (switch, default on) with the explanation "When on, rooms under maintenance can't be sold. When off, they stay sellable and are only marked for staff."; "Default calendar range" (7–400 nights, default 31).
3. **Hotel status:** at the bottom, visually separated. Active hotel: [Deactivate hotel] (tier 2 confirmation, §35.4). Inactive: [Reactivate hotel].

**TABLET LAYOUT:** same, full width with 20 px padding.
**MOBILE LAYOUT:** same sections, full width; the sticky footer sits above the safe area; time pickers use native time inputs.
**PRIMARY ACTION:** Create hotel / Save changes (per panel).
**SECONDARY ACTIONS:** Cancel; Deactivate/Reactivate.
**FILTERS:** none.
**DATA DISPLAYED:** hotel fields; settings with their defaults.
**INTERACTIONS:** inline validation (§17); unsaved-changes guard; a duplicate code returns 409 and is shown on the Code field ("A hotel with this code already exists").
**PERMISSION RULES:** create: `hotel.manage` + `allHotels` (the route is not reachable otherwise, and the button isn't shown). Edit: `hotel.manage` for the hotel; without it the Settings tab is read-only (values shown, no inputs).
**LOADING STATE:** Settings panels show field skeletons.
**EMPTY STATE:** not applicable.
**ERROR STATE:** field errors, 409 on code, section-level banner for other failures.
**CONFIRMATIONS:** leaving with unsaved changes; deactivate (tier 2: "Al Safa Grand Makkah will stay visible, but floors, rooms, seasons and blocks can't be changed until it's reactivated." with a confirmation checkbox).
**ACCESSIBILITY NOTES:** each section is a `fieldset` with a `legend`; the timezone picker is a combobox with type-ahead.
**API DATA REQUIRED:** `POST /api/hotels`; `GET/PATCH …`; `GET/PUT …/settings`; `POST …/activate|deactivate`.

---

## 25. Floor management

**PURPOSE:** Define the hotel's floors and see what is on each.
**PRIMARY USER:** Hotel Manager.
**ROUTE:** `/hotels/:hotel/floors`

**DESKTOP LAYOUT:** header actions [Add floors] (primary) and [Add a floor] (secondary). Table: Level ("4"; "Ground" for 0; basements "B1"), Label, Rooms in inventory today, Status, overflow (Edit, Deactivate / Activate). An "Include inactive floors" toggle (default off). Row click opens the Rooms page filtered to that floor.
- **Add a floor:** drawer with Level and Label (label pre-fills "Floor 4" as the user types the level).
- **Add floors (bulk):** drawer with From level, To level, and a live preview "Creates 10 floors: 2, 3, 4 … 11. Labels: Floor 2 … Floor 11." If any level exists, the server's 409 `details.existing` is shown as "Floors 4 and 5 already exist. Nothing was created." with those levels highlighted in the preview.
- **Edit:** the same drawer; Level is read-only once rooms exist on the floor (changing the level would reorder rooms silently).
**TABLET LAYOUT:** same table without the Status column (shown as a badge next to the label).
**MOBILE LAYOUT:** compact rows "Floor 4, 10 rooms" with a status badge; tap opens a bottom sheet with View rooms, Edit, Deactivate.
**PRIMARY ACTION:** Add floors.
**SECONDARY ACTIONS:** Add a floor, Edit, Deactivate/Activate.
**FILTERS:** include inactive.
**DATA DISPLAYED:** level, label, `roomCount` (§42-S4), status.
**INTERACTIONS:** all create/edit in drawers, list updates in place without a reload.
**PERMISSION RULES:** `room.view` to see; `room.manage` for every action. Inactive hotel: actions disabled with the reason.
**LOADING STATE:** skeleton rows.
**EMPTY STATE:** "No floors yet. Add the floors this hotel has, then add rooms to them." [Add floors].
**ERROR STATE:** deactivation blocked by rooms returns `409 FLOOR_HAS_ROOMS`: "Floor 4 still has 10 rooms in inventory. Retire or move them first." with a link to those rooms.
**CONFIRMATIONS:** Deactivate floor (tier 1): "Floor 6 will be hidden from room forms. Its rooms' history stays."
**ACCESSIBILITY NOTES:** bulk preview is a live region so screen readers hear the count.
**API DATA REQUIRED:** `GET/POST …/floors`, `POST …/floors/bulk`, `PATCH …/floors/:floorId`, activate/deactivate.

---

## 26. Room types

**PURPOSE:** Maintain the organization's shared room templates.
**PRIMARY USER:** Super Admin (edits); everyone with `room.view` (reads).
**ROUTE:** `/room-types` (organization page; the hotel switcher shows "Not used on this page").

**DESKTOP LAYOUT:** header: "Room types", subtitle "Shared by all hotels in Al Safa Hotels." Action [Add room type] (Super Admin). Table: Name, Code, Default beds, Default Haji capacity, Rooms using it (in inventory today, all hotels), Status, overflow (Edit, Deactivate). Ordered by the type's sort order.

**The rule this screen must make impossible to miss:** changing a default never changes existing rooms.
- The Edit drawer shows, directly above the two default fields, a neutral information panel (icon `info`, not a warning):
  > **Defaults apply to new rooms only.** 142 existing Quad rooms keep their current capacity. To change an existing room, open it and make a permanent capacity change from a date.
- When the user changes either default, the Save button's label becomes "Save new defaults", and a second line appears under the fields: "New Quad rooms will start with 5 beds and 5 Haji. Existing rooms are not changed."
- The success toast repeats it: "Quad defaults updated. Existing rooms were not changed."
- There is no bulk "apply to existing rooms" action in Phase 1 (the API has none; D1).

**TABLET LAYOUT:** same columns except Status (badge next to name).
**MOBILE LAYOUT:** compact rows "Quad (QUAD), 4 beds, 4 Haji" with usage at the end; tap opens a bottom sheet with details and, for Super Admin, Edit.
**PRIMARY ACTION:** Add room type.
**SECONDARY ACTIONS:** Edit, Deactivate/Activate.
**FILTERS:** include inactive.
**DATA DISPLAYED:** type fields; `usageCount` (§42-S4; shown only to users who can see all hotels, otherwise the column is omitted).
**INTERACTIONS:** create/edit in a drawer; "Default Haji capacity" may be higher than beds (helper: "Can be higher than beds when extra beds are added").
**PERMISSION RULES:** view with `room.view`; add/edit/deactivate need `room.manage` **and** `allHotels`. Hotel Managers without `allHotels` see the page read-only with the note "Room types are shared by all hotels. Ask a Super Admin to change them."
**LOADING / EMPTY / ERROR:** skeleton rows; "No room types yet. Room types like Quad or Six-bed give new rooms their starting capacity." [Add room type]; duplicate code 409 on the Code field.
**CONFIRMATIONS:** Deactivate (tier 1): "Quad won't be offered for new rooms. The 142 rooms using it keep it."
**ACCESSIBILITY NOTES:** the information panel is linked to the default fields with `aria-describedby`, so it is read when they get focus.
**API DATA REQUIRED:** `GET/POST /api/room-types`, `PATCH /api/room-types/:id`, activate/deactivate; `usageCount` (§42-S4).

---

## 27. Room management (rooms list)

**PURPOSE:** Find rooms, see their current capacity and state, add rooms, act on several at once.
**PRIMARY USER:** Hotel Manager (manage); Reception and Reservation Manager (look up).
**ROUTE:** `/hotels/:hotel/rooms?asOf=&floor=&type=&q=&inventory=IN&page=&size=`

**DESKTOP LAYOUT:** header actions [Add rooms] (primary; opens bulk create), overflow: Add one room. Filter bar: search by room number (prefix), Floor, Room type, Inventory (In inventory / Retired / All), "As of" date (default the hotel's today, shown as "Today" chip). Table:

| Column | Content |
|---|---|
| ☐ | Selection (only for users who can act in bulk) |
| Room | "401" (link), bold, tabular |
| Floor | "Floor 4" |
| Type | "Quad" |
| Beds | Current effective beds |
| Haji | Current effective Haji capacity; an indigo season badge "Hajj 2027" when seasonal capacity is in effect on the As-of date |
| Status | Badge for the As-of night **(§42-S5)** |
| Next change | "1 May 2027: 6 Haji, 6 beds (Hajj 2027)" or "1 Oct 2026: retires" or "—" **(§42-S5)** |
| (actions) | [Block] (if `room.block`), overflow: Open, Edit details, Change capacity, Retire |

Sorted by floor, then room number (the API's order). Server pagination, 50 per page.

**Hotel column:** not shown, because the page is always one hotel (§6). Cross-hotel room lookup is the command palette's future job (§7).

**Add rooms (bulk) drawer (wide, 640 px):** Floor, Room type, In service from (default the hotel's today), numbering (a range "Prefix 4, from 1 to 10, 2 digits" with a live preview "401, 402 … 410 (10 rooms)", or a list pasted one per line), optional capacity override "Use room type defaults (4 beds, 4 Haji)" / "Set different numbers". Numbers are normalized as typed using the shared `normalizeRoomNumber` ("٤٠١" shows as "401"). A 409 highlights conflicting numbers in the preview: "401 and 402 already exist at this hotel, including retired rooms. Room numbers can't be reused. Nothing was created."

**Room number is set once.** In the create drawer the field's helper says "Room numbers can't be changed after the room is created." In the edit drawer (details: floor, type, features, notes) the number is shown as read-only text with a lock icon, not as a disabled input.

**TABLET LAYOUT:** columns Room, Type, Haji, Status, Next change (Floor merges into the Room cell as a second line); selection stays; filters move to a filter drawer with chips.
**MOBILE LAYOUT:** compact rows, grouped by floor with sticky floor headers:
```text
Floor 4
401   Quad                       6 Haji  6 beds
      Hajj 2027 capacity         Available
402   Quint                      5 Haji  5 beds
                                 Maintenance
```
Tap opens the room detail. Long-press enters selection mode (§33). Filters in a bottom sheet; search stays visible.
**PRIMARY ACTION:** Add rooms.
**SECONDARY ACTIONS:** per room: Block, Open, Edit details, Change capacity, Retire; bulk: Block rooms, Add to a season (§33).
**FILTERS:** as above; all in the URL; chips show active filters with "Clear all".
**DATA DISPLAYED:** RoomListItem (§42-S5).
**INTERACTIONS:** debounced search (300 ms); selection persists across pages of the same filters and clears when filters change, with a toast.
**PERMISSION RULES:** view `room.view`; add/edit/retire `room.manage`; capacity change `capacity.manage`; block `room.block`; bulk season `capacity.manage`. Inactive hotel: all write actions disabled with the reason.
**LOADING STATE:** 10 skeleton rows.
**EMPTY STATE:** no rooms: "This hotel has no rooms yet. Add rooms floor by floor, using number ranges." [Add rooms] (needs at least one floor; otherwise "Add floors first" with a link). Filtered: "No rooms match '40' on Floor 7." [Clear filters].
**ERROR STATE:** table error with retry; 409 in drawers as above.
**CONFIRMATIONS:** Retire (§28).
**ACCESSIBILITY NOTES:** selection checkboxes are labelled "Select room 401"; the bulk bar announces "3 rooms selected".
**API DATA REQUIRED:** `GET …/rooms` (list items with `status`, `nextChange`, `lifecycle`: §42-S5), `POST …/rooms`, `POST …/rooms/bulk`, `PATCH …/rooms/:roomId`.

---

## 28. Room detail

**PURPOSE:** Everything about one physical room: identity, capacity over time, seasons, blocks, history.
**PRIMARY USER:** Hotel Manager; Reception for look-up.
**ROUTE:** `/hotels/:hotel/rooms/:roomId` (always the room's id, never its number; D16).

**DESKTOP LAYOUT:**
```text
Rooms / 401
Room 401   Quad   Floor 4   Available                [Block room] [⋯]
Features: Haram view, Accessible
───────────────────────────────────────────────────────────────────────────
Tonight, Thu 25 Sep 2026       4 Haji    4 beds    Normal capacity
───────────────────────────────────────────────────────────────────────────
Capacity timeline                                   [‹ Earlier] [Later ›]
 [ Normal 4 Haji / 4 beds ][ Hajj 2027  6 Haji / 6 beds ][ Normal 4 / 4 ]
                           1 May 2027        31 Jul 2027  returns 1 Aug
───────────────────────────────────────────────────────────────────────────
Normal capacity                 [Change capacity]   │ Blocks            [Block room]
 From 1 Jan 2025   4 beds   4 Haji   (current)      │ Running: none
                                                    │ Upcoming: Maintenance 2–10 Feb 2027
Seasons for this room                               │ History (12)            View all
 Hajj 2027    Upcoming  1 May–31 Jul   6 Haji 6 beds│
 Hajj 2026    Ended     1 May–31 Jul   6 Haji 6 beds│
───────────────────────────────────────────────────────────────────────────
Activity  (audit entries for this room)                         View all
```
The overflow menu holds Edit details, Retire room (or Return to inventory), and Copy link.

**Change capacity (drawer):** "Permanent change from a date". Fields: Effective from (today or later; helper "Past nights can't be changed"), Beds, Haji capacity, Reason. A before/after line: "From 1 Oct 2026: 4 beds, 4 Haji becomes 5 beds, 5 Haji. Seasons already set up for this room keep their own numbers." Needs `capacity.manage`.

**Retire room (tier 2 dialog):** retire from (date, today or later). The dialog lists what blocks it before the user confirms, using the room's own data: "Remove Room 401 from Hajj 2027 first" and "Cancel the maintenance block on 2–10 Feb 2027 first", each with a link. When nothing blocks it: "Room 401 leaves inventory from 1 Oct 2026. Its history stays, and its number stays reserved; it can't be given to another room." plus a checkbox "I understand" and [Retire room].

**TABLET LAYOUT:** single column: header, tonight, timeline, normal capacity, seasons, blocks, activity.
**MOBILE LAYOUT:** header (number, type, floor, status); tonight figures; the timeline in its vertical form (§29); sections as expandable rows; actions in a sticky bottom bar: [Block room] and a More button (Edit, Change capacity, Retire).
**PRIMARY ACTION:** Block room.
**SECONDARY ACTIONS:** Change capacity, Edit details, Retire / Return to inventory, Copy link.
**FILTERS:** none (timeline window navigation only).
**DATA DISPLAYED:** RoomDetail (§42-S5): identity, lifecycle, base versions, seasons (overrides with period names), current and next change; capacity timeline; blocks; activity.
**INTERACTIONS:** clicking a timeline segment highlights the matching row in "Normal capacity" or "Seasons"; clicking a season opens the season detail.
**PERMISSION RULES:** view `room.view`; Block `room.block`; Change capacity `capacity.manage`; Edit/Retire `room.manage`; Activity section `audit.view`.
**LOADING STATE:** header skeleton, timeline skeleton bar, section skeletons.
**EMPTY STATE:** no seasons: "This room has no seasonal capacity. It uses its normal capacity on every night." No blocks: "No blocks. This room is sellable whenever it is in inventory."
**ERROR STATE:** 404: "This room doesn't exist at Al Safa Grand Makkah, or you can't see it." [Back to rooms].
**CONFIRMATIONS:** Retire (tier 2), Return to inventory (tier 1, with date and capacity), Change capacity (drawer summary acts as confirmation).
**ACCESSIBILITY NOTES:** the timeline has a text equivalent (the seasons and normal capacity tables); the header status is also announced as text.
**API DATA REQUIRED:** `GET …/rooms/:roomId` (RoomDetail: §42-S5); `GET …/rooms/:roomId/capacity-timeline?from&to` (with period names: §42-S13 pattern); `GET …/room-blocks?roomId=&from&to`; audit filtered to the room (§42-S3).

---

## 29. Capacity timeline (component)

**Job:** make "Normal, then Hajj, then Normal again" obvious at a glance, with beds and Haji capacity always as two numbers.

**Desktop and tablet (horizontal ribbon):**
```text
            Today
              │
 Normal       │           Hajj 2027                     Normal
 4 Haji       │           6 Haji  (+2)                  4 Haji
 4 beds       │           6 beds  (+2)                  4 beds
▕─────────────┼─────────▕▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▕───────────────▏
 Jan 2027     │   Apr   │1 May 2027        31 Jul 2027│1 Aug  returns automatically
```
- One ribbon; each segment is labelled with its source name ("Normal" for base, the season's name for seasonal capacity) and two stacked numbers, **Haji** (large) and **beds** (small), each with its unit word.
- Season segments are filled with `--season-soft` and a 3 px `--season` top edge; normal segments are plain surface with a border. This is the same visual language as the calendar's season band.
- At each boundary the change is labelled ("+2 Haji", "−1 bed"). After a season ends, the label reads "returns automatically" so users don't think they must reset anything.
- A "Today" line; segments before today are dimmed and labelled "History" on hover.
- A retired period or a gap shows as a crosshatched "Not in inventory" segment.
- A permanent change (new normal version) shows as a boundary between two "Normal" segments with the label "Permanent change".
- Window: default from 60 nights before today to about 13 months ahead (400 nights, the API maximum), with Earlier/Later buttons moving by 6 months.
- Hover/focus on a segment shows the exact dates and night count.

**Mobile (vertical list):**
```text
●  Until 30 Apr 2027          Normal
   4 Haji   4 beds
●  1 May – 31 Jul 2027        Hajj 2027
   6 Haji   6 beds    +2 Haji
●  From 1 Aug 2027            Normal
   4 Haji   4 beds    returns automatically
```
The current segment is marked "Now".

**RTL:** the ribbon runs right to left; "+2" labels and numbers stay LTR inside.

**Data:** only the server's `capacitySegments` (via the capacity-timeline endpoint) plus period names; the component never computes which capacity applies (principle 2). Numbers for deltas are simple subtraction between adjacent segments, which is presentation.

**Reuse:** the same component appears in the room detail, the calendar's cell drawer (compact, one room, 30 nights), and later in the Phase 2 allocation screen to explain why a room can take 6 Haji on some nights and 4 on others.

---

## 30. Capacity period (season) workflow

### 30.1 Seasons list

**PURPOSE:** See this hotel's seasons past, current and upcoming, and start a new one.
**PRIMARY USER:** Hotel Manager.
**ROUTE:** `/hotels/:hotel/seasons?show=current|past`

**DESKTOP LAYOUT:** header "Seasonal capacity" with [New season]. A short explanation under the title, visible until dismissed: "A season gives selected rooms different capacity for dates you choose, then rooms return to normal automatically. The system does not calculate Hajj or Ramadan dates; you set them." Two groups, "Running and upcoming" (default) and "Ended" (a toggle). Table: Name, Label (Hajj / Ramadan / Special, as an indigo-outlined badge), Dates ("1 May–31 Jul 2027"), Nights, Phase, Rooms, Capacity change ("+152 Haji"), overflow.
**TABLET LAYOUT:** Nights and Label merge into the Name cell.
**MOBILE LAYOUT:** compact rows: name and phase on line 1; dates and "+152 Haji, 76 rooms" on line 2.
**PRIMARY ACTION:** New season.
**SECONDARY ACTIONS:** Open, Rename, End early (running), Delete (upcoming with no rooms).
**FILTERS:** current/past; label.
**DATA DISPLAYED:** period with `phase`, `nights`, `overrideCount`, `impact` (§42-S7).
**PERMISSION RULES:** view `room.view`; all writes `capacity.manage`.
**LOADING / EMPTY / ERROR:** skeleton rows; "No seasons yet. Create one for Hajj, Ramadan or any period when rooms should hold a different number of Haji." [New season].
**CONFIRMATIONS:** Delete (tier 1); End early (tier 2, §30.4).
**ACCESSIBILITY NOTES:** phase badges have text labels.
**API DATA REQUIRED:** `GET …/capacity-periods?includePast=` (with §42-S7 fields).

### 30.2 New season (drawer)

Fields: Name (required, unique in this hotel, e.g. "Hajj 2027"), Label (Hajj / Ramadan / Special; helper: "The label is for grouping and reports only. It doesn't change how capacity works."), First night, Last night (with "92 nights"), Notes. Creating it opens the season detail page, ready to add rooms. A past start date is allowed (onboarding history) and shows "This season starts in the past. It will be recorded as history and its rooms can't be changed after it starts."

### 30.3 Season detail and "Apply capacity"

**ROUTE:** `/hotels/:hotel/seasons/:periodId`; builder at `/hotels/:hotel/seasons/:periodId/apply`.

The detail page shows the header (name, label, dates, phase), a summary "76 rooms, +152 Haji, +152 beds on the first night", and the rooms table (room, floor, type, normal, seasonal, change) with selection for removal while upcoming.

**The apply builder (desktop, page):**
```text
Hajj 2027 at Al Safa Grand Makkah   1 May–31 Jul 2027 (92 nights)
┌─────────────────────────────────────────┬──────────────────────────────────┐
│ 1. Choose rooms                          │ 2. Set capacity                   │
│ Floor ▾  Type ▾  Haji now ▾  Search 4..  │ ( ) Set exact numbers             │
│ ☑ Select all 64 matching                 │     Beds [6]   Haji [6]           │
│ ☑ 401  Quad  Floor 4  4 Haji  4 beds     │ (•) Increase normal capacity by   │
│ ☑ 402  Quint Floor 4  5 Haji  5 beds     │     Beds [+2]  Haji [+2]          │
│ ☐ 403  Six-bed ...    6 Haji  6 beds     │ Reason [Hajj extra beds       ]   │
│ ...                                      │                                   │
│                                          │ 3. Impact on the first night      │
│                                          │ Rooms changing        62          │
│                                          │ Skipped (explained)    2          │
│                                          │ Haji  hotel  452 → 576   +124     │
│                                          │ Beds  hotel  452 → 576   +124     │
│                                          │ 401  4 → 6 Haji, 4 → 6 beds  …    │
│                                          │ [Apply to 62 rooms]               │
└─────────────────────────────────────────┴──────────────────────────────────┘
```
These are numbered because they are a real sequence.
- **Room selection filters:** floor, room type, current Haji capacity (range), room-number prefix. "Select all matching" selects every room the filter matches, not just the visible page. The UI sends the selection as explicit `roomIds` so what the user saw is exactly what is applied.
- **Capacity spec:** "Set exact numbers" (ABSOLUTE) or "Increase normal capacity by" (DELTA; helper: "Added to each room's normal capacity on the season's first night").
- **Impact** comes from the preview endpoint (**§42-S6**), refreshed 400 ms after the selection or numbers change. It shows hotel totals before and during (on the first night), the per-room before/after list, and **skipped rooms with the reason**: "Not in inventory for the whole season" or "Already has seasonal capacity in Ramadan 2027 on overlapping nights".
- **Conflict handling:** if any rooms would be skipped, the Apply button reads "Apply to 62 rooms (skip 2)" and applying uses skip mode. The user is never surprised by the 409 all-or-nothing response.
- **No client-side estimate.** Impact figures come only from the preview endpoint (S6). While a preview is loading or has failed, the impact panel shows a skeleton or an error with retry, never numbers computed in the browser (principle 2).

**Tablet:** the two panes stack: selection on top, capacity and impact in a sticky bottom panel that expands.
**Mobile:** a three-step flow (Choose rooms, Set capacity, Review impact) with Back/Next, because the side-by-side layout doesn't fit. The review step shows the same impact figures.

**Removing rooms from an upcoming season:** select rows on the season detail and "Remove from season" (tier 1 confirmation naming the count and capacity change). This needs the bulk removal endpoint (**§42-S8**); without it the UI deletes rooms one by one, which is slow and not atomic.

### 30.4 Phase rules shown to the user

| Phase | What can change | What the UI shows |
|---|---|---|
| Upcoming | Everything: dates, label, rooms, delete if empty | Normal editing |
| Running | Name, notes, extend end, end early (last night no earlier than yesterday) | Banner: "This season is running, so its rooms' capacity is locked. To change it from tomorrow, end this season today and start a new one tomorrow." |
| Ended | Name and notes only | Banner: "This season has ended. It is kept as history." Everything else read-only. |

**"End early" (tier 2):** "Hajj 2027 will end after tonight (25 Sep). From 26 Sep, its 76 rooms return to normal capacity. Earlier nights keep their seasonal capacity." Requires a reason.

**Changing a running season (D11).** Phase 1 uses a guided workflow. Before anything is written, a review screen explains the three steps and their effect in plain words: (1) end the current season after tonight (nights up to tonight keep their seasonal capacity; nothing in the past is rewritten); (2) create the replacement season starting tomorrow, the first date a new season can take rooms; (3) apply the chosen rooms and capacity to it, with the impact preview (S6). The steps run in order; if a later step fails, the screen shows exactly which steps completed and resumes from the failed one. The replacement season can take rooms only while it is still upcoming, so the screen states the deadline ("Finish before midnight, hotel time, 25 Sep") and, if the hotel's date changes before step 3 completes, explains that the replacement must be re-created from the new tomorrow. No hidden operation rewrites historical nights. An atomic "Adjust season from date" server operation is recorded as a future enhancement and is **not** built in Phase 1.

---

## 31. Room calendar

**PURPOSE:** The daily operational view: every room, every night, what it can hold and whether it can be sold.
**PRIMARY USER:** Hotel Manager, Reservation Manager, Reception.
**ROUTE:** `/hotels/:hotel/calendar?from=2026-09-24&nights=31&floor=&type=&q=&status=&match=any&min=&max=&all=0` and `&room=:roomId&night=YYYY-MM-DD` for an open detail drawer.

### 31.1 Desktop layout

```text
Room calendar   [GR] Al Safa Grand Makkah                 [Legend] [Block rooms]
[Today] [‹] Wed 24 Sep – Fri 24 Oct 2026 [›]  [7 | 14 | 31 | 90 | Custom]
Floor ▾  Room type ▾  Room no. [4   ]  Haji 4–6 ▾  Status ▾  (Any night ▾)   Clear all
┌──────────────┬──────────────────────────────────────────────────────────────┐
│              │ September 2026                         │ October 2026        │ months
│              │ Hajj 2026 ended ... ▕▔▔ Umrah Peak Dec 2026 (indigo ribbon) │ seasons
│ Room         │ 24 25 26 27 28 29 30 │ 1  2  3  4 …                          │ days
│              │ We Th Fr Sa Su Mo Tu │ ...    (Fri/Sat shaded)               │
│ Sellable     │ 93 93 94 94 95 95 95 │ 96 96 …                              │ daily summary
├──────────────┼──────────────────────────────────────────────────────────────┤
│ 401 Quad  F4 │ 4 ···································································│
│ 402 Quint F4 │ 5 ·········[🔧 Maintenance, AC repair ]····························│
│ 403 Six   F4 │ 6 ·····[⛔ Out of service ////////////////]·························│
│ 404 Quad  F4 │ ▔▔▔▔▔▔▔ 6  (season band)                                       │
└──────────────┴──────────────────────────────────────────────────────────────┘
```
(Icons in this sketch stand for the Lucide icons in §19.)

- **Sticky:** the room column (inline-start) and the header rows (months, seasons, days, daily summary).
- **Room column (168 px):** room number (bold), type, floor. Checkbox appears on hover/focus for users who can block.
- **Seasons row:** one indigo ribbon per season overlapping the range, labelled with its name. The user sees at a glance which dates are seasonal before looking at any room.
- **Daily summary row:** sellable rooms per night (from `daily-summary`); hovering shows rooms in inventory, out of service, maintenance, blocked and sellable Haji capacity. The summary respects floor and type filters only (that is what the API supports), and says so: "Totals for Floor 4, all statuses."
- **Weekend columns** (Friday and Saturday for Saudi hotels) and the **today** column are lightly shaded; past columns are dimmed.

### 31.2 Rendering: segments as bars

The API returns run-length segments per room. The grid renders **one bar per segment**, positioned by date, instead of one element per room per night. A 100-room, 31-night page is about 300 bars instead of 3,100 cells. Day columns are drawn with a CSS background, not elements.

Each bar has two layers:
1. **Status layer (fill):** per the registry (§19). Available has no fill.
2. **Capacity layer (band):** a 3 px `--season` band along the top edge when the capacity comes from a season.

Text inside a bar depends on its width:
- ≥ 96 px: icon, status label, and capacity ("6 Haji").
- 28–95 px: icon and capacity number.
- < 28 px (90-night zoom): fill, pattern and band only; details on hover or focus.

The capacity number is printed at the start of each segment and repeated every 7 nights in long segments, so it is never far away. Beds appear in the tooltip and the drawer, not in the cell, to keep the grid calm. Haji capacity is what reservations care about; the drawer shows both numbers side by side.

Phase 2 adds HELD, BOOKED and OCCUPIED as additional statuses in the same registry (§19) with the booking reference as the bar label at wide zooms. No layout change is needed.

### 31.3 Zoom and navigation

| Preset | Nights | Column width at 1440 px | Content |
|---|---|---|---|
| Week | 7 | 128 px | Labels, icons, capacity |
| 2 weeks | 14 | 72 px | Icons, capacity |
| Month | 31 | ≈ 32–40 px | Icons, capacity |
| Quarter | 90 | ≈ 16 px | Fill and bands only |
| Custom | 1–180 | derived | Picks the nearest preset's content rules |

- Default range: the hotel setting `calendar.defaultRangeDays` (31), starting yesterday so the current night has one night of context before it.
- **Today** resets to that position. **Previous/Next** move by the current range length. The range label is a button that opens a date picker for the first night. Custom accepts up to 180 nights in the grid (the API allows 400; beyond 180 the columns are too narrow to be useful, and the daily summary chart covers longer views).
- While a new range loads, the old grid stays visible and dimmed, with a progress bar; the next range is prefetched when the browser is idle.

### 31.4 Interaction (desktop)

- **Hover** a bar: tooltip after 400 ms: "Room 402, Maintenance, 3–7 Oct (5 nights), AC repair. 5 Haji, 5 beds."
- **Click** a bar or night: opens the **detail drawer** (440 px, inline-end) for that room and night: status for that night with reason and dates of any block, capacity (both numbers and source: "Hajj 2027 season" or "Normal capacity"), a compact capacity timeline for the next 30 nights, and actions: [Block from this night], [Open room], and later [Create booking] (Phase 2). The drawer is linked to the URL (`room`, `night`).
- **Select nights on one room:** drag across a row (or click then Shift+click). The selection is clamped to tonight and later for actions. A small popover appears at the selection: [Block 5 nights] [Clear].
- **Select several rooms:** checkboxes in the room column, then choose nights in the header (drag across the days row) or use [Block rooms] in the page header. The bulk bar reads "12 rooms selected, 3–7 Oct" with [Block].
- **Keyboard (grid focused):**

| Key | Action |
|---|---|
| Arrow keys | Move the active cell (mirrored in RTL) |
| Shift + arrow left/right | Extend the night selection |
| Space | Select or unselect the active room |
| Enter | Open the detail drawer |
| `B` | Block the selection (can be turned off) |
| `T` | Jump to today (can be turned off) |
| Page up / down | Move 10 rooms |
| Home / End | First / last night in range |
| Alt + arrow left/right | Previous / next range (mirrored in RTL) |

- **Screen reader:** the grid uses `role="grid"` with a single active cell (`aria-activedescendant`). The active cell is announced as "Room 401, Friday 1 May 2027, Available, 6 Haji, 6 beds, Hajj 2027 season." Row headers are the room cells; column headers are dates.

### 31.5 Tablet

Default range 14 nights; room column 112 px (number and type code). Tap a bar or night: detail in a **bottom sheet** (50 %, drag to 90 %). Long-press (400 ms) on a night starts a selection; drag to extend; release shows an action sheet. Filters open in a filter drawer; active filters show as chips above the grid. Horizontal scrolling is native; the room column stays pinned.

### 31.6 Mobile

The wide grid is not used. The Rooms tab (§5) shows two modes, switched by a segmented control:

- **Day (default):** a swipeable date strip (7 days visible, "Today" pill). Under it, one summary line: "93 of 98 rooms sellable, 438 Haji." Then rooms grouped by floor (sticky floor headers), each row showing number, type, status badge and Haji capacity with the season marker. Tap a room: bottom sheet with its details, the next 14 nights as a vertical list of segments, and [Block room].
- **Week:** a compact 7-night grid (room column 56 px, day columns about 42 px) with fill, pattern and icons only. Tap a cell: the same bottom sheet. No drag selection on mobile; blocking a range happens in the block form's date fields.

Both modes use the same calendar API (Day is `from = to`).

### 31.7 Remaining spec fields

**PRIMARY ACTION:** Block rooms.
**SECONDARY ACTIONS:** Open room, Legend, range navigation.
**FILTERS:** floor, room type, room number prefix, Haji capacity range ("any night in range"), status (multi) with "Any night / Every night", "Include rooms not in inventory". Toolbar on desktop; filter drawer on tablet and mobile; chips with "Clear all"; all in the URL.
**DATA DISPLAYED:** calendar page (rooms and segments), daily summary, seasons ribbon, block and season details for tooltips (§42-S13).
**PERMISSION RULES:** view `room.view`; selection and block actions only with `room.block`; inactive hotel: view only, with the banner.
**LOADING STATE:** first load: skeleton room column and bars; later loads: dimmed grid and progress bar.
**EMPTY STATE:** no rooms: "This hotel has no rooms yet." [Add rooms]; filters: "No rooms match these filters." [Clear filters]; range with no rooms in inventory: "No rooms are in inventory between these dates." [Include rooms not in inventory].
**ERROR STATE:** `TOO_MANY_ROOMS`: "Too many rooms to show at once. Filter by floor or room type."; network: banner above the grid, stale data kept, [Retry].
**CONFIRMATIONS:** none in the grid; the block drawer confirms.
**ACCESSIBILITY NOTES:** §31.4; the legend is also reachable as a list; patterns keep statuses distinguishable without color.
**API DATA REQUIRED:** `GET …/room-calendar` (page size 100; further pages load as the user scrolls, with virtualized rows beyond 60 rooms); `GET …/inventory/daily-summary` (same range, floor, type); `GET …/capacity-periods` (seasons ribbon); `refs` and `meta` in the calendar response (§42-S13). Never one request per cell.

**Performance budget:** first calendar paint under 1 s for 100 rooms × 31 nights on a mid-range laptop; scrolling at 60 fps; no more than about 1,500 DOM nodes in the grid at any time (rows virtualized, bars outside the horizontal viewport skipped at 90-night zoom).

---

## 32. Operational block workflow

### 32.1 Block rooms (drawer; bottom sheet on mobile)

**Entry points:** room row [Block]; room detail [Block room]; calendar selection (room and nights prefilled); bulk bar in Rooms or Calendar (rooms prefilled); Blocks list [Block rooms].

**Fields:**
1. **Rooms:** prefilled chips ("401"), or a picker (search by number; "Whole floor" quick option that uses the floor selector). Maximum 200 rooms, stated when the user gets close.
2. **Type:** three large options, each with icon and one line:
   - **Blocked:** "Held back from sale, e.g. reserved for management or staff."
   - **Maintenance:** "Repairs or cleaning." When the hotel setting is off, the line reads "At this hotel, maintenance doesn't stop sales."
   - **Out of service:** "Can't be used at all, e.g. a water leak."
3. **First night** (tonight or later) and **Last night**, with "5 nights" and "Available again from Sat 8 Oct".
4. **Reason:** required, 500 characters, with quick-fill suggestions (AC repair, Plumbing, Deep cleaning, Reserved for management, Staff accommodation).

**Impact line** above the Save button, updated live:
- "Room 401 won't be sellable for 5 nights (3–7 Oct 2026)."
- Bulk: "12 rooms won't be sellable for 5 nights. Up to 60 room nights and 264 Haji capacity."
- Maintenance with the setting off: "Room 401 stays sellable. Staff will see it marked Maintenance for 5 nights."

The night count is presentation arithmetic; the Haji figure uses each selected room's current capacity from data already loaded and is labelled "up to". Neither decides anything.

**Conflicts:** a 409 (`BLOCK_OVERLAP` or bulk `details.conflicts`) is shown inline: "Room 402 already has a Maintenance block on 4–6 Oct. Nothing was saved." with the room chip highlighted and an action "Remove 402 and save the rest". A room not in inventory for every night gets "Room 410 isn't in inventory on all these nights."

**Save** label: "Block room" / "Block 12 rooms". Toast: "Room 401 blocked for 5 nights."

### 32.2 Blocks list

**PURPOSE:** What is out of order now and next; history on request.
**PRIMARY USER:** Hotel Manager; Reception (read).
**ROUTE:** `/hotels/:hotel/blocks?view=now|history&kind=&q=&from=&to=`
**DESKTOP LAYOUT:** header [Block rooms]. View switch: **Now and upcoming** (default; tonight to 400 nights ahead) or **History** (date range, default the last 90 nights). Filters: type, room number, include cancelled (History only). Table: Room, Type (badge), Nights ("3–7 Oct, 5 nights"), Reason, Phase, Created by, overflow [Cancel] / [End early].
**TABLET LAYOUT:** Created by moves to the row expand.
**MOBILE LAYOUT:** compact rows grouped as "Running", "Upcoming"; kind icon, room, nights and reason; tap for a sheet with actions.
**PRIMARY ACTION:** Block rooms.
**SECONDARY ACTIONS:** Cancel / End early; Open room.
**DATA DISPLAYED:** BlockListItem (§42-S10).
**PERMISSION RULES:** view `room.view`; actions `room.block`.
**LOADING / EMPTY / ERROR:** skeleton rows; "No rooms are blocked, under maintenance or out of service." ; filters: "No blocks match Out of service." [Clear filters].
**CONFIRMATIONS:** the phase decides the dialog (tier 1), always with a required reason:
- Upcoming: **Cancel block**. "Room 401 becomes available for 3–7 Oct."
- Running: **End block early**. "Nights up to last night (24 Sep) stay recorded as blocked. Room 401 is available from tonight (25 Sep)."
- Ended or cancelled: no action.
The server's `cancelAction` (§42-S10) decides which dialog appears: a block that starts tonight displays as Running but is fully cancelled, following the verified cancellation rule. `phase` is for the badge. The browser never compares dates to decide either.
**ACCESSIBILITY NOTES:** the reason field is required and labelled; the dialog names the room and dates.
**API DATA REQUIRED:** `GET …/room-blocks`, `POST …/rooms/:roomId/blocks`, `POST …/room-blocks/bulk`, `POST …/room-blocks/:blockId/cancel`.

An "ended early" block shows "Ended early on 25 Sep (planned until 10 Oct): Repair finished" only if the block row records it (§42-S11); otherwise that text is available only in Activity to users with `audit.view`.

---

## 33. Bulk-selection behaviour

**One pattern everywhere:**
- **Desktop:** a checkbox column; the header checkbox selects the visible page, then a banner offers "Select all 312 matching rooms". Once anything is selected, a **bulk action bar** replaces the table toolbar: "12 rooms selected" + actions + [Clear]. `Esc` clears.
- **Tablet and mobile:** long-press a row (or a "Select" button in the header) enters **selection mode**: checkboxes appear, the header shows the count and [Cancel], and a **sticky action bar** sits at the bottom above the tab bar.
- Selection persists across pages of the same filter set, clears (with a toast) when filters or the hotel change, and shows its count at all times.
- Actions state their scope in the label ("Block 12 rooms"), and their confirmation repeats the hotel (§6.5).
- Limits are shown before they are hit ("Up to 200 rooms per block action").

**Phase 1 bulk actions (only where an API exists):**

| Where | Action | API |
|---|---|---|
| Rooms list | Block rooms | `POST …/room-blocks/bulk` (≤ 200 rooms) |
| Rooms list | Add to a season (upcoming seasons only) | `POST …/capacity-periods/:periodId/overrides` with `roomIds` (cap: §42-S9) |
| Calendar | Block rooms for selected nights | bulk block |
| Season detail | Remove rooms from season | `POST …/capacity-periods/:periodId/overrides/remove` (≤ 1,000, §42-S8) |
| Floors | Add floors by range | `POST …/floors/bulk` |
| Rooms | Add rooms by number range | `POST …/rooms/bulk` |

Not offered in Phase 1 (no API): bulk retire, bulk capacity change, bulk cancel of blocks, export. Export arrives with reports (`report.export`).

---

# Part III — Cross-cutting architecture and fit with later phases

## 34. Permission-aware UI

**The backend stays the authority.** Hiding a button is a courtesy, not security. Every rule below is also enforced by the server, and the HTTP test suites of the Phase 1 plan prove it.

**Source of truth on the client:** `GET /api/auth/me` returns `permissions`, `allHotels` and `hotelIds`, resolved fresh on each call. A `usePermissions()` composable exposes:
- `can(permission)`: the role grants it (organization level);
- `canInHotel(permission, hotelId)`: the role grants it **and** the user has access to that hotel (a presentation mirror of the server's `hotelCan`);
- `hasAllHotels`.

The composable is refreshed after sign-in, on window focus when older than 5 minutes, and whenever the API answers 403 or a hotel 404 (the user's rights may have changed).

**Hide vs disable, one rule:**
- **Hide** what the user can never do with their role (no Edit button for Read-only Management; no Room types editing for a hotel-scoped manager; no Activity tab without `audit.view`).
- **Disable with a visible reason** what the user could do but not *right now*: inactive hotel ("Hotel is inactive"), running or ended season ("Season has started"), past nights ("Past nights can't be changed"), a floor with rooms ("Floor has rooms in inventory").

| UI element | Shown when |
|---|---|
| Add hotel | `hotel.manage` and `allHotels` |
| Hotel Settings inputs | `canInHotel('hotel.manage', hotel)` (else read-only values) |
| Activity tab | `canInHotel('audit.view', hotel)` |
| Floors / rooms create, edit, retire | `canInHotel('room.manage', hotel)` |
| Change capacity, seasons writes, Apply capacity | `canInHotel('capacity.manage', hotel)` |
| Block actions, calendar selection | `canInHotel('room.block', hotel)` |
| Room types writes | `room.manage` and `allHotels` |
| Inventory navigation, calendar, rooms, seasons, blocks | `room.view` |
| Demo data page | organization `isDemo` and `organization.resetDemo` (§42-S1) |
| Hotel choices anywhere (switcher, pickers) | only accessible hotels (the API already returns only those) |

A `<PermissionGate>` component wraps larger regions; buttons use the composable with `v-if` directly. Neither replaces server checks.

---

## 35. Demo experience

The demo is how the product is sold. It must look lived-in and be safe to play with.

### 35.1 Sign-in

**ROUTE:** `/login?redirect=`
- Fields: **Organization ID** (the slug; remembered on this device), **Email**, **Password**, [Sign in]. Error for any wrong combination: "The organization ID, email or password is incorrect." (no hint about which one, matching the server's timing-safe design).
- **Two sign-in experiences, one page (D9).**
  - **Production sign-in:** the three fields and nothing else. No demo hint, no persona list, no prefilled organization.
  - **Demo sign-in:** on load, the page calls `GET /api/public/demo-sign-in`. Only when it answers 200 does the page prefill the Organization ID with `demo` and show the **persona picker** under the form: one tile per persona with display name, role and hotels ("Nora Al-Qahtani, Hotel Manager, Al Safa Grand Makkah"). Accountant and HR tiles carry the label "Available in later phases" (D13) but still sign in. Choosing a tile fills email and password.
  - The endpoint answers 404 unless the server runs with `APP_ENV` = development or demo **and** `DEMO_SIGN_IN_ENABLED=true`; with `APP_ENV=production` it is always 404 and startup validation rejects the flag. The client bundle contains no demo credentials or persona data, so a production deployment cannot show them even if the page code is inspected (Task 20; ARCHITECTURE §17: one image, environments differ only by configuration).
- Desktop: two columns (form at the reading start, a quiet product panel at the end showing the calendar's season band motif, not a stock photo). Mobile: single column, form first.

### 35.2 Inside the demo

- A **Demo** tag next to the organization name (sidebar) and in the user menu, so prospects and staff always know it is not live data.
- The data tells the Hajj story (Task 20): Room 401 at Al Safa Grand Makkah is 4 Haji normally and 6 during Hajj 2027; Al Safa Ajyad Towers averages 3.88; seasons past and upcoming; rooms under maintenance and out of service; retired rooms; a closed floor.
- First screen per persona: Super Admin and Management land on Overview for All hotels; Hotel Managers on their hotel's Overview; Reception on the Room calendar (desktop) or the Rooms tab (mobile).

### 35.3 Demo data page (Administration)

**ROUTE:** `/admin/demo`
- Only in the demo organization, only with `organization.resetDemo`.
- Content: what the demo contains (5 hotels, 360 rooms, seasons, blocks, 9 personas), when it was last reset and by whom (from the `DEMO_RESET` audit row), and the reset section.
- **Reset is confirmation tier 3 (§35.4):** a danger-zone panel, never a toolbar button. It explains: "Every change anyone made in the demo is discarded and the demo returns to its starting data. Everyone using the demo sees this immediately. Sign-ins keep working." An option "Move demo dates to start from today" (sends `anchorDate` = the hotel's today) is on by default for live presentations. The [Reset demo data] button stays disabled until the user types `RESET DEMO`. While it runs (about 1–3 s), a progress state; afterwards a success toast and a full data reload.

### 35.4 Confirmation tiers (used across the product)

| Tier | For | Form |
|---|---|---|
| 0 | Reversible, low impact (activate a floor) | No dialog; toast |
| 1 | Consequential but narrow (cancel block, deactivate floor or room type, delete upcoming season, remove rooms from season) | Dialog naming the object, the hotel and the consequence; reason where the API requires one |
| 2 | Hard to undo or wide impact (retire room, deactivate hotel, end a running season early) | Dialog with an impact summary and an "I understand" checkbox |
| 3 | Destructive for many people (reset demo) | Danger-zone panel, typed confirmation phrase, no shortcut |

The confirm button always repeats the action ("Retire room 401"), never "OK" or "Yes".

---

## 36. Fit with Phase 2 (booking)

The Phase 1 pieces are designed to be reused by the booking flow without redesign:

- **Booking form** (page, not drawer: it is the largest workflow): Haji count, check-in and check-out (the date field already shows nights), customer or agent, then allocation, pricing (Phase 3), hold or confirm.
- **Smart allocation workspace** (desktop, three panes): *request* (Haji count, dates) at the start; *suggested rooms* in the middle (the optimizer's result: room count, total Haji capacity, spare beds, shortfall, alternatives); a *room picker* at the end that reuses the **calendar grid in selection mode** filtered to the stay, and the **room selector** from the season builder (§30.3). Manual override shows "System suggested 12 rooms; you chose 13" and asks for a reason when they differ (ARCHITECTURE §11). Tablet stacks the panes; mobile uses steps.
- **Stay capacity:** the capacity timeline (§29) explains why a room offers 6 Haji on some nights and 4 on others; the available-stay average from Task 17 feeds the "estimated rooms" hint (`ceil(Haji ÷ average)`), computed by the server.
- **Calendar:** HELD, BOOKED and OCCUPIED join the status registry and the segment bars (§19, §31.2). The `refs` pattern (§42-S13) extends with `bookings` so a bar can show the booking reference and the drawer can show the guest group without another call per bar.
- **Holds:** the hold expiry appears as a countdown badge ("Expires in 2 days") in the info tone, turning warning within 24 hours.
- **Mobile:** the Bookings tab replaces Blocks (§5); booking look-up by reference is the first search group.

---

## 37. Fit with finance (Phases 3 and 5)

- **Money display:** always with the currency code ("SAR 12,500.00"); tabular, end-aligned; two decimals in tables; negative amounts with a minus sign and the word "refund" or "credit" in the row, never red alone.
- **Never confuse the five figures.** Each has a fixed label, icon and tone, used identically everywhere:

| Figure | Label | Icon | Tone |
|---|---|---|---|
| Revenue | Sales | `receipt` | neutral |
| Collection | Collected | `wallet` | success |
| Due | Due | `hourglass` | warning (danger when overdue) |
| Expense | Expenses | `arrow-down-circle` | neutral |
| Profit | Profit / Loss | `trending-up` / `trending-down` | success / danger, with the word |

- **Invoice** and **agent statement** are pages with a document-like layout and a print/PDF view. Corrections appear as separate linked rows (credit notes), never as edited amounts, matching ARCHITECTURE §12.
- **Payments** are an append-only list; a reversal shows as its own row linked to the original.
- **Due** always links to its source chain: agent, booking, invoice, payments (§21.1).

---

## 38. Fit with HR and compliance (Phase 6)

- **Expiry urgency scale** (one component, used for Iqama, passport, work permit, insurance, contracts):

| Remaining | Label | Tone | Icon |
|---|---|---|---|
| Expired | "Expired 3 days ago" | danger (solid) | `shield-x` |
| ≤ 7 days | "Expires in 5 days" | danger | `shield-alert` |
| ≤ 30 days | "Expires in 21 days" | warning | `shield-alert` |
| ≤ 60 days | "Expires in 45 days" | warning (soft) | `shield` |
| ≤ 90 days | "Expires in 80 days" | info | `shield` |
| > 90 days | "Valid until 2 Mar 2028" | success | `shield-check` |
| Renewal in progress | "Renewal in progress" | info | `refresh-cw` |

- **Sensitive fields** (Iqama number, passport number, salary): users without `employee.viewSensitive` never receive the value from the API (ARCHITECTURE §8). The UI shows a lock icon and "Hidden", not asterisks that suggest the value is present.
- Employee pages follow the hotel-profile pattern (tabs: Overview, Documents, Payroll, Activity), with the multi-hotel assignment and cost split shown as a small table.

---

## 39. Frontend state architecture

| State | Where it lives | Examples |
|---|---|---|
| **URL (path and query)** | The route | Hotel for hotel-scoped pages; portfolio `?hotel=`; filters; sort; page and size; calendar range and zoom; active tab; open detail drawer (`?room=&night=`, `?block=`) |
| **Server state** | A query cache (one per request key) | Hotel lists and details, rooms pages, calendar pages, daily summaries, averages, seasons, blocks, `me` |
| **Shared app state** (small store) | Pinia | Session (`me`), `lastHotel`, UI preferences (sidebar collapsed, shortcut toggles), the derived current hotel scope |
| **Page-local state** | Component | Open dialogs, form drafts, bulk selections, calendar hover and active cell, drag selection |
| **Device preferences** | Cookie / local storage | Theme, language, sidebar, last organization ID on the sign-in form |

Rules:
- There is no store holding lists of domain data. (D3: TanStack Query owns server data; Pinia holds only session presentation, preferences and `lastHotel`.) Server data belongs to the query cache, keyed by the request (hotel id, filters, range) so switching hotels can never show the previous hotel's data under the new name.
- Reference data (hotels, floors, room types, seasons of the current hotel) is cached for 5 minutes and invalidated by the writes that change it.
- Writes **invalidate** the affected queries; they do not patch the cache by hand. Optimistic updates are not used in Phase 1: every Phase 1 write can be rejected by a server rule (overlap, phase, inactive hotel), so showing success before the server agrees would be wrong.
- Reads that depend on "today" use the hotel's `today` from the server, never the browser clock.
- **Operational dates are strings** (`YYYY-MM-DD`) end to end. They are formatted for display by treating them as calendar dates (formatting in UTC), never converted through the browser's timezone. The shared `dates.ts` is the only date arithmetic.

---

## 40. Component architecture

Three layers, each allowed to use only the layers below it.

**1. UI primitives (from the UI library, lightly wrapped only where we add a rule)**
The library is Nuxt UI v4 (D1). Its theme is replaced, not accepted: colors, radii, shadows, density and typography come from §8–§12 through the library's theming configuration, and no screen may ship with library-default styling.
Button, Input, Select, Combobox, Checkbox, Switch, Tabs, Tooltip, DropdownMenu, Popover, Drawer (Slideover), Dialog (Modal), Toast, Skeleton, Badge, Pagination, DatePicker. Wrapped only where the design system adds behaviour: `ResponsiveSheet` (drawer on desktop, bottom sheet on mobile), `ConfirmDialog` (tiers, §35.4), `DateField` (nights and "available again" hints).

**2. Shared application components (domain-aware, reused across modules)**

| Component | Job |
|---|---|
| `AppShell`, `AppSidebar`, `AppNavRail`, `AppHeader`, `MobileTabBar`, `MoreSheet` | Shell per breakpoint (§3–§5) |
| `HotelSwitcher`, `HotelMarker`, `HotelContextStamp` | Hotel context (§6) |
| `CommandPalette` | Search and actions (§7) |
| `PageHeader` | Breadcrumb, title, actions |
| `FilterBar`, `FilterDrawer`, `FilterChips` | One filtering pattern (end of this section) |
| `DataTable` (+ mobile row slot) | Table system (§16) |
| `BulkActionBar` | Selection pattern (§33) |
| `StatusBadge` + status registry | Status system (§19) |
| `MetricStrip`, `MetricFigure` | Overview figures (§21) |
| `EmptyState`, `ErrorState`, `InaccessibleHotelState` | States (§20) |
| `PermissionGate`, `usePermissions` | §34 |
| `CapacityValue` | Always renders "6 Haji, 6 beds" consistently |
| `NightsRange` | "3–7 Oct (5 nights)" and "Available again from …" |
| `DateText`, `MoneyText` (P3) | Locale-correct formatting |

**3. Domain components (inventory module)**
`RoomCalendar` (toolbar, header rows, virtualized body), `CalendarRow`, `SegmentBar`, `SeasonRibbon`, `DailySummaryRow`, `CalendarLegend`, `CalendarCellDrawer`, `CapacityTimeline`, `CapacityImpactPanel`, `RoomSelector` (reused by the season builder and, in Phase 2, allocation), `BlockForm`, `SeasonForm`, `RoomForm`, `BulkRoomsForm`, `FloorForm`, `RoomTypeForm`.

**Page components** live in `app/pages/**` and compose the above; they own data fetching and URL state.

Not componentised: one-off layout inside a page, simple text blocks, and single-use lists. A component is extracted when a second screen needs it, except for the shell, status, capacity and date components above, which are shared from day one because consistency is their purpose.

**Folder layout (proposed):**
```text
app/
  components/
    shell/       AppShell, AppSidebar, AppNavRail, AppHeader, MobileTabBar, HotelSwitcher, CommandPalette …
    common/      PageHeader, DataTable, FilterBar, StatusBadge, EmptyState, CapacityValue, NightsRange …
    inventory/   RoomCalendar/*, CapacityTimeline, RoomSelector, BlockForm, SeasonForm …
    hotel/       HotelForm, HotelSettingsPanels, FloorForm …
  composables/   usePermissions, useHotelScope, useFilters (URL-synced), useDateFormat …
  stores/        session.ts, preferences.ts
  pages/         (routes in §41)
  locales/       en.json, ar.json (namespaced: nav, status, errors, inventory, …)
```

**Filter pattern (the "one consistent filtering pattern" requirement):** simple pages (hotels, floors, room types) use inline filters only. Complex pages (rooms, calendar, blocks) use a toolbar with the three most used filters plus "More filters" (a drawer). Active filters appear as removable chips with "Clear all". Every filter lives in the URL, so back/forward and shared links restore it; returning to a list restores its filters and scroll position. Saved filters are a later feature and fit on top of URL state without change.

---

## 41. Route architecture

**Canonical rule (§6.1):** hotel-scoped pages carry the hotel in the path; portfolio pages carry an optional `?hotel=`; organization pages carry none. The hotel appears in URLs by its **code** (for example `/hotels/MKK-GRAND/calendar`). Codes are unique per organization and immutable (Task 12 rule 1), they are readable in shared links, and the hotel list needed to map codes to ids is always loaded for the switcher. Rooms, seasons and blocks use ids (D16). Approved as D4 (§44).

| Route | Page | Phase |
|---|---|---|
| `/login` | Sign-in (§35.1) | P1 |
| `/` | Redirects to the persona's first screen (§35.2) | P1 |
| `/overview` `?hotel=` | Overview (§21) | P1 |
| `/select-hotel?next=` | Hotel chooser for hotel-scoped links without a last hotel | P1 |
| `/hotels` | Hotels list (§22) | P1 |
| `/hotels/new` | Create hotel (§24) | P1 |
| `/hotels/:hotel` | Hotel profile: Overview tab (§23) | P1 |
| `/hotels/:hotel/floors` | Floors tab (§25) | P1 |
| `/hotels/:hotel/settings` | Settings tab (§24) | P1 |
| `/hotels/:hotel/documents` | Documents tab (Task 19) | P1 (deferrable) |
| `/hotels/:hotel/activity` | Activity tab | P1 |
| `/hotels/:hotel/calendar` | Room calendar (§31) | P1 |
| `/hotels/:hotel/rooms` | Rooms (§27) | P1 |
| `/hotels/:hotel/rooms/:roomId` | Room detail (§28) | P1 |
| `/hotels/:hotel/seasons` | Seasons list (§30.1) | P1 |
| `/hotels/:hotel/seasons/:periodId` | Season detail (§30.3) | P1 |
| `/hotels/:hotel/seasons/:periodId/apply` | Apply capacity builder (§30.3) | P1 |
| `/hotels/:hotel/blocks` | Blocks list (§32.2) | P1 |
| `/room-types` | Room types (§26) | P1 |
| `/admin/demo` | Demo data (§35.3) | P1 (demo only) |
| `/bookings`, `/bookings/:id`, `/bookings/new` `?hotel=` | Front office | P2 |
| `/holds`, `/customers`, `/agents` `?hotel=` | Front office | P2 |
| `/hotels/:hotel/front-desk` | Arrivals and departures | P4 |
| `/finance/*` `?hotel=` | Finance | P3/P5 |
| `/people/*` `?hotel=` | People | P6 |
| `/reports/*` `?hotel=` | Reports | P8 |
| `/admin/users`, `/admin/settings`, `/admin/audit` | Administration | later |

Sidebar links to hotel-scoped modules resolve with `lastHotel` (§6.2). Unknown or inaccessible `:hotel` shows the inaccessible-hotel state (§6.4).

**Rendering strategy (D2, as modified).** There is **no global `ssr: false`**. Nuxt stays in its default universal mode, and rendering is chosen **per route** with route rules:
- **Signed-in operational routes** (everything in the table above except `/login`) are client-rendered: a route rule `{ ssr: false }` scoped to those route patterns. They are highly interactive, behind authentication (no SEO value), depend on hotel time from the API, and client rendering avoids hydration mismatches for theme, direction and dates. No SSR complexity is added to operational screens.
- **`/login` and any future public or customer-facing pages** keep server rendering (or prerendering), where it gives a measurable benefit: first paint, SEO for public pages, and no JavaScript dependency for simple pages.
- This is the smallest reversible configuration: a list of route patterns in `nuxt.config.ts`. Moving a route to SSR later means removing it from that list and making its data loading SSR-safe; nothing else in the architecture assumes client-only rendering.

---

# Part IV — Reconciliation, decisions and acceptance

## 42. API / DTO reconciliation (Phase 1 Tasks 7, 12–18)

Method: every screen in Part II was traced to the endpoints and response shapes the Phase 1 plan specifies. Each gap below states the current planned shape, what the UI needs, why the current shape is not enough, the smallest change, the owning task, and the affected tests.

**Classification:** NO CHANGE · SMALL PLAN CHANGE · BLOCKING PLAN CHANGE. **No BLOCKING change was found.** **S1–S14 were approved on 2026-09-25 and are integrated into their owning tasks** of the Phase 1 plan (see its "UI/UX reconciliation record"); the plan is the authoritative contract. The entries below keep the reasoning and note where integration refined the draft.

### 42.1 NO CHANGE (the plan already supports the UI)

| # | UI need | How the plan covers it |
|---|---|---|
| N1 | Hotels list search, filter, sort | `GET /api/hotels` returns all accessible hotels; an organization has few enough hotels for client-side filtering. Pagination can be added later if an organization exceeds ~200 hotels. |
| N2 | Permission-aware rendering | `/api/auth/me` returns `permissions`, `allHotels`, `hotelIds` fresh (Task 7). Per-hotel rules are `permission AND hotel access`, which the client can mirror for display (§34). No per-resource capability flags needed. |
| N3 | Calendar without per-cell requests | Run-length segments, filters, pagination ≤ 200, `statusMatch` (Task 18) match the rendering design (§31.2). |
| N4 | Calendar header totals | `GET …/inventory/daily-summary` with floor and type filters (Task 18). |
| N5 | Localized errors | Stable `data.code` + `details` (Task 5). The client localizes by code using context it already has (e.g. the current version's start date for `BASE_CHANGE_BEFORE_CURRENT`); the verified rule modules don't need to change. Client-side validation uses the shared Zod schemas. |
| N6 | Room number immutable in UI | D16 and Task 14 rule 5 match §27–§28. |
| N7 | Bulk block and bulk floors/rooms | `room-blocks/bulk` (`roomIds | floorId`, ≤ 200), `floors/bulk`, `rooms/bulk` with `details.conflicts` / `details.existing` (Tasks 13, 14, 16). |
| N8 | Blocks list windows | `room-blocks?from&to` (≤ 400 nights) supports "Now and upcoming" and "History" (§32.2). |
| N9 | Room-number search in the command palette | `GET …/rooms?q=` prefix search (Task 14). |
| N10 | All-hotels Overview | Organization averages with `perHotel` (Task 17) + one `daily-summary` call per accessible hotel. Acceptable up to about 10 hotels (the demo has 5). An organization-level daily summary is a Phase 8 dashboard concern, not needed now. |
| N11 | Hotel-access assignment UI | Not built in Phase 1: the API (Task 7) takes a user id but there is no user list endpoint, so there is nothing to pick from. Demo access is seeded (Task 20); the UI arrives with Users & Roles. |
| N12 | Inactive hotel behaviour | Hotel `status` in the DTO + `409 HOTEL_INACTIVE` (Tasks 12–16) drive the banner and disabled actions. |

### 42.2 SMALL PLAN CHANGES (approved and integrated)

**S1 — Session context for the shell** · Task 7
- *Current:* `GET /api/auth/me` → `{ user, permissions, allHotels, hotelIds }`.
- *UI needs:* organization name (sidebar, user menu), whether it is the demo organization (Demo tag, Demo data page), and the user's role names (user menu, persona clarity).
- *Why insufficient:* none of these are in the response or any other Phase 1 endpoint.
- *Smallest change:* add `organization: { id, name, slug, isDemo }` and `roles: [{ key, name }]` to the `me` response, resolved in the same per-request context.
- *Tests:* Task 7 `authContext` tests and Task 8 HTTP `me` test assert the new fields; a cross-org check that `organization` is always the user's own.

**S2 — Hotel DTOs, including the hotel's "today"** · Task 12 (fields added by 13 and 14)
- *Current:* `listHotels`/`getHotel` return `HotelDetail`, but the plan never defines its fields; `floorCount` (Task 13) and `roomCount` (Task 14) are mentioned for the detail only.
- *UI needs:* list and switcher: `id, code, name, city, country, status, timezone, today`; list also `floorCount, roomCount`; detail adds address, contact, check-in/out, currency, ownership, license, notes, timestamps.
- *Why insufficient:* shape unspecified; and **`today` is essential**: every default date (calendar start, "as of", block start, season phase copy) must be the hotel's local date. A user in UTC+6 at 01:00 is still on the previous day in Riyadh; using the browser's date would be wrong (D5 already requires hotel-local today on the server).
- *Smallest change:* define `HotelSummary` (list) and `HotelDetail` in Task 12 with `today: IsoDate` computed by `todayInTimezone(hotel.timezone, now)`; list items include `floorCount` and `roomCount` (Tasks 13/14 add them to both shapes). *Integrated with one refinement:* both counts are `null` for callers without `room.view` (Accountant, HR), so the hotel list reveals no inventory to them.
- *Tests:* Task 12 integration (shape, `today` with an injected clock around midnight in `Asia/Riyadh`), Task 13/14 count tests extended to the list.

**S3 — Audit read usable as history** · Task 12
- *Current:* `GET …/audit-log`, `audit.view`, `limit ≤ 100`; `listHotelAudit(ctx, hotelId, filter)` with the filter unspecified; entries carry `actorUserId` only.
- *UI needs:* Activity tab with "load older"; per-entity history in room detail and block/season detail; who did it by name.
- *Why insufficient:* no entity filter, no cursor, no actor name. The plan already creates the index `(org, entity_type, entity_id, created_at)` that this needs.
- *Smallest change:* query `entityType?, entityId?, action?, cursor?` (keyset on `createdAt,id`; *integrated as `cursor`, not `before`, to avoid clashing with the item's `before` data field*), `limit ≤ 100`; items `{ id, action, entityType, entityId, actor: { id, fullName } | null, before, after, reason, createdAt }`, `nextCursor`. Actor names are joined within the organization only.
- *Tests:* Task 12 audit tests (filter, cursor stability, org-scoped actor join, a foreign `entityId` returns nothing).

**S4 — Counts on floors and room types** · Tasks 13 and 14
- *Current:* floor and room-type list DTOs unspecified; `countInInventoryOnFloor` exists in the repository (Task 14).
- *UI needs:* "Rooms" per floor (§25); "Rooms using it" per type, needed for the "existing rooms keep their capacity" message (§26).
- *Smallest change:* floor list items add `roomCount` (in inventory today, Task 14). Room type list items add `usageCount` (rooms in inventory today, whole organization) **only for callers with `allHotels`**, else `null`, so hotel-scoped users do not learn room counts of hotels they can't see.
- *Tests:* Task 14 counts; a hotel-scoped caller receives `usageCount: null`.

**S5 — Room list item and room detail shapes** · Task 14 (fields added by 15 and 16)
- *Current:* list items carry `inInventory, baseCapacity, effectiveCapacity (source, periodId)`; `GET …/rooms/:roomId` shape unspecified.
- *UI needs:* the rooms table's Status and Next change columns (§27) and the room detail sections (§28).
- *Why insufficient:* status (blocks) and next change are not in the list; the detail has no defined shape; showing a season needs its name, not only its id.
- *Smallest change:*
  - List item: `{ id, roomNumber, floor: { id, level, label }, roomType: { id, code, name }, features, inInventory, lifecycle: { inServiceFrom, lastNight | null }, base, effective: { physicalBeds, sellableCapacity, source, period: { id, name, kind } | null }, status, nextChange }` for `asOf`.
  - `status`: the inventory status on `asOf`, computed by the existing `buildRoomSegments` over a one-night range (Task 16 adds it when blocks exist; until then `AVAILABLE`/`NOT_IN_INVENTORY`).
  - `nextChange`: `{ kind: 'CAPACITY' | 'ENTERS_INVENTORY', date, capacity } | { kind: 'LEAVES_INVENTORY', date } | null` — the first night after `asOf` (within 400 nights) where effective capacity, its source or period, or inventory membership changes. *Integrated as* a new pure function `nextCapacityChange` in `server/domain/inventory/nextChange.ts`, created in Task 14 (base versions) and extended in Task 15 (seasons), built only on the verified `capacitySegments`, which stays unchanged.
  - Detail: the list item plus `notes`, `baseVersions: [{ id, validFrom, validTo, physicalBeds, sellableCapacity, origin, reason, createdAt }]` and `seasons: [{ overrideId, period: { id, name, kind, startDate, endDate, phase }, physicalBeds, sellableCapacity }]` (all, typically under 20 per room).
- *Tests:* Task 14 (shape, lifecycle), Task 15 (`nextCapacityChange` unit cases incl. season start, season end, base change, retirement, nothing within 400 nights), Task 16 (status on a blocked night; maintenance with the setting off).

**S6 — Season impact preview** · Task 15
- *Current:* `POST …/overrides` applies immediately; `FAIL` returns 409 with `details.skipped`, `SKIP` writes.
- *UI needs:* "Show impact before saving" (§30.3): rooms changing, skipped with reasons, per-room before/after, hotel totals before and during.
- *Why insufficient:* there is no way to see the result without writing it. Computing it in the browser would duplicate the DELTA rule (base on the first night), the in-inventory rule and the overlap rule, which principle 2 forbids.
- *Smallest change:* `POST …/capacity-periods/:periodId/overrides/preview` with the same body as apply, same validation and same pure functions, **no write, no audit**. Response: `{ applied: [{ roomId, roomNumber, before: { physicalBeds, sellableCapacity }, after: {…} }], skipped: [{ roomId, roomNumber, reason }], totals: { rooms, bedsBefore, bedsAfter, sellableBefore, sellableAfter }, hotelTotals: { roomsInInventory, sellableBefore, sellableDuring } }`, all measured on the period's first night. Permission `capacity.manage` (it reveals nothing a `room.view` user can't see, but it is part of a write flow).
- *Tests:* preview equals the subsequent apply result; preview writes nothing (row counts and audit unchanged); same 422/404 cases as apply.

**S7 — Season list and detail fields** · Task 15
- *Current:* period DTO unspecified beyond the stored columns.
- *UI needs:* phase badges and phase-dependent actions; nights; rooms affected; capacity change (§30.1).
- *Why insufficient:* phase must be computed with the **hotel's** today (server rule `periodPhase`); the browser must not compare dates to decide what's editable.
- *Smallest change:* add `phase` (via `periodPhase`), `nights`, `overrideCount`, and `impact: { sellableDelta, bedsDelta }` measured on the first night.
- *Tests:* Task 15 integration with an injected clock at the boundaries (`04-30`, `05-01`, `07-31`, `08-01`).

**S8 — Remove several rooms from an upcoming season at once** · Task 15
- *Current:* `DELETE …/overrides/:overrideId`, one at a time.
- *UI needs:* "Remove from season" for a selection (§30.3), which is common when correcting a Hajj configuration of 70+ rooms.
- *Why insufficient:* N sequential requests are slow, can half-succeed, and write N audit rows for one intent.
- *Smallest change:* `POST …/capacity-periods/:periodId/overrides/remove { overrideIds }` (≤ 1,000), FUTURE-only, one transaction, one `CAPACITY_OVERRIDES_REMOVED` audit row; ids outside the period → 422 `INVALID_REFERENCE`.
- *Tests:* atomicity, phase guard, foreign ids, audit.

**S9 — Explicit cap for `roomIds` in the override selector** · Task 15
- *Current:* `uniqueIds(max)` with the maximum not stated for this selector.
- *UI needs:* the builder sends explicit `roomIds` for "select all matching" (§30.3), which can exceed 200 in a large hotel.
- *Smallest change:* state the cap as **1,000** (well above realistic hotels; the calendar rejects > 5,000 candidates) and add it to `shared/constants/inventory.ts`.
- *Tests:* 1,000 accepted, 1,001 → 422.

**S10 — Block list item** · Task 16
- *Current:* block DTO unspecified; cancel behaviour depends on dates vs the hotel's today.
- *UI needs:* room number, phase (which dialog to show: cancel vs end early), nights, creator's name (§32.2).
- *Smallest change:* `{ id, room: { id, roomNumber }, kind, startDate, endDate, nights, reason, phase: 'UPCOMING' | 'RUNNING' | 'ENDED' | 'CANCELLED' | 'ENDED_EARLY', createdBy: { id, fullName }, createdAt, cancelledAt, cancelledBy, cancelReason }`, with `phase` computed with the hotel's today. *Integrated with one refinement:* the DTO also carries `cancelAction` (`CANCEL` | `END_EARLY` | `null`, from the verified `planBlockCancellation`) and `endedEarly` (S11). The dialog follows `cancelAction`, because a block starting tonight displays as Running yet is fully cancellable. `phase` comes from a new pure `blockPhase` in `blockRules.ts`.
- *Tests:* phase at the boundaries (starts today, ends today, ended yesterday), cancelled, ended early.

**S11 — Record "ended early" on the block row** · Task 16 (schema; migration `0006` is not written yet)
- *Current:* ending a running block early only moves `end_date` to yesterday; the reason and the original end date exist only in the audit row.
- *UI needs:* the blocks list and room history show "Ended early on 25 Sep (planned until 10 Oct): Repair finished" to anyone who can see the block (§32.2).
- *Why insufficient:* Reception and Reservation Managers lack `audit.view`, so they would see a block that silently became shorter, with no reason.
- *Smallest change:* add `ended_early_at timestamptz`, `ended_early_by uuid`, `original_end_date date` to `room_operational_block`, and store the required reason in the existing `cancel_reason`. No constraint changes (the exclusion constraint already uses `end_date`).
- *Tests:* end-early sets the three columns; cancel does not; phase `ENDED_EARLY`.
- *Ruling:* approved (D12); the alternative (audit-only visibility) was not taken.

**S12 — Organization averages: defaults and per-hotel shape** · Task 17
- *Current:* `GET /api/capacity/averages?date&hotelIds` returns combined averages plus `perHotel: [{ hotelId, code, name, …average }]`; `date` default unspecified for multiple hotels.
- *UI needs:* the hotels list and Overview show each hotel's "tonight" figures.
- *Smallest change:* state that when `date` is omitted each hotel uses **its own** today, and that `perHotel` items carry the same keys as the top level (`base`, `dateEffective`) plus `date`.
- *Tests:* Task 17 organization test asserts per-hotel dates and keys.

**S13 — Calendar metadata and reference details** · Task 18
- *Current:* `{ range, page, pageSize, total, rooms: [{ …, segments }] }`; segments carry `periodId` and `blockIds` only.
- *UI needs:* tooltips and the cell drawer show the season's name and the block's kind, dates and reason (§31.4); the legend must say whether maintenance stops sales at this hotel; defaults need the hotel's today.
- *Why insufficient:* without names and reasons, the client must fetch all seasons and page through every block in the range, which can exceed the 200-item block page and adds calls that the segment design was meant to avoid.
- *Smallest change:* add `meta: { today, maintenanceBlocksSales }` and `refs: { periods: { [id]: { name, kind, startDate, endDate } }, blocks: { [id]: { kind, startDate, endDate, reason } } }` containing **only** the ids referenced by the rooms on this page. The same pattern later carries `refs.bookings` in Phase 2. The capacity-timeline endpoint gets the same `refs.periods`.
- *Tests:* every referenced id is present in `refs` and no unreferenced id is; response size stays under the Task 18 bound (2 MB for 2,000 rooms); `refs` never includes another hotel's rows.

**S14 — Demo persona display names and demo sign-in data** · Task 20
- *Current:* personas have keys, roles and hotel access; no display names are specified.
- *UI needs:* realistic names in the user menu, activity entries and the persona picker (§35.1).
- *Smallest change:* give each persona a realistic full name (a mix of Saudi and international names) in `personas.ts`. *Integrated differently from this draft:* importing a persona module "in demo builds" would need a demo-only build, contradicting ARCHITECTURE §17 (one image; environments differ only by configuration) and D9 (no demo credentials in production deployments). Task 20 instead adds `GET /api/public/demo-sign-in`, which returns the slug, the demo password and the persona list only when `APP_ENV` is development or demo **and** `DEMO_SIGN_IN_ENABLED=true`, and otherwise answers 404. The persona catalogue lives server-side in `server/demo/personas.ts`, shared by the seed and the endpoint.
- *Tests:* `demoPersonas` checks names and unchanged permissions; `demoSignIn` (integration + HTTP) checks every gating case, including 404 under `APP_ENV=production` with the flag set, and that the payload holds no hash, id or other organization's data.

### 42.3 Mechanical plan edits already made

- Task 14's test list had two items numbered 15 after the previous revision; the HTTP item is now 16. No content changed.
- After approval, S1–S14 were written into Tasks 6, 7, 8, 12–18, 20 and 21 and Part C; see the plan's "UI/UX reconciliation record" for the item-to-task map, the artifacts that need re-verification, and the one dependency change (Task 14 now depends on Task 11).

---

## 43. Task 20 demo-persona reconciliation

| Persona | Access | Switcher state | Phase 1 experience | Verdict |
|---|---|---|---|---|
| `admin` (Super Admin) | All 5 hotels | "All hotels (5)" grouped by city | Everything, including create hotel, room types, Demo data | Good: shows the full product |
| `manager.grand` (Hotel Manager) | MKK-GRAND | Static label, one hotel | Manage floors, rooms, capacity, seasons, blocks; Activity; room types read-only; no create hotel | Good: visibly different from Super Admin |
| `manager.madinah` (Hotel Manager) | MED-CENT, MED-QUBA | "All my hotels (2)" | Same as above across two hotels | Good: shows multi-hotel for a restricted user |
| `reservations` (Reservation Manager) | 3 Makkah hotels | "All my hotels (3)" | Read-only inventory: calendar, rooms, seasons, blocks | Acceptable: Phase 1 has no booking actions; the value is showing scoped, read-only access |
| `reception.grand`, `reception.ajyad` (Reception) | One hotel each | Static label | Read-only calendar and rooms; mobile Rooms tab | Good for mobile demos; stays without `room.block` (D10) |
| `management` (Read-only Management) | All hotels | "All hotels (5)" | Overview and every inventory page, no buttons | Good: demonstrates permission-aware UI |
| `accountant` (Accountant) | All hotels | "All hotels (5)" | **Hotels list only** (no `room.view`) | Correct by least privilege, but a thin demo |
| `hr` (HR Manager) | 3 hotels | "All my hotels (3)" | **Hotels list only** | Correct, but a thin demo |

**Findings:**
1. **All switcher states are covered** (one hotel, several hotels, all hotels). Inactive hotel and lost access cannot be demonstrated without admin UI; this is fine for Phase 1.
2. **Hotel Manager and Super Admin differ visibly** in navigation and actions, as required.
3. **Accountant and HR have almost nothing to see in Phase 1.** Recommendation: keep their permissions unchanged (least privilege). In the persona picker, show them under "Available in later phases" (still able to sign in), rather than granting `room.view` just to fill the demo. **Ruled (D13):** permissions stay as they are; the picker labels them "Available in later phases".
4. **Display names are missing** (S14).
5. **Demo freshness:** blocks "running at the anchor" (2026-09-01) have partly ended by today (2026-09-25). The Demo data page's "Move demo dates to start from today" (default on) uses the existing `anchorDate` parameter, so no plan change is needed.
6. **No hotel-assignment changes are needed.** The table matches the UI's switcher and navigation rules as written.

---

## 44. UX decisions (resolved 2026-09-25)

All fifteen decisions were ruled on by the human partner. None remains open. Two rulings carry follow-up items that stay visible until they are closed (§44.2).

### 44.1 Rulings

| # | Decision | Ruling | Where it applies |
|---|---|---|---|
| D1 | UI library | **Approved:** Nuxt UI v4 on Tailwind CSS v4 and its accessible primitives. The application must **not** look like a default Nuxt UI admin template: this document's tokens, spacing, typography, status system, responsive behaviour and "Marble and dusk" identity are authoritative and override library defaults (theme, radii, shadows, colors, density). | §8–§12, §40 |
| D2 | Rendering | **Approved with modification:** no global `ssr: false`. Signed-in operational routes are client-rendered through route-scoped rules; `/login` and future public or customer-facing pages keep server rendering where it helps. Smallest reversible configuration. | §41 "Rendering strategy" |
| D3 | Server state | **Approved:** TanStack Query for Vue for all server data. Pinia only for small client state: session presentation, UI preferences, `lastHotel`, theme and language where needed. Server data is never copied into Pinia. The URL stays authoritative for hotel context, filters and navigation state. | §39 |
| D4 | Hotel identifier in URLs | **Approved:** the immutable hotel code (`/hotels/MKK-GRAND/rooms`). Internal relationships keep database ids; the room number is never an identity key (D16 of the plan). | §6, §41 |
| D5 | Calendar and digits | **Approved:** the Gregorian calendar is the authoritative operational calendar; Western digits in English and Arabic; Hijri only as optional secondary context later; season dates are always configured, never derived from a religious calendar. | §13 item 9 |
| D6 | Arabic time axes | **Approved as a reversible default:** the Arabic UI is fully RTL and time axes run right to left by default, through one configuration value (`timeAxisDirection`) so usability testing can change it without redesign. | §13 item 5 |
| D7 | Typeface | **Approved:** IBM Plex Sans and IBM Plex Sans Arabic, self-hosted when UI work begins; tabular figures for operational data. | §9 |
| D8 | Visual identity | **Approved:** "Marble and dusk": calm neutral surfaces, deep green for interaction, indigo only for seasonal capacity, no decorative religious or tourism styling. | §1.1, §8, §11 |
| D9 | Demo persona picker | **Approved for demo deployments only:** the picker appears only when the gated demo sign-in endpoint answers; production sign-in shows no demo shortcuts or credentials, and the client bundle contains none. | §35.1; plan Task 20 |
| D10 | Reception blocking rooms | **Approved: no.** Reception stays read-only for inventory in Phase 1; later maintenance or request workflows provide the operational path. | §34, §43; plan Part C §6 |
| D11 | Changing a running season | **Approved for Phase 1:** the guided three-step workflow, explained before anything is written; no hidden mutation of historical nights. An atomic "Adjust season from date" operation is a recorded future enhancement, not built in Phase 1. | §30.4; plan Part C §2 |
| D12 | Ended-early blocks | **Approved:** S11. The block row records the early end so users without `audit.view` understand it; the immutable audit row is kept too. | §32.2; plan Task 16 |
| D13 | Accountant and HR in the demo | **Approved:** no artificial inventory permissions; their persona tiles say "Available in later phases" until Finance and HR modules exist. | §35.1, §43; plan Task 20 |
| D14 | Bilingual entity names | **Approved for Phase 1 with a future requirement:** single entity names in Phase 1; localized names are a required pre-production review item; no Phase 1 schema choice may make them hard to add. UI chrome supports English LTR and Arabic RTL from the start. | §13 item 11; plan Part C §2 |
| D15 | S1–S14 | **Approved as a set**, subject to the rulings above, and integrated into the Phase 1 plan. | §42 |

### 44.2 Follow-up items that remain visible

| Item | From | When it must close |
|---|---|---|
| **Usability validation of the Arabic time-axis direction** (right-to-left vs left-to-right for calendar and timeline) with Arabic-speaking reception and reservations staff | D6 | Before the first Arabic-speaking production customer; the result sets `timeAxisDirection`'s default |
| **Bilingual / localized entity names and business content review** | D14 | Before onboarding Arabic-speaking production customers |
| **Atomic "Adjust season from date" server operation** | D11 | Future enhancement; not scheduled |

Decisions made in this document without needing approval (reversible, within the brief): navigation structure (§2), breakpoints (§15), drawer/modal/page rules (§18), status registry (§19), confirmation tiers (§35.4), table and form rules (§16–§17), tab bar contents (§5).

---

## 45. Phase 1 UI acceptance criteria

The Phase 1 UI is complete only when all of these hold, on the demo dataset, in English and Arabic, in light and dark mode:

**Shell and context**
1. Desktop, tablet and mobile shells behave as §3–§5; navigation shows only implemented and permitted modules, per the §2.2 persona table.
2. The hotel context is visible on every hotel-scoped page and in every write drawer and confirmation; switching hotel keeps the user on the same page, clears selections and never shows the previous hotel's data.
3. Lost access, unknown hotel, inactive hotel and expired session each show their designed state (§6.4).

**Correctness**
4. Every capacity, average, status, phase and "today" shown comes from the API; a test (or code review checklist item) confirms no Vue code re-derives capacity, status or phase.
5. The requirement examples are visible through the UI: Room 401 shows 4 Haji / 4 beds, then 6 / 6 from 1 May to 31 Jul 2027 (Hajj 2027), then 4 / 4 from 1 Aug, in both the calendar and the capacity timeline; Al Safa Ajyad Towers shows an average of 3.88.
6. Beds and Haji capacity are never shown as a single number.
7. Operational dates are correct for a browser in UTC+6 between 00:00 and 03:00 (when Riyadh is still on the previous day).
8. Room numbers cannot be edited after creation; the edit form shows them read-only.
9. Editing a room type's defaults shows the "existing rooms keep their capacity" message, and existing rooms are unchanged afterwards.

**Workflows**
10. A Hotel Manager can, without a mouse: create floors in bulk, add rooms by range, create a season, apply seasonal capacity with an impact preview (S6) and skipped-room reasons, block a room from the calendar selection, and end a running block early.
11. Every 409 and 422 the Phase 1 API can return has a translated, actionable message in both languages (a test checks that every server error code has an `en` and `ar` string).
12. Every destructive or high-risk action uses its confirmation tier (§35.4); Demo reset requires the typed phrase.

**Calendar**
13. 100 rooms × 31 nights renders in under 1 s and scrolls smoothly; the grid never issues a request per cell; rows are virtualized beyond 60 rooms.
14. All filters, zoom levels, today/previous/next, drag selection, keyboard navigation and the detail drawer work; the URL restores the exact view.
15. On mobile, the Rooms tab's Day and Week modes work with touch only.

**Accessibility and quality**
16. Automated accessibility checks (axe) pass on every Phase 1 page in both languages and themes; manual keyboard and screen-reader passes on Overview, Rooms, Room detail, Calendar and the block and season flows.
17. Contrast targets in §8 are verified in both themes; statuses are distinguishable in grayscale.
18. Arabic review: layout mirrored per §13, identifiers readable, digits and Gregorian dates as decided (D5).
19. End-to-end tests (Playwright) cover each persona's navigation and the golden paths above, plus server-side 403/404 when a hidden action's URL is called directly.
20. The demo can be reset from the UI and returns to the Hajj story on first sign-in for each persona.

**Rulings (§44)**
21. No Phase 1 screen shows library-default styling; a side-by-side review against §8–§12 passes for every page (D1).
22. Only the signed-in operational routes are client-rendered, through route-scoped rules; there is no global `ssr: false`, and `/login` renders on the server (D2).
23. Switching `timeAxisDirection` to left-to-right in Arabic changes the calendar and capacity timeline correctly with no component change (D6); the usability-validation item stays open until tested with Arabic-speaking staff.
24. A production configuration (`APP_ENV=production`) shows the plain sign-in form, the demo sign-in endpoint answers 404, and the built client bundle contains no demo password or persona data (D9).
