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
| `.html`, `.htm`                         | A **Preview** tab (a static page in a locked-down frame) and a **Source** tab.                           |
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
- An HTML file is previewed only in a frame with every sandbox restriction on: no scripts, no forms, no popups and no access to FullDots or its data. FullDots' own security policy also blocks anything the page tries to load from the network, so it shows as a static page. Opened by its address, it is plain text.
- Scripts and other active formats are kept only as downloads. They are never shown.
- A file's address is served with `nosniff` and a sandboxing Content Security Policy, and the viewer shows text, images and PDFs from blobs, so nothing in a stored file runs in the app.
- Files follow the same owner checks as every other API route.

## Files from a Dot

A Dot keeps a result in a Space with these tools, so you do not need a computer for it:

| Tool                                  | What it does                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `save_space_file`                     | Saves text the Dot wrote as a file (CSV, Markdown, HTML, JSON or text). The extension decides how it is shown.                              |
| `list_space_files`, `read_space_file` | Lists a Space's files and reads a text file, so a Dot can build on earlier results.                                                         |
| `copy_computer_file_to_space`         | Copies a text file from the Dot's computer into a Space (up to the computer's read limit, about 64 KB). Needs Files access on the computer. |

When a Dot saves a file, the chat shows a **file card** with the name, type, size and Space. Click it to open the viewer; the small link on the card opens it in a new window.

- **Access:** a Dot reaches only the Spaces it was granted, the same as pages.
- **Approvals:** saving a file counts as **Write files**. In the "writes" approval mode it asks first, and a "never" rule for Write files blocks it. Listing and reading do not ask. See [Approvals](APPROVALS.md).
- **Untrusted content:** a Dot treats file contents as data, never as instructions.
- **Not yet:** images and other binary files cannot be saved by a Dot, and a file made in a computer is copied, not linked.

Files a Dot creates inside its computer stay in that computer's workspace unless it copies them to a Space.
