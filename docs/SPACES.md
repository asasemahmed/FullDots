# Spaces

A **Space** is a named workspace for the work you keep. It holds **pages** (rich-text documents in a tree) and **files** (a CSV, a report, an image, a PDF). A chat is where work happens; a Space is where results stay, organized and editable. Each Dot reaches only the Spaces you granted it.

## Pages

Pages nest without a depth limit. Any page can have subpages, so a page works as a folder that also has content. Use **New subpage** in a page's menu, or choose a page's **parent** in its settings to move it with everything under it. Deleting a page moves its subpages and files up to its parent.

## Files

Open a Space and choose **Upload files**, or drop files on the library. Files appear in the library and in the sidebar tree, under the page they belong to.

| File                                    | Shown as                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `.csv`, `.tsv`                          | A table with sticky headers and sortable columns. The first 5,000 rows are shown; download for the rest. |
| `.md`                                   | Rendered Markdown.                                                                                       |
| `.txt`, `.log`                          | Text.                                                                                                    |
| `.json`                                 | Pretty-printed text.                                                                                     |
| `.png`, `.jpg`, `.gif`, `.webp`, `.svg` | The image.                                                                                               |
| `.pdf`                                  | The browser's PDF viewer.                                                                                |
| Anything else                           | A download, with no preview.                                                                             |

Every file has **Download**, **Rename**, **Delete** and **New window**, and text files have **Copy**. A link to a file is `/#/spaces/<space>/files/<file>`; opening it shows the viewer.

Two files in one place never share a name: a clash becomes `report (2).csv`.

### Limits and storage

- A file can be up to `SPACE_FILE_MAX_MB` megabytes (default 10, at most 50).
- Files are stored in the same SQLite database as pages, so `npm run backup` includes them. Keep an eye on the database size if you store many large files.

### Security

- The server decides a file's type from its name and ignores any type a client sends.
- HTML, scripts and other active formats are kept only as downloads. They are never shown as pages.
- A file's address is served with `nosniff` and a sandboxing Content Security Policy, and the viewer shows text, images and PDFs from blobs, so nothing in a stored file runs in the app.
- Files follow the same owner checks as every other API route.

## Where a Dot's files go

Files a Dot creates in its computer stay in that computer's workspace folder; they are not in a Space. Dot tools for saving results straight into a Space, and file cards in the chat, are planned as a follow-up.
