// Shared controls register each repository lab through the same small contract.
export const REPOSITORY_LABS = Object.freeze(['data', 'activity'].map(mode => Object.freeze({
  mode,
  panelId: `${mode}-panel`,
  guideId: `${mode}-guide`,
  dockId: `${mode}-timebar`,
  viewSwitch: `.${mode}-view-switch`,
  speedSelector: `.${mode}-speed`,
})));
