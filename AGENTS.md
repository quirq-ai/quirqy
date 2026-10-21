# Quirqy project rules

## Every page is a 3D visualization

- Every page must be a 3D visualization page. A page without a meaningful 3D visualization has no reason to exist in Observatory.
- The interactive 3D scene is the primary experience. Lists, charts, timelines, and tables may support it in panels or controls; they must not replace it as the purpose of a page.
- Preserve the established Observatory theme across every page. Use Data Lab as the reference for the 3D visual language, typography, colors, navbar, liquid-glass panels, spacing, dock, and interactions. Reuse shared components instead of creating a separate design for each tab.

## Activity Lab scope

- Activity Lab visualizes repository collaboration and community activity in 3D: pull requests, issues created and updated, reviews, comments, forks, and contributor participation.
- It uses the same repository connection and Observatory experience as Data Lab, with activity data driving the 3D visualization.
- Commit and file history alone do not satisfy Activity Lab's purpose. Do not substitute another code-history visualization for the requested collaboration and community activities.
- The earlier commit/file-history Activity implementation was rejected. The user has now explicitly authorized replacing it with the 3D collaboration and community activity experience described above.

## Shared dock opacity

- Every existing and future dock surface must follow the user's shared opacity setting: the dock, app tiles, cards, buttons, fields, menus, tooltips, and decorative material. Reuse `src/ui/dock-material.css`; do not add fixed opaque backgrounds or independent opacity settings.
- Native controls inside `.panel-dock` inherit the material automatically. Mark custom cards with `data-dock-surface`; customize their palette with `--dock-tint`, not a separate alpha. Detached dock menus must use `data-dock-material` and the shared `.panel` treatment. App tiles must use `.repository-app-icon` with the shared palette variables.
- Change surface paint, not container `opacity`. Keep text, icon glyphs, slider indicators, focus outlines, and semantic status indicators readable. Image-preview checkerboards and modal focus scrims are semantic content, not dock material. Preserve disabled and disclosure states and the shared accessibility overrides.
- Check new dock components at 0%, 50%, and 100%, including hover, selected, expanded, and narrow-screen states. They must inherit future opacity changes without per-component JavaScript.
