// Path globs for config `paths`, matched against repo-relative paths with
// forward slashes. `**` spans directories, `*` and `?` stay inside one segment.
// A pattern without a slash matches the file name at any depth, like .gitignore,
// so `package.json` also covers `packages/a/package.json`.
const cache = new Map();

function toRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesGlob(path, pattern) {
  let re = cache.get(pattern);
  if (!re) cache.set(pattern, (re = toRegExp(pattern)));
  const target = pattern.includes('/') ? path : path.slice(path.lastIndexOf('/') + 1);
  return re.test(target);
}

export function matchesAny(path, patterns) {
  return patterns.some((p) => matchesGlob(path, p));
}
