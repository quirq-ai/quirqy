// Shared by the repository scene and its guide so visual meanings stay aligned.
export const FOLDER_COLORS = [0x85b8dd, 0xdbad72, 0x9eb8a2, 0xaa9ac7, 0x7cb9bd, 0xcc9490, 0xa7b4ca, 0xc5bd94];
export const CHANGE_COLORS = { added: 0x86d7ad, copied: 0x86d7ad, modified: 0xf1bf78, renamed: 0xa6baf0, removed: 0xcb8c87 };

export const FILE_KINDS = [
  { id: 'code', label: 'Code & other files', description: 'Spheres represent source code and other unclassified file formats.' },
  { id: 'data', label: 'Data & configuration', description: 'Diamonds represent JSON, YAML, CSV, TOML, SQL and XML files.' },
  { id: 'document', label: 'Documents', description: 'Cubes represent Markdown, text, reStructuredText, PDF and license files.' },
];

export function fileKind(path) {
  const ext = path.split('.').pop().toLowerCase();
  return ['json', 'yaml', 'yml', 'csv', 'toml', 'sql', 'xml'].includes(ext)
    ? 'data'
    : ['md', 'txt', 'rst', 'pdf', 'license'].includes(ext) || /(^|\/)LICENSE$/i.test(path)
      ? 'document'
      : 'code';
}
