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
- **TC-SPACE-03** Edit space: change name/slug/desc; only dirty fields sent; save disabled when clean. NOTE (corrected): server `slugExists` does NOT exclude self (`space.repo.ts:60-74`) — saving with the slug field present but unchanged can wrongly 400 "Space slug exists". The client only avoids it by sending dirty fields. Treat self-exclusion as a BUG to verify, not expected behavior. See TC-SPACE-11.
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

- **TC-TRASH-01** Soft-delete page via "Move to trash". NOTE (corrected): there is NO confirm dialog anymore — delete fires immediately and shows an 8-second **Undo toast** "Page moved to trash" (`page-query.ts:132-144`; menus call `handleDelete(id)` directly). The 30-day retention is real but lives only in `TrashCleanupService` and is NEVER surfaced at delete time. Children remain; current page deleted → redirect. Undo-specific scenarios in TC-TRASH-14..17.
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

---

## V. Forgotten cases — second code-grounded pass (added 2026-06-23)

Additional cases from a code-grounded gap audit of this plan (8 read-only audits across product zones; full rationale in `docs/qa-plan-gaps-pr136.md`). Same convention: steps → expected, `file:line` cited for grounding. **[BUG?]** = the case also surfaces a candidate defect.

### V.0 Corrections to existing cases (text now stale vs code)

- **TC-DICT-02 (expand)** — transcription throttle is **20 req/60s** (`ai-chat.controller.ts:213`), a SEPARATE bucket from the 25/60s AI-chat throttle. Streaming sends one request per VAD pause, so this bucket is the real limit.
- **TC-MED-08 / TC-MED-05** — single md/html import limit is **30MB** (`import.controller.ts:56`) but the 413 message wrongly says **"Exceeds the 10mb import limit"** (`:67`). [BUG?] wording.
- **TC-NOTIF-03** — the ≤4-immediate-emails/24h budget is **global per user**, NOT per page (`page-update-email-rate-limiter.ts:18-23`). The 7h cooldown IS per-(user,page).
- **TC-SRCH-02** — on the default Postgres FTS build there is **no "Attachments" content-type filter** (hidden; `contentType` never sent to server; attachment search is Typesense/EE only) — `search-spotlight-filters.tsx:50`, `use-unified-search.ts:23`. Don't file a bug; it's EE-only.

### V.1 AI chat & MCP (mostly new code, no manual coverage)

- **TC-AI-09** Queue a message while a turn streams: text becomes a pending row (clock icon), composer clears; on clean finish the FIRST queued msg auto-sends (FIFO), then the next (`chat-thread.tsx:189-259`, `chat-input.tsx:39-104`).
- **TC-AI-10** [BUG?] Queue preserved on Stop AND on stream error (must NOT auto-flush); removing a queued item via its X works (`chat-thread.tsx:249-259, 364-372`).
- **TC-AI-11** Queue lifecycle: cleared when switching to another chat (remount by key); survives new-chat→server-id adoption without remount (`ai-chat-window.tsx:299-316`).
- **TC-AI-12** "Stopped" notice: manual Stop → gray "Response stopped."; dropped connection → gray "Connection lost — the answer was interrupted."; clears on next turn (`chat-thread.tsx:249-290`, `chat-stopped-notice.tsx`).
- **TC-AI-13** Reopen a chat with an interrupted turn from history → partial answer present + combined-wording gray notice (`message-item.tsx:129-144`, `ai-chat.service.ts:456-471`).
- **TC-AI-14** [BUG?] Provider drops mid-answer → partial answer + tool-call cards + classified error banner persist and survive reload (`ai-chat.service.ts:435-455`).
- **TC-AI-15** [BUG?] "Copy chat" while streaming includes the in-progress turn ("still being generated…"); switching chat mid-stream must not leak the previous chat's tail (`ai-chat-window.tsx:268-295`, `chat-thread.tsx:297-303`).
- **TC-AI-16** [BUG?] Chat-history row shows relative creation time + origin page title; restrict the origin page from the user → title must NOT leak ("No document") (`conversation-list.tsx:29-44`, `ai-chat.service.ts:201-243`).
- **TC-AI-17** Tool-call card states (running spinner → green done → red error+errorText) and clickable `/p/{uuid}` citations; generic "Ran tool {{name}}" fallback (`tool-call-card.tsx:41-81`, `tool-parts.tsx:55-136`).
- **TC-AI-18** Provider ECONNRESET: turn recovers without a user-visible error before first byte; after partial bytes → classified "Lost connection" banner + partial retained (`ai-http.ts:55-84`, `error-message.ts:104-114`).
- **TC-AI-19** "Ask AI" toolbar button: present in edit mode with AI enabled, absent when AI/generative off, expected behavior in read-only (`ask-ai-group.tsx:8-23`).
- **TC-MCP-01** [BUG?] MCP auth headers are write-only: list never returns `headersEnc` (only `hasHeaders`); update with header omitted = unchanged, `{}` = clear, non-empty = replace (`mcp-servers.service.ts:80-101, 160-171`).
- **TC-MCP-02** MCP transport http vs sse both connect; editing the URL re-runs SSRF check (blocked → 400), editing other fields without URL change does not (`mcp-clients.service.ts:306-323`, `mcp-servers.service.ts:76-78`).

### V.2 Dictation / STT (fork feature, heavily changed)

- **TC-DICT-03** [BUG?] Dictate with frequent pauses so >20 VAD segments cut in 60s → graceful degradation after the 21st 429s (no toast flood); earlier text preserved (`ai-chat.controller.ts:213`, `use-streaming-dictation.ts:185-227`).
- **TC-DICT-04** Streaming is hardcoded ON in both surfaces (editor toolbar + chat composer); no batch-mode toggle exists; VAD assets (~13–26MB) download for every dictation user (`dictation-group.tsx:73`, `chat-input.tsx:74`).
- **TC-DICT-05** Block one of `/vad/*.onnx|*.wasm|*.worklet` (or it serves as text/html) then click mic → status returns to idle, mic re-clickable, single red toast, no silent hang (`use-streaming-dictation.ts:348-367`, `copy-vad-assets.mjs`).
- **TC-DICT-06** Fresh load, uncached model, ONE mic click → "Preparing…" then recording starts on the first click (AudioContext-in-gesture fix) (`use-streaming-dictation.ts:256-274`).
- **TC-DICT-07** [BUG?] Click Stop while still talking (no pause) → the un-ended segment is silently dropped (data loss); compare to Stop after a pause (`use-streaming-dictation.ts:421-425`).
- **TC-DICT-08** Stop then immediately restart with old responses in flight → stale-session transcripts must NOT leak into the new session; in-session order preserved despite out-of-order HTTP (`use-streaming-dictation.ts:148-227`).
- **TC-DICT-09** Multi-segment insertion: move the caret / delete content above mid-session → subsequent inserts stay contiguous and clamp into doc bounds, no crash on editor destroy (`dictation-group.tsx:13-68`).
- **TC-DICT-11** Three gate states: dictation toggle off (mic hidden, 403 if forced) / STT model blank (503 "Voice dictation is not configured") / endpoint 401/404 (verbatim server message) (`ai-chat.controller.ts:220-269`).

### V.3 Editor & collaboration

- **TC-ED-07** [BUG class] Type a long title fast in two tabs while a PAGE_UPDATED echo arrives → no dropped chars (focused-field guard); blur then apply an external title change (`title-editor.tsx:143-183`).
- **TC-RT-02** Collab JWT expires/revoked with editor open → reads latest token via ref, refetches, reconnects; cover the `exp === undefined` / unparseable-token / no-token branches (no reconnect thrash) (`page-editor.tsx:176-204`).
- **TC-RT-03** Live security window: trash / demote-to-reader / deactivate a user who has the page open → next reconnect is read-only or rejected; verify the mid-session window before reconnect (`authentication.extension.ts:78-102`).
- **TC-MED-09** Paste a block with an image/pdf/excalidraw/drawio copied from page A into page B → only foreign-owned attachments re-upload to B; 404 fetch keeps original; node moved mid-fetch re-validates; dedup of repeats (`editor-paste-handler.tsx:75-217`).
- **TC-LINK-02** Paste internal page URL matrix: empty selection → mention (with `#anchor`); non-empty selection → plain link; cross-host → link; unresolved/deleted page → link mark fallback, no crash (`editor-paste-handler.tsx:33-58`, `internal-link-paste.ts:20-76`).
- **TC-MENT-02** Mention whitespace ladder: query starting with space never opens; >4 whitespace with only the create-page fallback present destroys; >7 destroys unconditionally; detect aside / comment-dialog / chat-input contexts (`mention-suggestion.ts:11-152`).
- **TC-BLK-19** Indent/outdent on paragraphs & headings: Tab increments and clamps at 8, Shift-Tab to 0; inside list/table/code-block Tab keeps native behavior; malformed `data-indent` clamps (`editor-ext/lib/indent.ts:36-83`).
- **TC-BLK-20** Slash menu does NOT open inside a code block; a no-match space-bearing query (`/todo abc`) auto-deactivates so stray text isn't left in the doc (`extensions/slash-command.ts:24-46`).

### V.4 Pages, tree, watchers, backlinks

- **TC-PAGE-17** [BUG?] Reorder a node between adjacent siblings in a deep tree → `generateJitteredKeyBetween` can yield <5 or >12 chars, which `MovePageDto` (`@MinLength(5)@MaxLength(12)`) rejects with a generic 400 and the tree reverts (`move-page.dto.ts:14-16`).
- **TC-PAGE-18** [BUG?] Watcher `page.updated` fires ONLY on collab body saves with a prior history version — NOT on REST rename/icon and NOT on the first edit (`history.processor.ts:105-118`).
- **TC-PAGE-19** Force the breadcrumb lazy-ancestry fetch to fail (offline/500) → graceful fallback; today there is no try/catch so ancestor expansion aborts with an uncaught error (`space-tree.tsx:129-139`).
- **TC-PAGE-20** `/pages/created-by-user` accepts a `userId` the dashboard never sends → verify access is scoped to the requester's spaces and a non-UUID returns a clean 400 (`page.controller.ts:453-473`).
- **TC-PAGE-21** Move-to-space with an accessible grandchild under an INACCESSIBLE child → confirm where the grandchild lands (orphan to source root vs dangling) (`page.service.ts:437-573, 1251`).
- **TC-PAGE-22** [BUG?] Duplicate a deep tree where one attachment copy fails → silent broken image (log only); duplicating 3× yields three "Copy of X" siblings (`page.service.ts:837-885`).
- **TC-BLK-11 (expand)** [BUG?] Subpages block on a parent with more children than the sidebar page-size shows only the first page (no `fetchNextPage`); verify live-refresh on child add/rename/move/trash (`subpages-view.tsx:28-48`).
- **TC-WATCH-01** Mute a page (Stop watching) while watching its space → no `page.updated` for that page but still for other pages in the space; re-watch clears mute; favoriting has no notification effect (`watcher.repo.ts:66-102`).
- **TC-PAGE-24** Backlinks edges: self-link (count/double-count), deleted target (count drops), incoming link from a space the viewer can't read (excluded) (`backlink.repo.ts:83-111`, `backlink.service.ts:40-55`).
- **TC-DASH-02 (expand)** "New note" picker excludes READER-only spaces and caps at 100 spaces; a failed create still shows the error and re-enables (`new-note-button.tsx:17-44`).

### V.5 Trash (undo toast), history, favorites, labels

- **TC-TRASH-14** Trash a child from the tree menu → its node unmounts → ~3s later click Undo → page restored at the correct parent with children intact (restore reads tree via store, not a render closure) (`page-query.ts:120-279`).
- **TC-TRASH-15** Undo after the 8s window expires → toast gone, no other undo affordance; recovery only via Trash → Restore; current-page trash redirects to space root (`page-query.ts:134`).
- **TC-TRASH-16** Trash 3–4 sibling pages rapidly → stacked per-page toasts, each Undo restores the CORRECT page (closure capture), no id collision (`page-query.ts:132-142`).
- **TC-TRASH-17** Two-tab consistency: trash in A (B drops node) → Undo in A → no duplicate node in either tab (addTreeNode vs refetchRoot reconciliation) (`page.repo.ts:358-447`, `page-query.ts:241-258`).
- **TC-TRASH-18** Restore a child whose parent is still trashed → child detaches to root, subtree stays attached; restore the parent later → child does NOT re-parent (`page.repo.ts:380-448`).
- **TC-TRASH-19** WRITER opens Trash and clicks "Delete" (item NOT hidden, unlike the banner) → server 403 "Only space admins can permanently delete pages" renders cleanly (`trash.tsx:173`, `page.controller.ts:335`).
- **TC-HIST-02** AI-agent version badge: violet sparkles + tooltip, human author still shown; click/Enter opens that chat, CLEARS the chat draft, closes history, does not select the row; agent version without `aiChatId` is non-clickable (`history-item.tsx:37-108`).
- **TC-HIST-03** Diff highlight on a version with text edits + added image/table + deleted callout: toggle on/off, counts match, deleted special-node renders as a ghost widget; oldest version → no diff; malformed → plain fallback (`history-editor.tsx:23-203`).
- **TC-HIST-04** Restore is Manage-gated (WRITER sees no Restore button) and client-optimistic — un-saved restore must not persist on reload (`use-history-restore.tsx:38-69`, `history-list.tsx:151`).
- **TC-FAV-02** Rapid favorite/unfavorite from the page/tree MENU (no pending guard, unlike the list StarButton) → final state correct, no duplicate row, no toast mismatch (`space-tree-node-menu.tsx:181-189`).
- **TC-FAV-03** Trashed favorite still renders (click → deleted banner); permanently-deleted favorite row is null-skipped → verify pagination pages don't visibly shrink and empty state only when truly empty (`favorites-pages.tsx:52-126`).
- **TC-LABEL-03** Label name regex `/^[a-z0-9_-][a-z0-9_~-]*$/`: `~tag` (tilde first) rejected; `a~b` ok; uppercase/space/unicode handled (client lowercases first) (`label.dto.ts:31`).
- **TC-LABEL-05** `/labels/:name` for a label mostly on inaccessible pages → results filtered AFTER pagination → under-filled pages but "load more" terminates; nonexistent label returns uniform `usageCount:0` (no leak) (`label.service.ts:87-138`).
- **TC-LABEL-06** Apply a label to pages X+Y, remove from each → label auto-deletes workspace-wide only on removal from its LAST page; re-adding creates a fresh row (`label.service.ts:40-67`).

### V.6 Auth, members, groups, spaces, workspace

- **TC-MEM-07** [BUG?] Plain MEMBER calls `POST /workspace/invites` and `/members` directly → returns pending invite emails+roles and the full roster (UI-only gating; CASL grants member `Read Member`) (`workspace.controller.ts:122-210`, `workspace-ability.factory.ts:69`).
- **TC-SPACE-10** [BUG?] Delete the workspace default space → no guard; verify it doesn't leave a dangling `defaultSpaceId` breaking home/new-note/onboarding (`space.service.ts:270-292`).
- **TC-SPACE-11** [BUG?] Save a space sending an unchanged slug (or two admins racing) → server `slugExists` counts the space's own row → wrong "Space slug exists" 400 (`space.repo.ts:60-74`).
- **TC-AUTH-21** [BUG?] >70-char password on change-password and invite-accept (no MaxLength, unlike register/reset 8-70) → accepted and bcrypt silently truncates at 72 bytes (`change-password.dto.ts:10`, `invitation.dto.ts:51`).
- **TC-AUTH-22** Session table: >25 logins trim oldest-by-last-active (their cookies 401 next request); >7-day sessions purged; valid JWT + revoked DB session ⇒ 401; revoke-all keeps current, revoke-current → 400 (`session.service.ts:14-37`, `jwt.strategy.ts:64-72`, `session.controller.ts:41-79`).
- **TC-GRP-04** Delete a group (or remove a user) that is a space's only access path → user loses space access AND their favorites/watchers for that space are purged; users with another access path keep theirs; live sessions NOT killed (`group.service.ts:173-214`, `group-user.service.ts:106-172`).
- **TC-WS-12** aiSearch toggle OFF (schedules 24h embedding-purge job) then back ON within the window → the pending purge job is removed so it can't wipe rebuilt embeddings; one dedup reindex runs (`workspace.service.ts:578-609`).
- **TC-USER-08** Notification preferences: per-type email opt-outs (page.updated, page/comment user-mention, comment.created/resolved) toggle + persist + suppress email (`update-user-settings` path).
- **GAP** Space/group `description` has no server MaxLength (≤500 is client-only) → 10k-char description via API is stored (`create-space.dto.ts:17`, `create-group.dto.ts`).

### V.7 Import / export / attachments / storage

- **TC-ATT-DL-01** Non-member (or restricted-page reader) fetches `/api/files/<id>/<name>` directly → 403/404; download uses `validateCanView`, upload uses `validateCanEdit`; READER who can view CAN download (`attachment.controller.ts:166-211`).
- **TC-ATT-PUB-01** [BUG?] Public attachment JWT survives un-share / page move (check is only `jwt.pageId === attachment.pageId`, no live share check) → token-outlives-revocation leak; also expiry and cross-attachment reuse → 404 (`attachment.controller.ts:213-259`).
- **TC-ATT-CHAT-01** AI-chat attachment is creator-only: another user (even admin) gets 404; `files/info` rejects chat attachments (`attachment.controller.ts:185-191, 391-415`).
- **TC-STOR-RANGE-01** Seek a large inline video/audio (Range header) → 206 with correct Content-Range; past-EOF → 416; malformed Range → full stream; test on both local and S3 (`attachment.controller.ts:490-533`).
- **TC-IMP-ZIPBOMB-01** [BUG?] Upload a <200MB zip that decompresses to many GB / hundreds of thousands of files → no decompression-ratio or entry-count cap → disk-fill/OOM stalls the import queue (`file.utils.ts:146-228`).
- **TC-IMP-XSS-01** [BUG?] Import md/html with `<script>`/`onerror` and unsupported Notion blocks → verify HTML is sanitized (no stored-XSS) and whether unsupported content is silently dropped while reporting "success" (`import.service.ts:125-142`).
- **TC-IMP-NEST-ZIP-01** Nested zip unwrapped only one level AND only when the outer zip has exactly one entry; doubly-nested or zip+stray-file → inner ignored → "no pages imported", not a crash (`file.utils.ts:95-144`).
- **TC-IMP-NOTION-01** Notion export with duplicate-title folders (partial-UUID disambiguation) + nested DBs → all pages land with correct parent/child, none dropped/mis-parented (`file-import-task.service.ts:222-305`).
- **TC-IMP-POLLER-01** [BUG?] Import poller `setInterval` has no cleanup (leak/double-poller on second import); a single transient `getFileTaskById` failure aborts polling with a false "Import failed" though the backend task is alive (`page-import-modal.tsx:152-231`).
- **TC-EXP-ATTACH-FAIL-01** [BUG?] Export include-attachments with one unreadable attachment → file silently omitted, export reports "successful" (incomplete backup, no manifest) (`export.service.ts:358-380`).
- **TC-EXP-PERM-01** Export a subtree where a middle page is inaccessible → its accessible descendants are pruned (chain broken); root inaccessible → "Root page is not accessible" (`export.service.ts:563-609`).
- **TC-ATT-ORPHAN-01** Trash a page with attachments → blobs remain (restore works); permanent-delete/auto-purge → attachment-delete jobs run; partial storage-delete failure leaves orphaned blobs (log only) (`attachment.service.ts:382-426`).

### V.8 Search, notifications, comments, realtime

- **TC-NOTIF-05** [BUG?] After restricting a page from a user, the unread BADGE still counts its notification (count query lacks `filterAccessiblePageIds`) but the LIST hides it → permanent non-zero badge that can't be cleared + activity-existence leak (`notification.repo.ts:80` vs `notification.service.ts:61`).
- **TC-NOTIF-06** [BUG?] "Direct" tab uses `type != page.updated` (blacklist) instead of the `DIRECT_NOTIFICATION_TYPES` whitelist → verification/approval types leak into Direct (`notification.repo.ts:58`, `notification.constants.ts:37-53`).
- **TC-NOTIF-07** [BUG?] "Unread" filter when page 1 is all-read → empty state shown and the scroll sentinel isn't rendered → next page never loads, so an unread item on page 2 stays invisible despite the badge (`notification-list.tsx:62-83`).
- **TC-NOTIF-08** Per-type dedup matrix (no DB unique constraint, in-code only): mention+participant → one notification; two edits in 7h → one page.updated; re-edit re-adding same mention suppressed; self-mention/resolve/comment suppressed (`comment.notification.ts:77-189`, `page.notification.ts:198-262`).
- **TC-RT-04** [BUG?] `useQuerySubscription` registers `socket.on("message")` with NO cleanup → duplicate handlers and non-idempotent double-apply of `moveTreeNode`/`updateOne` + listener leak on re-mount/reconnect (`use-query-subscription.ts:21-167`).
- **TC-RT-05** Tab A offline while Tab B creates/moves/deletes pages and comments → A reconnects → no resync (events lost, no refetch on reconnect) so A stays stale until reload (`ws.gateway.ts:38-62`).
- **TC-RT-06** [BUG?] Within the 3s restriction-cache window after adding a space's FIRST page restriction, create/rename/icon/delete a restricted page → payload (title/icon) fans out to the whole space room; `invalidateSpaceRestrictionCache` has zero callers (`ws.service.ts:89-110`, `ws.utils.ts:13`).
- **TC-RT-07** [BUG?] Same window: create/edit/resolve/delete a comment on a restricted page → comment body + selection text broadcast to the whole space room (`ws.service.ts:58-64`, `comment.service.ts:153-283`).
- **TC-CMT-08** [BUG?] Open the Add-comment dialog on a selection, move the cursor before Submit → stored selection text is captured at submit, not at open → empty/wrong anchor; "jump to selection" then shows wrong text (`comment-dialog.tsx:53-69`).
- **TC-CMT-10** Tab A resolves a comment; Tab B has the page open → list updates via WS but the inline decoration updates via Yjs → if one channel is mid-reconnect the panel and inline mark disagree (`use-query-subscription.ts:57-75`, `comment.service.ts:246-260`).
- **TC-SRCH-05** [BUG?] Search operator-only / stopword-only inputs (`&`, `!`, `*`, `<->`, `\`, "the a of") → `to_tsquery` syntax error → unhandled 500; the `length<1` guard doesn't catch whitespace/operators (`search.service.ts:37, 50-60`).
- **TC-SRCH-07** Query whose top-N ranked hits include restricted pages → access-filtering AFTER limit/offset returns <N visible results and the removed ranks are unreachable (`search.service.ts:67-139`).
- **TC-SRCH-04** `/search/suggest` has no controller-level CASL check (unlike `pageSearch`) — pass a non-member `spaceId` and confirm the service filter alone blocks any page leak (`search.controller.ts:76-84`).
