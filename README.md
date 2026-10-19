# Quirqy

<img src="public/quirq-logo.svg" width="72" alt="Quirqy logo" />

**Explore repositories, their history, and the people around them in interactive 3D.**

Quirqy builds on Observatory's shared 3D engine and liquid-glass interface. Its primary repository apps are **Data Lab** for files and commit history, and **Activity Lab** for pull requests, issues, reviews, comments, forks, and contributors. Scientific instruments remain available through the dock's **Apps** launcher.

This project is maintained on the `quirq` branch of [quirq-ai/quirqy](https://github.com/quirq-ai/quirqy). Every page centers on a meaningful 3D visualization; panels and timelines support the scene.

The existing `v0` tag preserves the original remote baseline, and `v0.1` marks an earlier checkpoint. The `quirq` branch contains the subsequent work documented here.

## Run locally

Use **Node.js 22 or newer**, npm, and a modern browser with WebGL support.

```bash
git clone --branch quirq https://github.com/quirq-ai/quirqy.git
cd quirqy
npm ci
npm run dev
```

Open [Data Lab](http://localhost:5174/data) or [Activity Lab](http://localhost:5174/activity). The default development port is `5174`; Vite prints the actual address if that port is occupied. Opening `/` opens the Solar System.

```bash
npm run build       # Production files in dist/
npm run preview     # Preview the production build, normally on port 5174
npm test
```

No application backend, environment file, GitHub token, or account setup is required. Live repository imports need network access to GitHub; the bundled example datasets load without a GitHub request.

## Start exploring

1. Open **Data** or **Activity** in the dock.
2. Choose the preloaded **quirq-ai/xo** or **quirq-ai/xo-space** example, or enter a public repository URL such as `https://github.com/owner/repository` and choose **Load**.
3. Select a scene view above the dock's app row. Use **Timeline** to show or hide playback controls, step through records, scrub, or change speed.
4. Click a scene item to inspect it. Use **Frame view** or **F** to return to the whole scene; **H** opens that lab's help.
5. Read **Data coverage** before interpreting a sample or exporting it.

The selected repository is shared between Data and Activity. The two labs use separate datasets and independent timelines. Data imports pin the repository's default branch to one commit. Branch, file, and query URLs are not accepted.

## Data Lab

Data Lab turns repository hierarchy and sampled first-parent commit history into two views:

- **Structure:** folders are carbon-like anchors and files are colored atoms, with file categories explained in the Scene guide. Files connect to their actual folders. While playing, folder marbles become enclosures around their contents and travelling current marks the current commit. Pausing restores the folder marbles and visible pathways. Brightness builds with loaded commit touches and rewinds with the timeline.
- **Growth tree:** directories form branches, files form leaves, and additions and removals animate through history. Branch weight follows mapped file counts. Leaf area uses known snapshot byte sizes with readability limits; historical byte sizes are not invented.

The Structure root shows the current commit author's portrait and name. During playback it glows; when paused, a wide glass message panel shows **only the commit title**, the commit ID, expandable changed files, line additions/deletions, and a GitHub link. Click the author's photo or name to collapse or reopen this panel. Unknown or unavailable portraits use initials.

**Frame roots** in Growth tree enlarges the root system and shortens the canopy around the same ground junction. Roots follow the real directory hierarchy. Every distinct loaded commit touching a file adds the same repository-calibrated length step, retained through renames and rewound with playback. The inspector reports touches and added length; compare added length within one repository and touch counts across repositories. Thickness is a visual effect. Dot-prefixed files and folders are hidden from roots, while the underlying dataset and other views retain them.

Root focus enables unrestricted rotation and sideways roll: **Shift-drag horizontally** or **twist two fingers**. **Frame view / F** restores upright orbit and canopy framing. Search files, focus a folder, inspect a selected file, and use **Data coverage → Export loaded data** to download the loaded metadata as JSON.

These visual encodings describe loaded repository structure and changes, not runtime dependencies, code quality, or individual productivity. The scene may map fewer files than the loaded dataset; the panel reports coverage and mapped counts.

## Activity Lab

Activity Lab visualizes actual public GitHub collaboration records in three arrangements:

| View | Arrangement |
| --- | --- |
| **Constellation** | Records grouped by activity type |
| **Orbits** | Records arranged around the repository |
| **Contributors** | Related participation grouped around contributors |

All three views use the same records, filters, and dated event timeline. Select a body or an Activity index entry to inspect it and follow its GitHub link; double-click a body to focus it. Search by title, number, or contributor, filter activity types, and choose an individual contributor.

**Pull request and issue clusters retain their total size**, including closed and merged history, while only open work is visible by default. To reveal loaded closed or merged records, select **only Pull requests** or **only Issues** in the Scene guide and enable **Show historical**. This toggle affects that selected category. It does not resize its cluster. Where a complete repository count is unavailable, **≥** marks a loaded lower bound; no bodies are invented for records that were not loaded.

Contributors receive the largest area and portrait circles, with GitHub handles and space reserved for readable portraits and labels. Verified example portraits are bundled; other available profile photos load from GitHub, with initials as a fallback.

**Refresh from GitHub** fetches a newer bounded sample. **Data coverage → Export snapshot** downloads the loaded metadata as JSON.

Playback reveals records at their returned timestamps and sampled issue events. Current statuses, titles, ownership, and contributor counts describe the fetched snapshot, not a reconstructed historical state. Contributors without historical timestamps stay visible during replay. Contribution counts are GitHub's aggregate commit counts, not collaboration scores or productivity measures.

## Dock, panels, and appearance

The repository apps share one dock and glass-panel system:

- **Logo in the middle of the bottom app row:** drag it to move the dock; click to smoothly collapse everything to the logo, then click again to expand. Controls keep their state. Reduced-motion preferences remove the transition.
- **Edit beside the logo (under it on narrow screens):** upload a PNG, JPG, WebP, or SVG up to 5 MB, or reset the default logo. Uploads are rasterized to a bounded PNG with transparency retained. The logo is shared by the dock, loading screen, favicon, and the legacy recording overlay.
- **Data, Activity, and Apps:** switch repository labs or open the other 3D instruments. Repository pages keep the top bar clear; scene choices appear above the dock's apps.
- **Timeline and Opacity:** independent controls in the dock. Panel opacity ranges from **0–100%** while text and controls remain readable. Clearer glass increases simulated edge refraction; more opaque glass adds softness. Browsers without SVG backdrop refraction retain blur and highlights. Reduced-transparency and high-contrast preferences use solid surfaces.
- **Floating sidebars:** drag their headers and use the header's **− / +** control to collapse or expand. On narrow screens, page buttons reopen the corresponding sheets.
- **Position shortcuts:** focused drag handles support Arrow keys, **Shift + Arrow** for larger steps, and **Home** to reset. Double-click a handle to restore its default position. Dock and panel positions are remembered separately for desktop and mobile.

Glass panels and the commit message panel share appearance tokens. The current user-facing appearance control is opacity; developers can adjust shared colors and material rules in `src/ui/glass-surfaces.css`.

### Repository scene controls

| Action | Control |
| --- | --- |
| Orbit / pan | Drag / right-drag |
| Zoom | Wheel or pinch |
| Inspect | Click a scene item |
| Focus an activity | Double-click an Activity body |
| Play / pause | Space |
| Previous / next commit or activity event | Left / Right Arrow |
| Frame scene | F |
| Help | H |
| Close help | Escape |
| PNG scene snapshot in Data Lab | S |

Shortcuts defer to focused inputs and controls. Root-focus rotation in Data Lab has the additional gestures described above.

## Bundled examples and live-import limits

**XO and XO Space are the only bundled repository examples.** They are captured snapshots, not live clones at runtime. Choosing an example loads checked-in JSON and known local portraits without contacting the GitHub API.

| Example | Data snapshot | Data history | Activity snapshot |
| --- | --- | --- | --- |
| `quirq-ai/xo` | 2026-10-18, pinned `b61bc4c` | 44 first-parent commits | 2026-10-18 |
| `quirq-ai/xo-space` | 2026-10-18, pinned `577850b` | 50 first-parent commits | 2026-10-18 |

The example's capture time, pinned commit, and limitations are available in the dataset and coverage UI. Startup normally opens XO; a saved repository session can restore the previous selection. New GitHub activity does not appear in a bundled snapshot until it is refreshed.

Live Data imports offer **8, 12, or 20 recent first-parent commits**, defaulting to 20. The loader retains at most **2,500 paths** and **200 changed files per commit**, prioritizing sampled changes. Merge changes are compared with the first parent; side-branch commits are not replayed separately. GitHub tree truncation, omitted paths, partial diffs, and submodule limitations are reported under Data coverage.

Live Activity imports make at most **20 public API requests**. Source limits are:

| Source | Maximum requested |
| --- | --- |
| Recently updated pull requests, all states | 20 |
| Issue/PR listing, all states | 50 |
| Issue-only search results, all states | 50 |
| Open pull requests / open issues | 50 each |
| Conversation comments / inline review comments | 30 each |
| Newest forks | 20 |
| Contributors | 30 |
| Issue workflow events | 50 |
| Reviews | 30 per PR for up to 8 loaded PRs |

These are source-page limits, not a promise of complete history or a single final item count: sources are merged and deduplicated, and issue events can supply related records. Public API access and search can be limited or denied. Partial Activity results identify unavailable sources; previously usable data remains available where possible. Use the bundled examples when GitHub is unavailable.

### Refresh Data's bundled snapshots

Normal users do **not** need Git or the local clones to open examples. Maintainers rebuilding the Data snapshots need Git and two bare clones outside the app repository:

```bash
mkdir -p ../.workspace-cache/observatory-examples
git clone --bare --depth=64 --single-branch --branch main https://github.com/quirq-ai/xo.git ../.workspace-cache/observatory-examples/xo.git
git clone --bare --depth=64 --single-branch --branch main https://github.com/quirq-ai/xo-space.git ../.workspace-cache/observatory-examples/xo-space.git
npm run examples:refresh
```

For existing clones, fetch first:

```bash
git -C ../.workspace-cache/observatory-examples/xo.git fetch --depth=64 origin main:refs/heads/main
git -C ../.workspace-cache/observatory-examples/xo-space.git fetch --depth=64 origin main:refs/heads/main
npm run examples:refresh
```

The generator reads Git objects without checking out or executing repository code. If it reports a shallow first-parent boundary, deepen that clone and rerun. Use `npm run examples:refresh -- --help` for custom cache/output paths, a 1–50 commit limit, pinned refs, and a reproducible capture timestamp.

Verified author mappings live in `src/data-lab/examples/author-profiles.json`. Unmapped commits use initials until their GitHub identity is verified. This script refreshes **Data snapshots only**. Activity examples are separate captured public API datasets in `src/activity-lab/examples/`; the Activity **Refresh from GitHub** button updates the browser's loaded snapshot, not those source files.

## Storage and privacy

Quirqy runs in your browser. Imports use public GitHub reads without credentials or tokens; imported repository code is never executed. Retained repository datasets contain metadata, such as paths, commit messages, authors, change counts, and collaboration records, rather than source blobs.

Browser storage is best-effort:

- **Data:** IndexedDB caches metadata snapshots, with a small localStorage pointer for the current selection. Defaults allow four cache entries and 8 MiB total; an individual saved snapshot is limited to 4 MiB.
- **Activity:** the last complete loaded snapshot is cached in localStorage when its serialized size fits the application's limit.
- **Preferences:** the connected repository URL, logo, panel opacity, view choices, and floating positions are stored locally. If storage is unavailable, features retain in-memory state where supported.

There is **no login or account-based synchronization**. A custom logo or saved session belongs to this browser and site origin; another device, browser, port, or deployed origin has its own storage. Clearing the site's browser data removes these preferences and caches. GitHub API requests and non-bundled profile pictures still make network requests. The app does not install an offline service worker.

## Other 3D instruments

Open these through **Apps** in the repository dock or by their direct URLs. Their old top-navbar links are hidden; their routes and implementations remain available.

| Instrument | Route | What it explores |
| --- | --- | --- |
| Solar System | `/` | Keplerian planetary motion, moons, Halley, belts, and an interactive N-body experiment |
| Equation Lab | `/equation` | Parametric curves, ODE/force fields, surfaces, swarms, superposition, data fitting, and saved experiment versions |
| SPM Mooring | `/spm` | Buoy motion, chains, weather inputs, catenary shape, and tension |
| Earth Lab | `/earth` | Earth layers, composition, atmosphere, magnetic field, and interior gravity |
| Light Lab | `/light` | Ray tracing, refraction, Fresnel reflection, dispersion, mirrors, and lenses |
| Gravity Lab | `/gravity` | Orbital mechanics, N-body particles, tunable force laws, and pedagogical quantum-gravity models |
| Photo Lab | `/photo` | Photoelectric effect and a simplified photosynthesis model |
| Fractals Lab | `/fractals` | Escape-time fractals, 3D raymarched fractals, IFS, and diffraction patterns |

The scientific instruments retain their original numerical methods: JPL approximate planetary elements, leapfrog N-body integration, RK4 equation integration, quasi-static catenary mooring, and Snell/Fresnel/Cauchy optics. These are models with deliberate approximations. For example, solar ephemerides omit full planetary perturbations, the mooring is not a full dynamic cable model, and quantum-gravity modes are pedagogical effective models.

### Capture availability

- **Data Lab:** **S** downloads a PNG scene render. The camera/recording button is not part of its dock.
- **Activity Lab:** exports the loaded activity snapshot as JSON. It does not currently expose screenshot or video recording.
- **Scientific instruments:** the existing runtime retains PNG capture with **S** and canvas video recording with **V**, up to **10 seconds**, where the browser supports `MediaRecorder` and canvas capture. It records the rendered canvas plus its custom logo/readout overlay, not the entire browser window or arbitrary DOM panels. Available video formats depend on browser support. The legacy recorder also exports sampled JSON/CSV traces; trace support varies by instrument.

The repository labs use separate runtimes and do not inherit the legacy video recorder.

## Deploy

```bash
npm ci
npm run build
```

Publish **`dist/`** to a static host. Configure unknown application routes to serve `index.html` so direct visits to `/data`, `/activity`, and the instrument routes work. Serve existing assets normally.

The current app uses root-relative routes and asset URLs; deploy at the site's root. Hosting under a subdirectory requires route and asset-path changes. No backend or application environment variables are required. `PORT` optionally changes the local Vite development/preview port. `npm run preview` is for checking a build locally.

## Development

Quirqy uses vanilla JavaScript ES modules, **three.js 0.170**, and **Vite 6**.

| Path | Responsibility |
| --- | --- |
| `src/bootstrap.js` | Shared UI startup and runtime selection |
| `src/data-lab/` | Repository import, commit model, Structure/Growth tree scenes, controls, and examples |
| `src/activity-lab/` | Public collaboration loader, activity model, 3D views, contributor portraits, and examples |
| `src/repository/` | Shared repository connection and persisted Data session |
| `src/ui/` | Glass material, movable panels, dock apps/disclosure/motion, timelines, and legacy panels |
| `src/branding/` | Local logo preference and editor |
| `src/nav/routes.js` | Stable route map |
| `src/main.js` | Scientific instrument runtime and render loop |
| `src/scene/`, `src/camera/` | Shared rendering and camera tools |
| `src/sim/`, `src/math/`, `src/earth/`, `src/spm/`, `src/light/`, `src/gravity/`, `src/photo/`, `src/fractal/` | Scientific engines and scenes |
| `src/capture/` | Legacy canvas video, overlays, and sampled traces |
| `scripts/build-data-examples.mjs` | Reproducible Data metadata snapshots from bare clones |

Read [AGENTS.md](AGENTS.md) before changing the interface. Every page must remain a meaningful 3D visualization, with Data Lab as the shared visual reference. Activity Lab is about collaboration and community records, not a substitute commit/file-history scene.

Branch from `quirq`, keep changes focused, and run:

```bash
npm test
npm run build
```

For UI changes, also exercise the affected flow in a browser at desktop and narrow widths. Preserve keyboard access, reduced-motion behavior, shared glass styling, and truthful data-coverage notices. Keep generated builds, node_modules, and local clone caches out of commits.

When changing a scientific solver or physical constant, cite its source and compare the result with an analytic solution, published value, or known limiting case. Pull requests should explain the behavior change and relevant validation.

## Credits and license

Quirqy continues the [original Observatory project](https://github.com/sharmasuraj0123/observatory).

- **Planetary elements:** E. M. Standish, JPL/NASA, “Keplerian Elements for Approximate Positions of the Major Planets.”
- **Earth interior:** PREM (Dziewonski and Anderson, 1981) and IUGG reference values.
- **Textures:** [Solar System Scope](https://www.solarsystemscope.com/textures/), CC BY 4.0, based on NASA imagery.
- **Engine and tooling:** [three.js](https://threejs.org/) and [Vite](https://vitejs.dev/).
- **Brand:** the Quirq/XO mark. Repository records and profile images retain their source attribution.

Texture assets are CC BY 4.0 as noted above. **Application code has no license declared yet.** The texture license does not license the application code; contact the maintainers to confirm reuse terms.
