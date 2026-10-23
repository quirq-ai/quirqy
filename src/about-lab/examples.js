import xo from './examples/xo.json';
import space from './examples/xo-space.json';
import { parseRepositoryUrl } from '../data-lab/github.js';

// Actual public README snapshots. Refresh in GitHub controls for the latest text.
const snapshots = [xo, space];
export const DEFAULT_ABOUT_REPOSITORY = xo.repository.url;
export const ABOUT_EXAMPLES = snapshots.map(({ repository }) => repository);
export function getReadmeExample(input) {
  try {
    const name = parseRepositoryUrl(input).fullName.toLowerCase();
    const snapshot = snapshots.find(item => item.repository.fullName.toLowerCase() === name);
    return snapshot ? structuredClone(snapshot) : null;
  } catch { return null; }
}
