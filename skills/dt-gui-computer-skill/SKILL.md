---
name: dt-gui-computer-skill
description: Operate native macOS or Windows desktop applications through the dt-gui-computer snapshot-scoped CLI. Use for computer desktop tasks, native app interaction, Accessibility/UI Automation inspection, clicking, text entry, keyboard actions, scrolling, app switching, human takeover, and Native Rep evidence. Do not use for browser pages or UI test execution.
---

# dt-gui-computer

Use the main Agent for intent understanding and planning. This skill only defines the atomic desktop-control protocol and its safety boundaries.

## Runtime context

UIWarden creates and owns the controlled session. The task prompt supplies one of two trusted runtime bindings:

- Same-process binding: use the injected environment variables below.
- Daemon-backed binding: use the exact absolute CLI prefix, `--runtime-home`, Provider, and session ID printed in the task prompt. This is required when the tool executor does not inherit per-turn environment variables.

For a daemon-backed binding, the task prompt overrides the variable-based examples in this document. Never replace the supplied absolute prefix with `$DT_GUI_COMPUTER_BIN`, and never omit `--runtime-home`.

Same-process environment variables:

- `DT_GUI_COMPUTER_BIN`: trusted CLI path.
- `DT_GUI_COMPUTER_SESSION_ID`: current controlled session.
- `DT_GUI_COMPUTER_PROVIDER_ID`: current platform Provider.
- `DT_GUI_COMPUTER_ARTIFACT_DIR`: Native Rep output directory.
- `DT_GUI_COMPUTER_DELIVERY_MODE`: `foreground-compatible` or `background-safe`.

Every command must begin with the trusted prefix supplied by UIWarden: either the literal token `"$DT_GUI_COMPUTER_BIN"`, or the exact daemon-backed `<absolute-cli> --runtime-home <absolute-home>` prefix from the task prompt. Do not infer a binary below this Skill's base directory, or use `env`, `export`, `which`, `ls`, or `echo` to inspect or replace the runtime context. If a command is rejected, return to the supplied trusted prefix instead of probing the environment or switching tools.

Never start or stop a Runtime session, approve/reject a challenge, or change control ownership from the Agent. UIWarden handles those operations. Starting a target application through `session launch` is allowed.

Before application discovery, decompose the instruction into application, target object, action, and content. Do not merge an application phrase or Chinese possessive into the target. For example, both "在聊天应用里给测试联系人发送消息" and "给测试联系人的聊天应用发送消息" mean application=`聊天应用`, target=`测试联系人`, action=`发送`, not target=`测试联系人的聊天应用`. For messaging, prefer an exact visible conversation, otherwise search the short target name; verify the opened conversation title or contact identity before entering message content.

## Required loop

1. Discover current and installed applications. Do not ask the user to choose one. When the instruction names an application, query that exact user-facing name so a large installed-app catalog cannot hide it through output truncation. `isRunning=false` means the application is installed and can be launched through the controlled session:

   ```bash
   "$DT_GUI_COMPUTER_BIN" apps list --provider "$DT_GUI_COMPUTER_PROVIDER_ID" --query "<application-name>" --limit 20 --json
   "$DT_GUI_COMPUTER_BIN" apps list --provider "$DT_GUI_COMPUTER_PROVIDER_ID" --json
   ```

   If the exact-name query returns `matchedAppCount=0` and `fallbackRequired=true`, immediately run
   the unfiltered command exactly once. Application display names can follow a different system
   language from the user's instruction; use the stable bundle ID and application semantics from
   that result. An empty localized-name query is not evidence that the application is unavailable.

2. Select the application that exactly matches the user's current instruction. Prefer a running app's `processId`; for an installed app use its stable bundle ID. A similar display name is not evidence that it is the requested app. Do not select UIWarden, the Provider helper, or an unrelated app unless the user explicitly requests it.

   ```bash
   "$DT_GUI_COMPUTER_BIN" session target --session "$DT_GUI_COMPUTER_SESSION_ID" --app-kind process-id --app "<pid>" --json
   ```

   If the requested application has `isRunning=false`, launch it through the controlled session. Prefer the bundle ID returned by `apps list`; use the user-facing name only when no stable ID is available:

   ```bash
   "$DT_GUI_COMPUTER_BIN" session launch --session "$DT_GUI_COMPUTER_SESSION_ID" --app-kind bundle-id --app "<bundle-id>" --json
   "$DT_GUI_COMPUTER_BIN" session launch --session "$DT_GUI_COMPUTER_SESSION_ID" --app-kind name --app "<application-name>" --json
   ```

3. Observe before every decision that depends on UI state. Start with the compact projection so
   complex applications do not send a multi-thousand-element AX tree to the model:

   ```bash
   "$DT_GUI_COMPUTER_BIN" observe --session "$DT_GUI_COMPUTER_SESSION_ID" --json
   ```

   If a complex application's full tree exceeds the tool output, query the Runtime directly instead of reading Claude tool-result files or using shell filters:

   ```bash
   "$DT_GUI_COMPUTER_BIN" observe --session "$DT_GUI_COMPUTER_SESSION_ID" --query "搜索" --limit 60 --json
   "$DT_GUI_COMPUTER_BIN" observe --session "$DT_GUI_COMPUTER_SESSION_ID" --query "发送" --limit 60 --json
   ```

   A filtered observation still returns a valid fresh `snapshotId`; only the CLI response
   elements/text are reduced. A query searches the compact AX projection by default and does not
   silently request the multi-thousand-element full tree. Use `--full --query "<target>"` only
   when `projection.truncated=true` and compact targeted queries cannot expose a required element.
   Never request an unfiltered full tree. Never use `grep`, pipes, redirection, `ls`, internal Claude
   tool-result paths, or invented file commands to inspect a large tree.

   Inspect `projection.truncated` on compact observations. When it is true and the next target is
   absent, use a task-relevant `--query` before considering `--full`; truncation alone is not a
   reason to send the complete tree to the model.

   Read the snapshot `delta` before choosing the next action. `focusedElementChanged`, `windowChanged`, `textChanged`, and element add/remove/update counts are compact evidence of progress. Repeating `observe` without a new action does not create progress and must not be used as a waiting loop.

   For an exact sequence such as digits, text fragments, or shortcuts, derive the complete ordered token list before the first mutating action. Every token, including repeated tokens, must have its own successful Runtime action. Keep a ledger of requested tokens and performed actions; never treat a prior token as part of a later operand or field.

   Preserve operand boundaries literally. For example, `1 + 100` means exactly `[1] [plus] [1] [0] [0] [equals]`; it does not mean `100 + 100`, `1 + 00`, or any mathematically equivalent replacement. If the ledger does not map one-to-one to the user's literal input, stop and correct the ledger before acting.

   If stale content would change the result and the UI exposes a safe semantic clear/reset action, clear it first and observe again. Do not clear unrelated user data.

4. Act only on the latest `snapshotId` and returned semantic `elementId`:

   ```bash
   "$DT_GUI_COMPUTER_BIN" click --session "$DT_GUI_COMPUTER_SESSION_ID" --snapshot "<snapshot-id>" --element "<element-id>" --observe --diff --json
   "$DT_GUI_COMPUTER_BIN" click --session "$DT_GUI_COMPUTER_SESSION_ID" --snapshot "<snapshot-id>" --element "<custom-input-anchor-id>" --allow-coordinate-fallback --observe --diff --json
   "$DT_GUI_COMPUTER_BIN" visual-click --session "$DT_GUI_COMPUTER_SESSION_ID" --snapshot "<snapshot-id>" --text "<visible-text>" --match exact --occurrence 1 --observe --diff --json
   "$DT_GUI_COMPUTER_BIN" set-value --session "$DT_GUI_COMPUTER_SESSION_ID" --snapshot "<snapshot-id>" --element "<element-id>" --value "<text>" --observe --diff --json
   "$DT_GUI_COMPUTER_BIN" type-text --session "$DT_GUI_COMPUTER_SESSION_ID" --snapshot "<snapshot-id>" --element "<element-id>" --value "<text>" --observe --diff --json
   "$DT_GUI_COMPUTER_BIN" type-text --session "$DT_GUI_COMPUTER_SESSION_ID" --snapshot "<snapshot-id>" --focused --value "<text>" --observe --diff --json
   "$DT_GUI_COMPUTER_BIN" key --session "$DT_GUI_COMPUTER_SESSION_ID" --snapshot "<snapshot-id>" --key "Tab" --observe --diff --json
   "$DT_GUI_COMPUTER_BIN" key --session "$DT_GUI_COMPUTER_SESSION_ID" --snapshot "<snapshot-id>" --key "Command+f" --observe --diff --json
   "$DT_GUI_COMPUTER_BIN" scroll --session "$DT_GUI_COMPUTER_SESSION_ID" --snapshot "<snapshot-id>" --direction down --pages 1 --observe --diff --json
   ```

   In `background-safe` mode, an editable `AXTextField`, `AXTextArea`, or `AXSearchField`
   must receive `set-value` or `type-text --element` directly. Do not click it first to acquire
   focus and do not replace direct input with `visual-click`; AX value input is specifically the
   non-interfering path for hidden or minimized windows.

5. Use `--observe --diff` on normal actions so one transport call returns both `action` and the
   fresh post-action `snapshot`. The diff contains added/updated elements and removed element IDs;
   unchanged element IDs from the initial observation remain valid with the new snapshot ID.
   Treat that snapshot exactly like a standalone observation before the next decision. When
   `diffTruncated=true`, do not act from the partial changes; issue one targeted query or full
   observation to obtain a complete fresh decision surface. Use a
   separate `observe` only before the first action, for a targeted query/full projection, after
   user takeover, or when an older Runtime does not return `snapshot`. A
   `visual-click` response may include `visualChanged` and a post-action screenshot, but pixel
   change alone is not proof of business success. Reconcile the new AX/screenshot state and the
   action ledger before reporting completion, then continue until the user goal is complete or
   the Runtime requires user involvement.

   A coordinate fallback or `visual-click` with `visualChanged=false`, followed by a snapshot whose
   `delta.changed=false`, is direct evidence that the action did not affect the visible target.
   Do not repeat that action or keep searching the same stale snapshot. Re-observe once and choose
   one different semantic or keyboard path; if it also has no effective delta, stop with the
   blocking evidence. Large add/update counts from elements outside `windowBounds` are not progress.

   When entering a file-system path supplied by the user or task, preserve it byte-for-byte. An absolute path beginning with `/`, a Windows drive, or a UNC prefix must never be prefixed with the application's current workspace or home directory. Verify the visible value after entry before confirming the dialog.

   If a modal or form is already open, finish that current surface before navigating elsewhere. When two consecutive observations have the same window, relevant text, and actionable elements, try at most one evidence-based alternative action. If it still does not change, stop with the blocking evidence instead of repeating navigation until the Agent turn limit.

   For contact or conversation search, first verify that the search field visibly contains the exact requested target after text entry. A matching name in common contacts, search history, message bodies, sender metadata, or unrelated page text is not a search result. Search success requires both the entered query and a result row/contact card created for that query; selection success requires the active conversation header or contact detail to identify the same target. If a custom search field remains empty after one semantic-center click, one observation, and one focused text entry, try at most one fresh keyboard-shortcut-based focus path. If the second attempt still leaves the field empty or the result surface unchanged, stop and report the input-focus gap. Never click an incidental occurrence of the target name in the current conversation body.

   A send-message task is complete only when the selected conversation identity matches the requested recipient and the final observation exposes the sent content in that conversation. Merely finding the recipient name or filling an input is not completion evidence.

When `observe` returns `screenshotPath`, prefer the Accessibility tree and structured `observe --query` output. Use the `Read` tool only when the tree does not expose information required for the next action, for `visual-click` preparation/verification, or for one final visual confirmation. Do not automatically read a screenshot after every observation.

Each task has a hard model-image budget of 12 `Read` calls. This budget is independent of Native Rep capture: all screenshots continue to be recorded for replay and diagnosis, but at most 12 may be sent to the model. Never read the same screenshot path twice, and do not read consecutive screenshots when the window, relevant text, and actionable elements are already explained by AX evidence. After the budget is exhausted, continue with AX-only evidence; if the remaining step genuinely requires visual evidence, stop and report the evidence gap instead of reading another image.

Read only the latest screenshot returned by the current Native Rep. Do not read other files or infer a visual value without opening that screenshot when visual evidence is genuinely required.

For tasks spanning multiple apps, repeat discovery and `session target`, then observe the new app. Never reuse an element or snapshot from the previous app.

## Safety

- Never use `ui-test-assistant-skill`, browser-use, Playwright, Chromium, AppleScript, `open`, `Start-Process`, arbitrary shell automation, or another UI driver for a computer-desktop task. Use `session launch` to open an application.
- Treat `PROVIDER_UNAVAILABLE`, `Provider 未返回响应`, and Provider timeout as a shared transport failure, not as an element-strategy failure. Re-observe and retry the original action at most once. If the same Provider failure returns again, stop and report `[UIWARDEN_NATIVE_RESULT: blocked]`; do not switch to key, visual-click, coordinate click, or another mutation path.
- Never guess an `elementId`. A stale or missing element requires a new observation.
- Use only the CLI commands documented in this skill. There is no generic `get` command.
- When the final observation and available screenshot cannot expose a requested value, stop and report the evidence gap. Do not probe with extra keys, clicks, focus changes, or invented commands solely to scrape an inaccessible value.
- A named, currently visible element that advertises `UIWardenCenterClick` may use `--element <id> --allow-coordinate-fallback`; the Runtime derives its center from the current snapshot and rejects centers outside the observed target window. If AX has no usable target but the latest screenshot contains a visible label, use `visual-click` before raw coordinates. It OCR-locates the requested occurrence, maps window coordinates to the screen, and records a post-action screenshot.
- Raw `--x/--y --allow-coordinate-fallback` does not require approval, but it is the last fallback: it must use the latest snapshot, remain inside the observed target window, and stay visible in the Native Rep audit. Never guess coordinates from an older screenshot.
- Secure fields require human handoff. Do not try another input mechanism to bypass it.
- When a custom-drawn input exposes only a named static element with `UIWardenCenterClick`, click that element with `--allow-coordinate-fallback`, observe exactly once, then immediately use `type-text --focused`. The Runtime invalidates this focus token after any intervening action or extra observation. This semantic-center fallback does not require human handoff; never replace it with guessed coordinates.
- For a native browser whose address bar is not exposed in AX, `key --key Command+l`, observe exactly once, then `type-text --focused` uses the same one-shot focus contract. Do not use this shortcut as a general bypass for unobservable application inputs.
- On `STALE_SNAPSHOT`, observe and re-plan.
- On `NO_PROGRESS`, the Runtime has ended the session after repeated unchanged observations. Stop immediately and report the last verified state; do not retry with another snapshot or tool.
- On `APPROVAL_REQUIRED`, report the challenge ID and stop issuing actions.
- On `HANDOFF_REQUIRED` or `HUMAN_CONTROL_ACTIVE`, stop immediately and explain the required user action.
- In `background-safe` mode, never activate the target application or fall back to global keyboard, mouse, scroll, clipboard, AppleScript, or shell-based UI automation. Every successful action must report `backgroundSafetyVerified=true` and `targetApplicationActivated=false`. `frontmostApplicationUnchanged` and `cursorUnchanged` are observations of concurrent user activity during the action; a false value alone does not mean the Provider interfered with the user.
- On `BACKGROUND_ACTION_REQUIRES_VISIBLE_WINDOW`, keep the window minimized and re-observe once. Try at most one AX-only semantic alternative such as `AXPress`, `set-value`, or `type-text --element`; never retry the visual/coordinate/key/scroll action and never restore the window. If no semantic path exists, report blocked.
- On `BACKGROUND_INTERFERENCE_DETECTED` or `BACKGROUND_ACTION_UNSUPPORTED`, stop immediately and report the exact blocking evidence. Never switch to `foreground-compatible` within the task; only the user may change that mode before a later run.
- If no listed app plausibly matches the instruction, report the visible candidates and the ambiguity. Do not operate a random app.

## Result

Report completed actions, current desktop state, anything left for the user, and any Runtime error or capture gap. Separate directly observed evidence from expected or inferred results. Never claim that a value is visibly displayed unless a snapshot or screenshot exposes that value; when it cannot be read, mark it as unverified instead of substituting domain knowledge. Do not emit test PASS/FAIL, coverage, or browser-test conclusions.

End the report with exactly one machine-readable status line:

- `[UIWARDEN_NATIVE_RESULT: completed]` only when every requested action has final observed evidence.
- `[UIWARDEN_NATIVE_RESULT: blocked]` when any requested action remains unperformed, unverified, or requires user involvement.
