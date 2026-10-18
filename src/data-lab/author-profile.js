// GitHub account metadata only: an author name or email is never an account ID.
const LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}(?:\[bot\])?$/i;
const LOCAL_AVATAR = /^\/data-lab\/authors\/[a-z\d_-]+\.(?:png|jpe?g|webp)$/i;

function avatarUrl(value) {
  if (typeof value !== 'string') return null;
  if (LOCAL_AVATAR.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'avatars.githubusercontent.com'
      || url.username || url.password || url.port || url.hash) return null;
    return url.href;
  } catch { return null; }
}

/** Accept API users or saved profiles; never allow an imported image/link scheme. */
export function normalizeAuthorProfile(profile) {
  if (!profile || typeof profile !== 'object' || typeof profile.login !== 'string'
    || !LOGIN.test(profile.login)) return null;
  return {
    login: profile.login,
    avatarUrl: avatarUrl(profile.avatarUrl ?? profile.avatar_url),
    url: `https://github.com/${encodeURIComponent(profile.login)}`,
  };
}
