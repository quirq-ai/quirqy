// Shared controls register each repository page through the same small contract.
export const REPOSITORY_LABS = Object.freeze([
  { mode: 'data', label: 'Data', timeline: true },
  { mode: 'activity', label: 'Activity', timeline: true },
  { mode: 'about', label: 'About', timeline: false },
].map(lab => Object.freeze({
  ...lab,
  panelId: `${lab.mode}-panel`,
  guideId: `${lab.mode}-guide`,
  dockId: `${lab.mode}-timebar`,
  viewSwitch: `.${lab.mode}-view-switch`,
  speedSelector: `.${lab.mode}-speed`,
})));
