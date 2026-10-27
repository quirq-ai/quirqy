# open-chat — swarm-ui

**open-chat** is a Next.js workspace with read-only file access and a browser-local sample chat with **quirqy**, the assistant identity shown in the header and beside saved assistant messages. It follows OpenMuse's visual design while taking its content directly from a local directory.

Folders provide navigation. Files provide documents, data, cards, and saved conversations. Change those files with your editor, scripts, or your own API, and the open app reflects the changes. No model API key, database, hosted agent runtime, or cloud service is required.

## Application-only branch

This branch contains the open-chat application and tests, without observed data, bundled demo content, or local environment settings. Startup creates an empty, git-ignored workspace directory. Keep your data separately; the optional sample content is in https://github.com/quirq-ai/quirq.

## Run locally

Use Node.js 22 or newer:

```bash
git clone --branch swarm-ui --single-branch https://github.com/quirq-ai/quirqy.git
cd quirqy
npm install
npm run dev
```

Open [http://127.0.0.1:3210](http://127.0.0.1:3210). The server binds to `127.0.0.1`. The included launchers are `./start-local.ps1` in PowerShell and `sh start-local.sh` in a shell.

For a production build running locally:

```bash
npm run build
npm start
```

The default content directory is `./workspace`, created empty by the startup/build preparation step and excluded from Git. To mirror another directory, create `.env.local` in the app directory and restart the server:

```dotenv
MIRROR_ROOT=/absolute/path/to/your/content
```

On Windows, forward slashes work too, for example `MIRROR_ROOT=D:/my-content`. Relative paths are resolved from the app directory. Run the app as a Node service with access to that directory; the browser itself does not read your disk directly.

## Appearance

Use the appearance icon beside the help button to choose **Light**, **Dark**, or **System**. System is the default and follows your device, including changes while the app is open. Your choice persists in this browser and synchronizes across its open tabs. It does not write to the content directory. Dark mode styles conversations, cards, documents, source/JSON views, navigation, menus, and notices; images and PDF contents retain their original colors.

## Views and navigation

### Folder view and dock

Every visible top-level folder becomes an item in the floating dock. Open one to browse its files and nested folders. Breadcrumbs and the workspace menu let you move through the real directory hierarchy. Folder views have a filename search field. Chat views that declare `demoReplies` instead show a working message composer. Filename search is scoped to the current folder, not a recursive content search. Selecting Chat in the dock opens its saved conversation when an `index.json` exists.

On a first visit without a deep link, a root `index.json` opens automatically when present. Opening a folder displays its file list. If that folder contains `index.json`, an Open card lets you select that saved view. An `index.json` filename alone does not determine the presentation: its JSON structure does.

### Saved conversation view

A JSON object with `"type": "conversation"` and a valid `messages` array becomes a conversation. User messages appear as user bubbles, assistant messages are labeled **quirqy**, and system messages are labeled Note. Message text supports Markdown; optional file links open other locations in the workspace.

The messages in the file remain saved records. A conversation can opt into an interactive demo by adding a workspace-relative reply configuration path:

```json
{ "type": "conversation", "demoReplies": "Chat/replies.json", "messages": [] }
```

The sample Chat view includes seeded messages, suggested prompts, an editable composer, Enter to send, Shift+Enter for a new line, a typing state, Stop, and Reset. New messages and drafts are stored in session storage for this browser tab and conversation, including across reloads. Reset clears those local additions while preserving the saved messages in the file. Leaving a conversation cancels a pending sample reply. No workspace files are modified by chatting. Local demo history keeps the latest 100 added messages; each message and draft is limited to 4,000 characters.

Replies come from the first matching keyword rule in `Chat/replies.json`, or its fallback. Edit that file to change responses and suggested prompts; the app refreshes it from disk. It uses the following shape:

```json
{
  "type": "demo-replies",
  "suggestions": [{ "label": "Find a file", "prompt": "Help me find a file" }],
  "rules": [{
    "keywords": ["file", "files"],
    "content": "Here is the guide.",
    "links": [{ "label": "Read it", "path": "Files/Welcome.md" }]
  }],
  "fallback": { "content": "Try asking me to find a file." }
}
```

Keyword matching ignores case and punctuation and matches complete words or phrases. Rule order determines priority. Missing or malformed configuration is reported beside the composer. The Source toggle always shows the original file, excluding local demo turns.

### Collection view

A JSON object with `"type": "collection"` and an `items` array becomes a list of cards. Every item needs a string `title`. Optional descriptions, categories, status labels, metadata, progress values, and paths enrich each card. A card with a path opens that file or folder. Status and progress are displayed values from disk, not evidence of background execution.

### JSON inspector

Other valid JSON is shown as expandable data, including nested objects, arrays, strings, numbers, booleans, and null. Objects that do not match the conversation or collection shape also fall back to the inspector. For responsiveness, the tree displays up to 100 entries per node and eight nested levels; Source retains the full loaded text.

### File-preview overlay

Files selected in the library, conversation links, collections, and Markdown links open in a modal preview above the current screen. The conversation, draft, and scroll position remain behind it. The overlay supports the same file renderers and Source toggle, follows file changes, and keeps a previous-file history when you open another file inside the preview.

Use the close button, Escape, or the backdrop to dismiss it. The expanded-view button opens a file as a full page. Folder links navigate to that folder. Native dialog behavior traps keyboard focus while open and restores it when closed. On mobile the preview becomes a bottom sheet. Direct file URLs and explicit folder-index view cards still support full-page views.

### Document, text, and source views

Markdown opens as a formatted document. Recognized text and code files open as plain source. The Source/Preview toggle shows the original loaded text for JSON and Markdown as well. Malformed JSON stays readable as source with a parsing notice.

HTML and SVG files are displayed as text. They are not executed or embedded as active pages. Markdown raw HTML is skipped, and inline Markdown images are represented by their alt text; open a supported image file directly for an image preview.

### Image and PDF views

Supported image files have an image preview. PDFs open in an embedded browser viewer with a link to open the document in a new tab; PDF display depends on browser support. The binary endpoint checks file signatures as well as extensions.

### The example workspace

Folders you create can illustrate different uses of the same renderers (no content folders are bundled on this branch):

- **Chat:** saved conversations and linked responses.
- **Activity:** saved plans, progress, and reading notes.
- **Ideas:** collections of suggestions and supporting files.
- **Goals:** saved milestones, progress cards, and checklists.
- **Files:** a collection linking to Markdown, ordinary JSON, CSV, plain text, and nested notes.

These folder names are examples, not separate backend applications. Interactive sample chat is enabled by the `demoReplies` property on the conversation file, rather than by the folder name. You can rename them or add your own folders. The menu browses files, and the information panel explains the current workspace and its read-only access.

## Supported content types

- **Structured JSON:** `.json`; optional conversation and collection shapes, or the generic inspector. The file must contain valid JSON for a structured preview.
- **Markdown:** `.md`, `.markdown`, `.mdx`; headings, lists, links, code blocks, GitHub-style tables, and read-only task checkboxes through `react-markdown` and `remark-gfm`. MDX is treated as Markdown; JSX and imports are not executed.
- **Images:** `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` with matching file signatures.
- **Documents:** `.pdf` with a matching PDF signature. There is no Office-document reader.
- **Plain text and code:** the recognized UTF-8 extensions below. CSV/TSV are shown as text, not spreadsheet tables; YAML, TOML, XML, and JSONC are shown as text, not parsed into structured views. Code is displayed, not executed, and has no syntax highlighting.

```text
txt text csv tsv log js jsx ts tsx mjs cjs
jsonc css scss sass less html htm xml svg yaml
yml toml ini conf config sql py rb rs go java
kt kts swift sh bash zsh fish ps1 bat c cpp
cc h hpp cs vue svelte astro prisma graphql gql
proto diff patch r rmd tex dockerfile lock
```

The exact filenames `Dockerfile`, `Makefile`, `LICENSE`, `README`, and `CHANGELOG` are also recognized as text, case-insensitively. Unknown extensions, other binary files, and non-UTF-8 text get a file-information view explaining that no preview is available. Audio, video, Office documents, executable widgets, and arbitrary HTML applications do not have dedicated viewers.

Text previews are limited to 2 MB, image/PDF previews to 20 MB, and directory listings to 2,000 visible entries. Limits produce explicit messages rather than silently truncating file contents or listings.

## JSON content examples

Presentation link paths are relative to the workspace root, using `/` between folder names. Markdown links instead resolve relative to their containing document; a leading `/` resolves from the workspace root.

### Saved conversation

```json
{
  "type": "conversation",
  "title": "Project notes",
  "subtitle": "Saved on disk",
  "messages": [
    {
      "role": "user",
      "content": "Where is the brief?"
    },
    {
      "role": "assistant",
      "content": "The brief is in the Files folder.",
      "time": "10:30 AM",
      "links": [{ "label": "Read the brief", "path": "Files/Notes/Design.md" }]
    }
  ]
}
```

Each message needs a string `content` and a `role` of `user`, `assistant`, or `system`. `title`, `subtitle`, `time`, and message `links` are optional. The visible assistant name is quirqy; no model name or provider is inferred from the message.

### Collection

```json
{
  "type": "collection",
  "title": "Research",
  "subtitle": "Useful documents",
  "items": [
    {
      "title": "Design brief",
      "description": "The current workspace direction.",
      "status": "Saved",
      "category": "Notes",
      "progress": 40,
      "path": "Files/Notes/Design.md",
      "meta": "Markdown"
    }
  ]
}
```

Each item needs a string `title`; the other illustrated properties are optional. `path` may point to a file or folder. Numeric progress is displayed within 0-100. Unknown fields remain accessible through Source.

## Is there a generation engine?

**There is no AI generation engine in open-chat.** quirqy presents saved conversations and can respond in the interactive demo using a deterministic keyword matcher over the local reply JSON file. This is sample-response selection, not model inference. It does not autonomously reason or execute tasks. There are no LLM calls, agent loops, embeddings, or CopilotKit Intelligence integration.

The app does have a deterministic rendering pipeline:

1. Next.js Node route handlers read files with `node:fs` from `MIRROR_ROOT`.
2. `lib/filesystem.ts` classifies files and parses `.json` with `JSON.parse`.
3. React components choose the conversation, collection, inspector, document, text, or binary preview based on file type and the optional JSON shapes.
4. `react-markdown` with `remark-gfm` renders Markdown. React and Next.js render the interface; none of these libraries generates the saved content.
5. The active browser polls the read-only API every 1.5 seconds. Snapshot hashes and ETags detect changes and avoid resending an unchanged view. Polling pauses while the tab is hidden.

To add generation later, run your own API, script, model, or agent separately and have it write files into the content directory. For example, a script can write a conversation JSON file, and open-chat will render it on the next refresh. That producer decides the model, credentials, storage format, and execution stack; it is not a mandatory dependency of this app.

## Filesystem boundaries

Content endpoints use read-only `GET` routes. The app has no content-write endpoint. Names starting with `.` and `node_modules` are excluded. Paths containing colons or backslashes are not exposed. Ordinary folders such as `dist` remain visible.

The backend enforces the configured root boundary: internal symlinks work, while links that escape the root or resolve to hidden paths are excluded. If a saved view cannot be refreshed, the UI reports the error and labels any retained view as the last saved view.

## Development checks

```bash
npm run typecheck
npm test
npm run build
```

The app includes filesystem/API, theme-initialization, and demo-chat configuration/session tests. Laptop layouts use a 960px maximum width; mobile retains the compact layout. Production builds currently report dynamic-filesystem tracing warnings because `MIRROR_ROOT` is resolved at runtime. Exact visual parity with upstream has not been independently verified.

## Visual attribution

The layout and visual styles are ported from [CopilotKit/OpenMuse](https://github.com/CopilotKit/OpenMuse), especially `apps/mobile/App.tsx` and `apps/mobile/src/ui.tsx`, into Next.js. The upstream MIT notice is retained in `OPENMUSE-LICENSE`. open-chat uses its own filesystem data layer and the assistant name quirqy.

### Interactive avatar

The header uses [Blobatar](https://blobatar.dev/) to generate quirqy locally as SVG. It blinks, breathes, and follows the pointer. Hover or keyboard focus makes it wink; drafting a chat message makes it curious, waiting for a sample reply makes it think, and a completed reply makes it happy. Click the avatar (or press Enter/Space while focused) to change its shape and color. The quirqy name below opens the observation-root folder picker. Motion and pointer tracking respect the system reduced-motion preference. This uses the bundled blobatar and @blobatar/react packages, with no hosted avatar API, credentials, or generation engine. Changes to the avatar stay in memory for the current visit and do not write to workspace files.

### Change the observed folder

Click the **quirqy name** under the avatar to open the folder picker. Browse subdirectories, use the breadcrumbs or Parent folder to go back, then choose **Observe this folder**. Empty folders can be selected. The page reloads at the new root, and all content, previews, dock folders, and sample replies resolve within it. The browser remembers your selection in a same-site cookie; chat drafts and sample messages are scoped by workspace. The avatar itself still changes its look on click.

By default the picker stays inside MIRROR_ROOT (or the empty local workspace). Set MIRROR_BROWSE_ROOT in .env.local to a broader directory if you want to choose sibling workspaces, for example MIRROR_BROWSE_ROOT=D:/XO/quirq with MIRROR_ROOT=D:/XO/quirq/swarm-desktop. The initial root remains MIRROR_ROOT until you select another folder. The picker rejects traversal, hidden/dependency paths, file targets and symlinks outside its configured boundary. This changes only a browser preference, never the observed files or environment configuration.

### JSONL feeds

Files ending in .jsonl or .ndjson open as a read-only feed, with one post per nonblank line, in original file order. Common author/sender/role, timestamp, title, type, and content/text/body/message fields become post text and metadata. Nested message objects and text content blocks are supported. Text uses the existing safe Markdown renderer. Expand **View JSON record** for all original fields; arbitrary objects, arrays, numbers, booleans and null remain inspectable as JSON posts. Malformed lines show their line number and original text without hiding neighbouring records. Blank lines are skipped, while physical line numbers are preserved. Feeds show 25 posts per page, support Source, work in file overlays and full-page views, and refresh when the file changes on disk. The existing 2 MB UTF-8 text limit applies.

### URL files

Open a .url file to embed its webpage, with an **Open in new tab** link beside the address. Supported contents are a single HTTP/HTTPS URL (for example https://example.com/) or a Windows Internet Shortcut with [InternetShortcut] and URL=https://example.com/ on separate lines. Invalid or non-web URLs show an explanation; Source remains available. URL previews work in overlays and full-page views and update when the file changes. External webpages load directly in a sandboxed iframe with no referrer, without a server proxy or added API key. Sites can block iframe embedding or require capabilities unavailable in the sandbox; use the new-tab link for those pages. The existing 2 MB UTF-8 text limit applies.
