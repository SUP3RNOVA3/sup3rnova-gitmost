# Gitmost — Manual Test Plan (develop)

Scope: full product manual QA pass. Goal is to surface **bugs, UI clunkiness/inconsistency, error states, edge cases, and "not-a-bug-but-sloppy" issues**. Each case: steps → expected. Execution is via a real browser against a fresh stand. Bugs found feed Gitea issues.

Conventions:
- **Admin** = the first registered user (workspace owner). **Member/Viewer** = a second/third user with lower role.
- "Two tabs" = same or different users in two browser contexts for collaboration.
- Pay attention to: toast presence/absence & wording, loading/empty states, disabled-button correctness, label/terminology consistency, focus behavior, keyboard nav, responsiveness, and validation parity (client vs server).

---

## A. Auth, Setup, Session

- **TC-AUTH-01** First-run setup: visit `/setup/register`, submit with valid workspace name/user/email/password (≥8). Expect: workspace+admin created, redirect to /home. Check: any success toast? smooth redirect?
- **TC-AUTH-02** Setup validation: empty workspace name (allowed), name with a URL (NoUrls), password <8, invalid email. Expect: inline client errors; server rejects URL-in-name. Check client/server parity.
- **TC-AUTH-03** Setup when workspace already exists: navigate to /setup/register again. Expect: blocked/redirected (setup guard).
- **TC-AUTH-04** Login happy path. Check redirect target, cookie set, "remember" behavior if any.
- **TC-AUTH-05** Login wrong password / unknown email. Expect identical message "Email or password does not match" (no user enumeration). Check timing not obviously different.
- **TC-AUTH-06** Login rate limiting: repeated failures. Expect throttle kicks in; check the message/UX when throttled.
- **TC-AUTH-07** Logout. Expect cookie cleared, redirect to login (?logout=1). Check no flashes of authed content.
- **TC-AUTH-08** Forgot password: submit known + unknown email. Expect identical "reset link sent" message (no leak), form disabled after.
- **TC-AUTH-09** Password reset via token: valid token → set new password (≥8). Expect success toast + login/redirect; all other sessions revoked.
- **TC-AUTH-10** Password reset invalid/expired token. Expect "Invalid or expired token".
- **TC-AUTH-11** Invitation accept (`/invites/:id?token=`): correct name/password; email read-only prefilled. Expect account created + logged in. Check name min/max (2-60) parity.
- **TC-AUTH-12** Invitation: reuse an already-accepted invite link. Expect graceful "already accepted"/invalid, not a crash.
- **TC-AUTH-13** Sessions list (account settings): shows current device first, device names parsed, last-active. Revoke another session; "log out other devices". Check labels and that current session can't be accidentally killed.
- **TC-AUTH-14** Direct-URL access to an authed route while logged out → redirect to login, then back after login.

## B. Account & User Settings

- **TC-USER-01** Update profile name: valid, empty, whitespace-only, very long (>40 client / >50 server), name containing a URL. Expect inline validation; success toast "Updated successfully".
- **TC-USER-02** Avatar upload: PNG/JPG ok; >10MB rejected ("Image exceeds 10MB limit."); try a non-image renamed to .png. Remove avatar. Check optimistic update + error toast paths.
- **TC-USER-03** Change password: wrong current → "Current password is incorrect"; correct → success, other sessions revoked, current stays. Min length parity.
- **TC-USER-04** Theme/language/preferences toggles (if present): switch theme (light/dark), language; check immediate apply + persistence across reload.
- **TC-USER-05** "Change email" — confirm it is hidden/non-functional (half-built); ensure no dead button is reachable.
- **TC-USER-06** Editor preferences (toolbar toggle, full-width, compact tree) if present: toggle and verify effect + persistence.

## C. Workspace Settings (admin) & Permission Gating

- **TC-WS-01** Update workspace name: valid; empty (no min length?) — check whether "" is accepted; non-admin sees read-only.
- **TC-WS-02** Workspace logo upload (if present): size/type validation, remove.
- **TC-WS-03** HTML-embed toggle: on/off; optimistic + revert on failure; non-admin disabled.
- **TC-WS-04** Analytics/tracker HTML field: paste snippet, >20,000 chars rejected; verify it only injects on public share pages, not private; non-admin disabled.
- **TC-WS-05** AI enable/generative/dictation toggles: flip each; verify the corresponding UI (Ask AI button, mic button, chat) appears/disappears accordingly.
- **TC-WS-06** Non-admin visiting `/settings/workspace`, `/settings/members`, `/settings/ai`: expect read-only or blocked; no crash, clear gating.

## D. Members, Invitations, Groups

- **TC-MEM-01** Invite members: multiple emails (TagsInput), pick role, pick groups; invalid email filtered; >50 emails. Expect invites created; check success toast (reportedly missing).
- **TC-MEM-02** Admin cannot invite OWNER role (filtered client, rejected server). Verify OWNER not selectable / rejected.
- **TC-MEM-03** Invites tab: resend, copy link (self-hosted), revoke (confirm modal). Check toasts (reportedly missing) and table refresh.
- **TC-MEM-04** Members tab: change role, deactivate/activate, delete (irreversible confirm). Check self-targeting (can I delete/deactivate myself? change my own role?). Status badges Active/Deactivated.
- **TC-MEM-05** Deactivated member cannot log in; reactivate restores access.
- **TC-MEM-06** Members search + pagination (100/page).
- **TC-GRP-01** Create group: name (2-100), description (≤500), add members (≤50). Check success toast/redirect.
- **TC-GRP-02** Group members: remove member (confirm modal warns about losing access); add members. Self-removal behavior.
- **TC-GRP-03** Default "Everyone" group behavior; can it be deleted/renamed?

## E. Spaces

- **TC-SPACE-01** Create space: name (2-100), slug (alphanumeric, auto-generated from name as you type, 2-100), description (≤500). Watch slug live-generation quirks (single-char words, spaces, unicode).
- **TC-SPACE-02** Duplicate slug → "Space slug exists…" red toast.
- **TC-SPACE-03** Edit space: change name/slug/desc; only dirty fields sent; save disabled when clean; slug uniqueness excludes self.
- **TC-SPACE-04** Delete space: type-name-to-confirm (case-insensitive); destructive; redirect to /home. Try wrong name → confirm disabled.
- **TC-SPACE-05** Space members & roles (ADMIN/WRITER/READER): change role, remove; infinite scroll; search.
- **TC-SPACE-06** Space grid / switcher: favorite a space, default space; only member spaces shown; create-space entry.
- **TC-SPACE-07** Space home + space settings tabs; non-member access attempt.

## F. Pages & Tree

- **TC-PAGE-01** Create root page and child page; "Untitled" default; slugId generated; watcher auto-add.
- **TC-PAGE-02** Rename via tree inline edit and via editor title; rename to empty (→ "Untitled"); very long title; emoji in title.
- **TC-PAGE-03** Set icon/emoji on a page; remove icon; verify tree + breadcrumb reflect it.
- **TC-PAGE-04** Move page within tree via drag-drop: reorder-before/after, make-child; drop indicators; auto-expand-on-hover (500ms); revert on server error.
- **TC-PAGE-05** Move into own descendant: attempt via DnD (client blocks) — verify it's actually blocked and not silently allowed.
- **TC-PAGE-06** Move page to another space: with accessible + inaccessible children; verify inaccessible children orphan to root in source; permission checks; "already in this space".
- **TC-PAGE-07** Duplicate page (same space → sibling) and copy-to-space; deep tree; mixed permissions skip inaccessible. Check toast wording ("duplicated" vs "copied").
- **TC-PAGE-08** Expand-all / collapse-all; lazy-load children; open-state persistence on revisit; large tree.
- **TC-PAGE-09** Breadcrumbs: >3 levels collapse to popover; deep page not preloaded (lazy ancestry fetch); click each crumb; mobile hamburger.
- **TC-PAGE-10** Page header menu actions inventory: verify each action works and labels are consistent ("Move" vs "Move to space", "Delete" vs "Move to trash").
- **TC-PAGE-11** Concurrent tree ops in two tabs: create/move/rename in tab A reflect in tab B (server-authoritative broadcast). Watch for stale chevrons / hasChildren flips.

## G. Trash, History, Favorites, Labels

- **TC-TRASH-01** Soft-delete page ("Move to trash", 30-day note); children remain; current page deleted → redirect.
- **TC-TRASH-02** Trash list: view content modal, deleted-by/at, restore, delete-forever (admin only), empty state, pagination (50).
- **TC-TRASH-03** Restore page whose parent is still deleted → where does it land? (orphan behavior).
- **TC-TRASH-04** Permanent delete cascades to children; non-admin blocked.
- **TC-HIST-01** Page history list; open a version; restore version (creates new entry); diff/highlight-changes toggle; agent-vs-human attribution.
- **TC-FAV-01** Favorite/unfavorite page; star toggles; favorites list (infinite, 15); rapid double-toggle.
- **TC-LABEL-01** Add label: valid name (lowercase regex), invalid (uppercase/spaces), ≤100; create-new vs select-existing; duplicate prevented; remove label.
- **TC-LABEL-02** `/labels/:labelName` page: list pages with the label; pagination; nonexistent label.

## H. Editor — Title & Body

- **TC-ED-01** Title: type, 500ms debounce save; Enter splits to body; IME composition; Down-arrow from empty title focuses body; Mod+K opens search; Mod+S suppressed.
- **TC-ED-02** Body: type, formatting persists; reload keeps content; connection states (Connecting/Connected/Disconnected) shown; idle 5min+tab-hidden disconnect, reconnect on focus.
- **TC-ED-03** Read-only vs edit toggle (admin edit mode atom); read-only hides toolbar, links clickable, comment still possible.
- **TC-ED-04** Undo/redo depth 20; title split uses addToHistory:false (undo doesn't pull body insert).

## I. Editor — Slash Menu & Blocks

- **TC-BLK-01** Slash menu opens on `/`; fuzzy filter; arrow/enter nav; Esc closes. Insert each category at least once.
- **TC-BLK-02** Headings 1/2/3, quote, bullet/numbered/task lists, divider, page break, date insert.
- **TC-BLK-03** Table insert (3×3 header); add/delete row/col before/after; toggle header row/col; cell align; delete table; cell-selection vs text-selection menu precedence; resize columns.
- **TC-BLK-04** Code block: language selector, copy button; Mermaid: default template renders, invalid syntax error state.
- **TC-BLK-05** Callout: color/type switch, delete, nested content.
- **TC-BLK-06** Toggle/details: collapse/expand, content hidden when collapsed.
- **TC-BLK-07** Math inline + block: valid LaTeX renders (KaTeX), invalid shows error/placeholder, empty node.
- **TC-BLK-08** Columns 2-5: insert, move content between, empty columns, responsive stacking.
- **TC-BLK-09** Footnote: insert reference (superscript), definition list at end, click ref→def jump, orphan/undefined ref.
- **TC-BLK-10** Status badge: insert, color picker default gray.
- **TC-BLK-11** Subpages block: lists child pages; updates when children change.
- **TC-BLK-12** Emoji: `:` inline picker, fuzzy search, many-matches scroll, colon-at-EOL precedence over slash.

## J. Editor — Media, Links, Mentions, Paste

- **TC-MED-01** Image upload (slash + drag-drop + paste); placeholder spinner; success swap; >limit rejected ("File exceeds the … attachment limit"); resize handles + aspect lock; alt text; image-as-link.
- **TC-MED-02** Broken image src: paste an image URL that 404s — does the spinner ever resolve/show error, or hang forever?
- **TC-MED-03** Video / Audio / PDF / generic attachment upload; correct MIME gating; multiple-select.
- **TC-MED-04** Paste internal page link (empty selection) → mention; with selection → not converted; HTML table paste; attachment URL re-upload across pages.
- **TC-LINK-01** Link panel: external URL add/edit/unlink; internal page search (≤10 results), keyboard nav; empty URL no-op; invalid URL handling.
- **TC-MENT-01** `@` mention: user + page suggestions; query starting with space ignored; whitespace>4 warn / >7 destroy; outside-click close; in comments & chat composer.
- **TC-EMBED-01** Provider embeds (YouTube/Vimeo/Figma/Loom/GDrive/Sheets/Airtable/Typeform/Miro/Framer/Iframe): insert with URL; invalid URL → provider error; responsive.
- **TC-EMBED-02** HTML embed: only in slash menu when workspace toggle on; sandboxed iframe (no same-origin); edit modal textarea+height; auto-resize clamp 40-4000; disabled-workspace placeholder; read-only viewer rendering.
- **TC-EMBED-03** Page embed: pick page, nested read-only render; self-embed & A→B→A cycle → error placeholder; deleted source → not-found; no-access placeholder; refresh button.
- **TC-EMBED-04** Transclusion/synced block: create source, reference it, edit source propagates; circular ref error; deleted source not-found; unsync→static snapshot; refresh.
- **TC-TMPL-01** Toggle page as template; template embed (page template MVP); refresh action; tree marker icon.

## K. Comments

- **TC-CMT-01** Inline comment: select text → Add comment dialog; empty content blocked; Cmd+Enter submits; highlight applied; selection-text captured (stale selection if doc edited before submit).
- **TC-CMT-02** Comment panel: list resolved/unresolved; reply (1 level only); edit; delete; resolve/unresolve (decoration change); density/hover actions.
- **TC-CMT-03** Mentions & images inside comments.
- **TC-CMT-04** Read-only/shared page commenting (if allowViewerComments): viewer can comment, appears after reload.
- **TC-CMT-05** Two tabs commenting same page / same selection: both appear; no conflict.
- **TC-CMT-06** Comments panel open/close behavior; no auto-open on add (per changelog).

## L. Search & Notifications

- **TC-SRCH-01** Cmd+K spotlight: empty state "Start typing…"; query → results (300ms debounce); navigate to page; Esc closes.
- **TC-SRCH-02** Filters: space selector (All vs specific), content type pages vs attachments; breadcrumb shown only when no space filter; loading state.
- **TC-SRCH-03** No-results state; special characters; very long titles truncation.
- **TC-NOTIF-01** Bell + unread badge; popover Direct/Updates tabs (NOT "Activity"), All/Unread filter; mark-all-read; grouped by time; click navigates + marks read; pagination on scroll.
- **TC-NOTIF-02** Mention notification delivery (tab B mentions tab A's user); notification to a since-deleted page → graceful 404.

## M. AI Chat & Dictation

- **TC-AI-01** Open chat window; drag/resize; minimize/close; geometry clamp to viewport + persistence; auto-collapse on page focus.
- **TC-AI-02** New chat: role cards (enabled roles + universal); pick role; send first message; chatId adoption; streaming; stop (partial retained); token readout.
- **TC-AI-03** Existing chat: switch from history; messages reload; draft persistence across chats/minimize; new-chat clears draft.
- **TC-AI-04** No provider key configured → "AI provider not configured" (503). AI disabled workspace → 403 message. (Configure a provider only if a test key is available; otherwise verify the error UX.)
- **TC-AI-05** Error categories surfaced correctly (connection lost, timeout, rate-limit, quota, auth, context-too-large, generic). At minimum verify the no-key/disabled paths render the structured error, not a raw crash.
- **TC-AI-06** Copy/export conversation as markdown; gating (needs messages loaded).
- **TC-AI-07** Chat history: rename, delete; empty-history state.
- **TC-DICT-01** Mic button states (idle/recording/transcribing/error); volume halo; disabled while streaming.
- **TC-DICT-02** Record + transcribe inserts text (needs STT configured; else verify "Voice dictation is not configured"). Permission denied / no mic / mic-in-use errors. (Browser mic needs secure context — localhost ok.)

## N. Public Sharing

- **TC-SHARE-01** Create share for a page (edit access required); copy link; open in new tab; toggle include-subpages, search-indexing.
- **TC-SHARE-02** Share a restricted page or under restricted ancestor → "Cannot share a restricted page". Sharing disabled at workspace/space → blocked.
- **TC-SHARE-03** Public share page (logged out / incognito): read-only render; subpage navigation when included; SEO meta; robots when indexing off; tracker snippet injected.
- **TC-SHARE-04** Anonymous AI assistant on share (if enabled): chat works, rate-limited; restricted descendants blocked.
- **TC-SHARE-05** Revoke share → link 404s; settings/sharing admin list + revoke.
- **TC-SHARE-06** `/share/:shareId` redirect and `/p/:pageSlug` redirect behavior.

## O. Cross-cutting UI / consistency sweep

- **TC-UI-01** Toast consistency: note every create/update/delete action that gives NO feedback (role change, resend/revoke invite, delete member, create group reported missing) vs ones that do. Inconsistent feedback = issue.
- **TC-UI-02** Loading states: every async action should show a spinner/disabled button; hunt for actions that look frozen (permanent-delete, breadcrumb fetch, expand-all cancel).
- **TC-UI-03** Empty states: every list (trash, favorites, labels, notifications, members, groups, search, chat history) should have a clean empty state, not a blank area.
- **TC-UI-04** Disabled-button correctness: save buttons disabled when clean; submit disabled during request (no double-submit); buttons enabled when they shouldn't be.
- **TC-UI-05** Terminology/label consistency across the app (Delete vs Trash vs Remove; Move vs Move to space; Untitled handling).
- **TC-UI-06** Validation parity: client max-length vs server (name 40 vs 50/60; password min 8 vs login min 1); does hitting server limit show a sane error?
- **TC-UI-07** Responsive: narrow viewport (mobile width) — sidebar, breadcrumbs hamburger, comments panel, AI window, columns stacking, modals.
- **TC-UI-08** Keyboard/focus: tab order in modals, Esc closes popovers/dialogs, focus returns sensibly; spotlight & link/mention combobox arrow-nav.
- **TC-UI-09** Error resilience: navigate to a deleted/nonexistent page URL, a bad /share link, a 404 route — graceful Error404, not blank/crash.
- **TC-UI-10** Optimistic-update reverts: force a failing mutation (offline/devtools) on share toggle, html-embed toggle, page move — does the UI revert cleanly with feedback?

---

### Execution notes
- Run with at least two accounts (admin + member) and two browser contexts for collaboration & permission cases.
- For every observed anomaly, capture: route, exact steps, expected vs actual, screenshot if visual, console/network errors. These become Gitea issues with reproduction steps.

---

## R. Additional flows & code-grounded branches

### A. Auth (branches)
- **TC-AUTH-15** SSO-enforced workspace: password login blocked → 400 "This workspace has enforced SSO login." (EE/SSO-gated; verify message if reachable).
- **TC-AUTH-16** Email-domain allowlist: signup/invite-accept with email outside `workspace.emailDomains` → 400 "domain … is not approved"; no client pre-validation, confirm server error renders cleanly.
- **TC-AUTH-17** (cloud-only) Unverified email login → 400; on self-hosted verify NO email verification is required (no verify route).
- **TC-AUTH-18** MFA login branch: if MFA module bundled, login returns MFA step (TOTP), enforcement & requiresMfaSetup; if not bundled, login proceeds normally (graceful absence). Post-reset MFA → `{requiresLogin:true}` + toast "Please log in to set up two-factor authentication".
- **TC-AUTH-19** Password >70 chars: client allows (min 8 only), server rejects (8-70) — verify sane error.
- **TC-AUTH-06 (expand)** AUTH_THROTTLER = 10 req/60s → 429 after 10th; change-password is SkipThrottle.

### B. Account
- **TC-USER-05 (expand)** Change-email: client submit is a DEAD no-op (sets loading, never calls API) though server flow exists — verify the form looks functional but does nothing (bug candidate).
- **TC-USER-07** Notification preferences: per-type email opt-outs (page.updated, page.userMention, comment.userMention, comment.created, comment.resolved). Toggle each, verify persistence + that disabling suppresses email.

### C. Workspace
- **TC-WS-07** Enable AI semantic search without pgvector → 400 "Make sure pgvector postgres extension is installed"; disabling queues 24h embedding-purge (cancellable). (pgvector IS installed on this stand.)
- **TC-WS-08** disablePublicSharing toggle DELETES all existing shares → flip on with active shares, confirm links 404 (destructive side effect).
- **TC-WS-09** MCP settings visible to ALL roles while AI provider/roles are admin-only — verify non-admin sees MCP but not provider config (gating inconsistency).
- **TC-WS-10** enforceSso with no active auth provider → 400 "There must be at least one active SSO provider to enforce SSO".

### D. Members/Groups (guards)
- **TC-MEM-04 (expand)** Self/owner guards: deactivate self → "You cannot deactivate yourself"; delete self → "You cannot delete yourself"; demote last owner → "There must be at least one workspace owner"; admin acting on an owner blocked. Test as admin (not owner) targeting an owner.
- **TC-MEM-01 (expand)** groupIds cap 25 (separate from 50-email cap); inviting an existing member is silently filtered (no invite, no error) — verify UX.
- **TC-GRP-03 (expand)** Default group hard-protected: update → "You cannot update a default group"; delete → "…delete a default group".

### E. Spaces
- **TC-SPACE-08** Watch space toggle (separate from favorite): eye/eye-off, "Watch space"/"Stop watching space" in sidebar + all-spaces list; watchers get notifications.
- **TC-SPACE-09** Space export: whole space as Markdown or HTML + include-attachments; requires Edit; audit-logged.

### F. Pages
- **TC-PAGE-12** Watch page toggle: "Watch page"/"Stop watching" + toast; drives page.updated notifications (~7h cooldown). Distinct from favorites.
- **TC-PAGE-13** Page export matrix: Markdown/HTML × include-subpages × include-attachments; Copy-as-Markdown to clipboard; Print-to-PDF (window.print after 250ms).
- **TC-PAGE-10 (expand)** Menu footer: word count, created-by/at, last-editor tooltip, agent provenance attribution (lastUpdatedSource:'agent').

### G. Trash/History/Labels
- **TC-HIST-01 (expand)** Restore is CLIENT-SIDE OPTIMISTIC only — loads into editor without persisting until a save; confirm "Any changes not versioned will be lost." Verify an un-saved restore doesn't persist on reload.
- **TC-LABEL-01 (expand)** ≤25 labels per add batch; regex allows `~` only after first char; label AUTO-DELETES workspace-wide when removed from its last page — verify.

### H/I. Editor blocks (missing)
- **TC-BLK-14** Draw.io block: modal edit, autosave every 30s w/ LoadingOverlay, unsaved-changes confirm on close, saves as SVG attachment.
- **TC-BLK-15** Excalidraw block: lazy-loaded/Suspense, exports SVG, saves as attachment.
- **TC-BLK-13** Find & Replace (Mod+F): case-sensitive toggle, replace one/all, prev/next, search-only in read-only, Esc closes.
- **TC-ED-05** Table of Contents sidebar: auto from h1-h4, smooth-scroll, intersection-observer active highlight, shown in read-only shares.
- **TC-TMPL-01 (expand)** Template editor slash menu EXCLUDES Image/Video/Audio/Draw.io/Excalidraw/Synced block/Embed page — verify absent. No "create page from template" flow exists (don't test it).

### J. Media/Import
- **TC-MED-01/03 (expand)** Default upload 50MB; PDF strict `application/pdf`; image/video/audio use `.includes("type/")`; file attachment has NO MIME gate; image upload with wrong type FAILS SILENTLY (no error) — verify no-feedback path (bug candidate).
- **TC-MED-05** Import: upload `.md`/`.html`/zip; invalid extension → "Invalid import file type."; size limit (200MB).

### K. Comments
- **TC-CMT-02 (expand)** Reply nesting exactly 2 levels — reply-to-a-reply → 400 "You cannot reply to a reply"; only top-level resolvable; inline selection capped 250 chars.

### L. Search/Notifications
- **TC-SRCH-02 (expand)** FTS (Postgres) default vs Typesense (EE); space search enforces CASL Read; share search excludes restricted descendants; degrade gracefully w/o EE.
- **TC-NOTIF-01 (expand)** Tabs are Direct (comment.user_mention, comment.created, comment.resolved, page.user_mention, page.permission_granted) + Updates (page.updated). Add page.permission_granted case (share page with user/group).
- **TC-NOTIF-03** Email throttle/digest: ≤4 immediate emails/24h then batch into 12h digest; 7h per-page cooldown — verify with rapid edits.

### M. AI/Dictation
- **TC-AI-02/05 (expand)** Chat throttle 25 req/60s/user; agent loop max 20 steps; drivers openai/gemini/ollama; error→status map 401/403 auth, 402 quota, 429 rate-limit; needs interactive session (403 if none).
- **TC-AI-08** External MCP servers: admin configures transport/URL/auth headers, tool allowlist, enable toggle; down/slow (5s timeout) skipped w/o crashing turn; SSRF-blocked URLs → 400.
- **TC-DICT-02 (expand)** Dictation cap 25MB, whitelisted MIME (webm/ogg/mp4/mpeg/wav/m4a), max record 120s auto-stop; categorized mic errors.

### N. Sharing
- **TC-SHARE-04 (expand)** Anonymous-AI caps: 30 msgs / 8000 chars / 512 output tokens / 5 steps / 100 calls-hr-workspace + ~5/min-IP; funnel toggle-off→404, access→404, no-provider→503, quota→429, oversize→413; forged system/tool roles stripped.
- **TC-SHARE-07** Confirm NOT implemented: no share password, no share expiry; single uniform 404 for all access failures (no info leak).

### P. Half-wired / absent (verify-only, don't file behavior bugs)
- **TC-VERIFY-01** Page verification/approval: notification UI renders 5 verification types + websocket event + DB tables + EE flag, but NO client UI to request/approve/reject/view status. Confirm no entry point exists (flag missing-UI).
- **TC-VERIFY-02** If a verification notification can be triggered (EE), verify it renders + navigates without crash; graceful when target page deleted.
- **TC-APIKEY-01** API keys: table + feature flag exist but NO client UI/endpoint. Confirm no settings/account section reachable, no dead nav link.

---

## S. Permission matrix, cross-feature, races, a11y, mobile

### Q. Permission matrix sweep (run each across READER / WRITER / space-ADMIN / OWNER)
- **TC-PERM-01** Space READER read-only everywhere: no create/move/duplicate/trash (tree "..." + header hide edit items), no attachment upload, no import, no create-share; CAN export + download attachments.
- **TC-PERM-02** WRITER vs ADMIN delta: WRITER can trash but CANNOT permanently-delete/restore/view-trash → server "Only space admins can permanently delete pages"; WRITER sees no "Delete forever" and no trash entry.
- **TC-PERM-03** Page-level override vs space role: space READER + page-level writer can edit that page; space WRITER + page-level reader on restricted page cannot — editor read-only/edit per page override, inherited to nearest restricted ancestor.
- **TC-PERM-04** OWNER vs ADMIN: ADMIN cannot view audit logs (OWNER-only); ADMIN acting on an OWNER blocked. Confirm no audit entry point for ADMIN.
- **TC-CMT-04 (expand)** READER comment branch: can comment ONLY if allowViewerComments=true; off → blocked server-side. Test both flag states.

### Cross-feature interactions
- **TC-XREF-01** Trash a favorited+watched page: row stays (live FK) — favorites/watch list shows trashed page → click → not-found render; then permanent-delete → favorite/watcher rows cascade away, lists clean up.
- **TC-XREF-02** Move a publicly-shared page to another space (or to sharing-disabled space): verify public link survives/breaks/404 (share row keeps pageId, not re-validated on move) — consistency case.
- **TC-XREF-03** Delete a space with active public shares: `/share/...` links 404 cleanly, `/settings/sharing` list drops them, no dangling entries.
- **TC-EMBED-03/04 (expand)** Embed/transclude across spaces, then move source into a restricted space the viewer can't see → consuming side flips to NO-ACCESS placeholder (not not-found).

### Exact validation strings / bounds
- **TC-PAGE-14** Move boundary strings: "Cannot move a page into its own subtree"; "Page is already in this space"; "Invalid move position".
- **TC-CMT-07** Comment guard strings: edit other's comment → "You can only edit your own comments"; resolve a reply → "Only parent comments can be resolved".
- **TC-WS-11** AI roles/MCP bounds (settings/ai): role name 1-200, emoji ≤32 (UI input capped at 8 — mismatch), description ≤2000, instructions ≤20000; MCP name ≤200, URL ≤2048; chat rename title 1-255.
- **TC-AUTH-20** Setup bounds vs client: admin name 1-50 + NoUrls, workspace name server 1-64 but setup form caps 50 (mismatch); hostname 4-30 alphanumeric + "Hostname already exists." (verify reachability self-hosted).
- **TC-MED-06** Alt text ≤300 (over-limit); a11y: uploaded images have empty alt by default (screen-reader announces nothing) — note.

### Keyboard shortcuts / sub-flows
- **TC-ED-06** Find&Replace dialog bindings: Enter=next, Shift+Enter=prev, Alt+C case toggle, Alt+R replace-panel, Ctrl+Alt+Enter replace-all.
- **TC-PAGE-15** Tree ARIA nav: Arrow up/down move, Left/Right collapse/expand, Home/End, `*`/Shift+8 expand siblings, Space activate, typeahead jump; roving tabindex + aria-expanded/aria-current. NOTE: tree reorder is pointer-DnD only → no keyboard reorder (a11y gap to flag).
- **TC-PAGE-10 (expand)** Tree "..." node menu action set (Copy link/favorite/export/duplicate/move/copy-to-space/make-unset-template/trash) — edit-gated items hide for READER; terminology parity with header menu.

### Realtime / race specifics
- **TC-RT-01** Restriction-aware move broadcast: move page under an ancestor restricted to user A — A's tab gets moveTreeNode, B's tab (no access) gets compensating deleteTreeNode (vanishes); verify B never briefly sees-then-loses. Note 3s restriction-cache TTL window.
- **TC-NOTIF-04** Unread badge NOT optimistic (mark-read invalidates+refetches) → decrement lags; two-tab test.
- **TC-ED-02 (expand)** Collab presence: remote-cursor caret w/ name+color; in-place "last updated by/at" byline via stateless message (no refetch); 7.5s sync-timeout → forced Disconnected badge.

### Mobile / responsive / touch
- **TC-MOB-01** Mobile-divergent components: page-history full-screen modal <800px; breadcrumb single hamburger popover <48em; sidebar drawer overlay; AI chat window must not overflow ~360px phone.
- **TC-MOB-02** Touch limits: table column-resize + row/col DnD handles are pointer-based — verify touch fallback (graceful vs unusable); page-tree drag-reorder on touch.

---

## T. Home dashboard, new-note, page-details & backlinks

- **TC-DASH-01** Home `/home` three tabs (Recently updated / Favorites / Created by me): switch tabs, each loads its list + empty state + infinite scroll; active tab persists (jotai atom) across reload.
- **TC-DASH-02** "New note" home button branch logic: 0 writable spaces → hidden; exactly 1 → direct create+navigate; multiple → "Create in space" dropdown picker; loading/disabled during create; READER spaces excluded (ADMIN/WRITER only).
- **TC-PAGE-16** Page-details aside + Backlinks: right aside shows Created-by/Last-updated-by + Stats (word/char count, created, last-updated) + Backlinks; click Incoming/Outgoing → modal lists incoming & outgoing links w/ counts, infinite scroll, empty state, click-to-navigate.

---

## U. Import task lifecycle

- **TC-MED-07** Notion ZIP import + async task lifecycle: import modal → pick Notion source (distinct from generic ZIP), upload Notion export zip. Verify persistent "Importing pages / Please don't close this tab" toast → 3s-poll lifecycle: success → "Import complete" + tree refetch + ws refetchRootTreeNode; failed → "Page import failed: {reason}"; backend error → "Import failed". Generic-zip path uses same poller.
- **TC-MED-08** Multi-file md/html import partial-failure + per-file size: select MULTIPLE .md/.html at once; 30MB per-single-file limit ("File exceeds the 30mb import limit", distinct from 200MB zip); failing files SILENTLY swallowed (console.log only, no per-file error toast), summary counts only successes ("Successfully imported N pages"); zero success → "Failed to import pages". Mixed valid+invalid → count + no per-file error (sloppy-feedback candidate).
