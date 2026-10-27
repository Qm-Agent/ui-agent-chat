# UI Upload Test Files

This directory is reserved for files that UI tests may upload.

Built-in fixtures:

- `file_jpg.jpg`: image upload fixture.
- `file_jpeg.jpeg`: alternative image upload fixture.
- `file_pdf.pdf`: PDF/document upload fixture.
- `file_md.md`: text/markdown upload fixture.

Usage:

- Put test fixtures here, for example PDFs, images, spreadsheets, archives, or other files required by upload flows.
- Prefer specifying the exact local path in a user request or test case, for example:
  `/path/to/skills/ui-test-assistant-skill/config/upload_files/sample.pdf`
- If the user asks to verify an upload flow but does not specify which file to upload, the agent may choose one built-in fixture from this directory according to the page hint or accepted file type.
- The runner should use a user-specified path as-is when provided.
- Do not store sensitive production data here.
- Files in this directory are ignored by git by default, except this README, `.gitkeep`, `.gitignore`, and the built-in fixtures listed above.
