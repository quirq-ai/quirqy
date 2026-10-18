import { normalizeCommunityActor } from './github.js';

// Verified against contributor records, never inferred from names or emails.
// Source URLs, capture times and hashes: /activity-lab/contributors/provenance.json.
const bundledPortraits = new Map([
  [
    "quirq-gates",
    {
      "identity": "/u/333820652",
      "path": "/data-lab/authors/quirq-gates.png"
    }
  ],
  [
    "krishbhimani",
    {
      "identity": "/u/126689784",
      "path": "/data-lab/authors/krishbhimani.png"
    }
  ],
  [
    "seemanttripathi",
    {
      "identity": "/u/47049137",
      "path": "/activity-lab/contributors/seemanttripathi.png"
    }
  ],
  [
    "sharmasuraj0123",
    {
      "identity": "/u/36091186",
      "path": "/data-lab/authors/sharmasuraj0123.jpg"
    }
  ],
  [
    "dwivedi-ai",
    {
      "identity": "/u/65527745",
      "path": "/data-lab/authors/dwivedi-ai.jpg"
    }
  ],
  [
    "mukesh804",
    {
      "identity": "/u/73191137",
      "path": "/activity-lab/contributors/mukesh804.png"
    }
  ],
  [
    "rohini-sp",
    {
      "identity": "/u/138889836",
      "path": "/activity-lab/contributors/rohini-sp.png"
    }
  ],
  [
    "sagarrambade21",
    {
      "identity": "/u/241298048",
      "path": "/data-lab/authors/sagarrambade21.jpg"
    }
  ],
  [
    "quirq-dev",
    {
      "identity": "/u/256758572",
      "path": "/data-lab/authors/quirq-dev.jpg"
    }
  ],
  [
    "andreolf",
    {
      "identity": "/u/15174764",
      "path": "/activity-lab/contributors/andreolf.jpg"
    }
  ],
  [
    "copilot",
    {
      "identity": "/in/1143301",
      "path": "/activity-lab/contributors/copilot.png"
    }
  ],
  [
    "harishkotra",
    {
      "identity": "/u/4999463",
      "path": "/data-lab/authors/harishkotra.png"
    }
  ],
  [
    "argus-runtime",
    {
      "identity": "/u/298680943",
      "path": "/activity-lab/contributors/argus-runtime.png"
    }
  ]
]);

/** Return a trusted portrait URL, or null so the scene can keep its fallback. */
export function contributorPortrait(actor) {
  const profile = normalizeCommunityActor(actor);
  if (!profile.login || !profile.avatarUrl) return null;
  const bundled = bundledPortraits.get(profile.login.toLowerCase());
  // Login alone is insufficient: also match the numeric GitHub avatar identity.
  if (bundled && new URL(profile.avatarUrl).pathname === bundled.identity) return bundled.path;
  return profile.avatarUrl;
}
