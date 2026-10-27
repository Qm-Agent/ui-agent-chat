---
name: dt-gui-browser-skill
description: Operate the UIWarden-controlled browser through the dt-gui-browser snapshot-scoped CLI. Use for general browser UI operations, semantic page observation, navigation, clicking, text entry, selection, scrolling, screenshots, human takeover, and Browser Rep evidence. Do not use for UI test execution, regression, inspection, quick mode, browser-use, or native desktop applications.
---

# dt-gui-browser

The main Agent owns intent understanding and planning. This skill defines only the atomic browser-control protocol and safety boundaries.

## Runtime context

UIWarden creates and owns the browser session for both the client embedded browser and an external loopback CDP browser selected in the UI Operations control panel. Read:

- Daemon-backed binding: use the exact session-scoped launcher printed in the task prompt. UIWarden has already bound the packaged Node, Runtime home, and browser session inside this launcher.

- `DT_GUI_BROWSER_BIN`: trusted CLI path.
- `DT_GUI_BROWSER_SESSION_ID`: current controlled browser session.
- `DT_GUI_BROWSER_ARTIFACT_DIR`: Browser Rep output directory.

For a daemon-backed binding, the task prompt overrides the variable-based examples below. Never replace the supplied launcher with `$DT_GUI_BROWSER_BIN`, append `--node`, `--runtime-home`, or `--session`, or probe the filesystem for another CLI.

Never start, stop, retarget, attach another CDP endpoint, or change control ownership from the Agent. UIWarden synchronizes the client browser target or creates a snapshot-scoped session for the external CDP target selected by the user.

## Required loop

1. Read the authorized target set:

   ```bash
   "$DT_GUI_BROWSER_BIN" tabs list --session "$DT_GUI_BROWSER_SESSION_ID" --json
   ```

   If `targetPolicy` allows Agent selection, compare every listed tab's title and URL with the user request. Reuse the best matching existing page with:

   ```bash
   "$DT_GUI_BROWSER_BIN" tabs activate --session "$DT_GUI_BROWSER_SESSION_ID" --target "<target-id>" --json
   ```

   If no existing page matches, continue from the current tab and navigate it. Never activate a target not returned by `tabs list`.

2. The first observation is a full baseline:

   ```bash
   "$DT_GUI_BROWSER_BIN" observe --session "$DT_GUI_BROWSER_SESSION_ID" --json
   ```

   After each action, request a semantic delta:

   ```bash
   "$DT_GUI_BROWSER_BIN" observe --session "$DT_GUI_BROWSER_SESSION_ID" --diff --json
   ```

   A diff response keeps the newest `snapshotId` but only returns added or updated elements,
   removed element IDs, and changed text lines. Merge it with the first full baseline. Stable
   `elementId` values may be reused with the newest `snapshotId`; never reuse the old
   `snapshotId`. If `diffTruncated=true`, request one full observation before acting.

3. Plan one atomic action from the latest semantic snapshot. Use only its `snapshotId`, `elementId`, and listed `actions`:

   ```bash
   "$DT_GUI_BROWSER_BIN" click --session "$DT_GUI_BROWSER_SESSION_ID" --snapshot "<snapshot-id>" --element "<element-id>" --json
   "$DT_GUI_BROWSER_BIN" set-value --session "$DT_GUI_BROWSER_SESSION_ID" --snapshot "<snapshot-id>" --element "<element-id>" --value "<text>" --json
   "$DT_GUI_BROWSER_BIN" type-text --session "$DT_GUI_BROWSER_SESSION_ID" --snapshot "<snapshot-id>" --element "<element-id>" --value "<text>" --json
   "$DT_GUI_BROWSER_BIN" select-option --session "$DT_GUI_BROWSER_SESSION_ID" --snapshot "<snapshot-id>" --element "<element-id>" --value "<value-or-label>" --json
   "$DT_GUI_BROWSER_BIN" hover --session "$DT_GUI_BROWSER_SESSION_ID" --snapshot "<snapshot-id>" --element "<element-id>" --json
   "$DT_GUI_BROWSER_BIN" drag --session "$DT_GUI_BROWSER_SESSION_ID" --snapshot "<snapshot-id>" --source "<source-element-id>" --target "<target-element-id>" --json
   "$DT_GUI_BROWSER_BIN" upload-file --session "$DT_GUI_BROWSER_SESSION_ID" --snapshot "<snapshot-id>" --element "<file-input-element-id>" --file "/absolute/workspace/file" --json
   ```

   Navigation and page-level actions are also atomic:

   ```bash
   "$DT_GUI_BROWSER_BIN" downloads list --session "$DT_GUI_BROWSER_SESSION_ID" --json
   "$DT_GUI_BROWSER_BIN" navigate --session "$DT_GUI_BROWSER_SESSION_ID" --url "https://example.com" --json
   "$DT_GUI_BROWSER_BIN" back --session "$DT_GUI_BROWSER_SESSION_ID" --json
   "$DT_GUI_BROWSER_BIN" forward --session "$DT_GUI_BROWSER_SESSION_ID" --json
   "$DT_GUI_BROWSER_BIN" reload --session "$DT_GUI_BROWSER_SESSION_ID" --json
   "$DT_GUI_BROWSER_BIN" key --session "$DT_GUI_BROWSER_SESSION_ID" --key "Enter" --json
   "$DT_GUI_BROWSER_BIN" key --session "$DT_GUI_BROWSER_SESSION_ID" --key "Meta+A" --json
   "$DT_GUI_BROWSER_BIN" scroll --session "$DT_GUI_BROWSER_SESSION_ID" --direction down --pages 1 --json
   "$DT_GUI_BROWSER_BIN" screenshot --session "$DT_GUI_BROWSER_SESSION_ID" --json
   ```

   After an action starts a download, use `downloads list` to verify the runtime-observed state,
   `suggestedFilename`, and `filePresent`. A successful click alone is not download completion
   evidence. Only report a downloaded filename when the matching record is `completed` and
   `filePresent=true`.

   A JavaScript alert, confirm, or prompt blocks normal observation. A first click without a response safely dismisses the dialog and returns `DIALOG_RESPONSE_REQUIRED` with its type, message, and default prompt. Read that evidence, then observe and retry the click once with an explicit response:

   ```bash
   "$DT_GUI_BROWSER_BIN" click --session "$DT_GUI_BROWSER_SESSION_ID" --snapshot "<snapshot-id>" --element "<element-id>" --dialog-action accept --json
   "$DT_GUI_BROWSER_BIN" click --session "$DT_GUI_BROWSER_SESSION_ID" --snapshot "<snapshot-id>" --element "<element-id>" --dialog-action accept --prompt-text "<prompt-value>" --json
   "$DT_GUI_BROWSER_BIN" click --session "$DT_GUI_BROWSER_SESSION_ID" --snapshot "<snapshot-id>" --element "<element-id>" --dialog-action dismiss --json
   ```

4. Observe with `--diff` after every action. Every action invalidates the previous snapshot, while
   the persistent browser session keeps the same authorized CDP target and semantic baseline.
   Continue until the user goal is complete, user input is required, or evidence is insufficient.

For literal sequences, derive the complete ordered token or field ledger before acting. Every requested token and field must map to exactly one successful Runtime action; never substitute an equivalent sequence.

For search and navigation tasks, an updated input value is not completion evidence. Confirm the requested state from the observed URL, page title, or result region. If those still describe the previous page after submission, try at most one evidence-based alternative action; if the second observation remains inconsistent, stop and report the stale state instead of repeating Enter, click, reload, or navigation.

## Safety

- Never load `ui-test-assistant-skill` or call quick/YAML/browser-use/Playwright/Chromium launch commands for this task.
- Never invoke arbitrary JavaScript, DevTools snippets, another browser driver, or direct CDP clients.
- Never guess or reuse an `elementId`. On `STALE_SNAPSHOT`, observe and plan again.
- Do not send secret text to `set-value` or `type-text`. On `HANDOFF_REQUIRED`, stop immediately and ask the user to take over the visible browser.
- Upload only a file explicitly named by the user or created for the current task inside the authorized workspace. Never upload credentials, configuration secrets, SSH keys, browser profiles, or files discovered outside the workspace.
- Use `drag` only when the source exposes `drag` and the destination exposes `drop` in the same latest snapshot.
- Supply `dialog-action` only after `DIALOG_RESPONSE_REQUIRED` identified the dialog, unless the user explicitly requested a known alert/confirm action. Do not guess its message, type, or default value.
- On `HUMAN_CONTROL_ACTIVE`, stop issuing actions until UIWarden resumes Agent control.
- Change tabs only when `tabs list` explicitly reports an Agent-selectable policy and the target appears in that response. Otherwise ask the user to select the target in UIWarden and continue.
- Respect `riskLevel`. For an irreversible action not explicitly requested by the user, stop before clicking it.
- If the page state, screenshot, or semantic tree cannot expose the requested result, report the evidence gap. Do not invent completion evidence.
- Treat conflicting evidence conservatively: the URL/title/result content overrides a field value or an unverified `visualChanged` signal. Never alternate indefinitely between submit methods.

## Result

Report only actions that returned a successful Runtime action record in the current `DT_GUI_BROWSER_SESSION_ID`, plus the directly observed final page state, anything left for the user, and any capture gap. If the initial observation already satisfies the request, say that no mutating action was needed; never attribute pre-existing page state or actions from an earlier turn to the current turn. Do not emit test PASS/FAIL, coverage, assertions, or regression conclusions.
