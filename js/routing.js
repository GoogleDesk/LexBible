// LexBible — URL routing helpers
//
// URL shape:
//   /                            → default course, default tab
//   /criminal-law                → that course, textbook tab
//   /criminal-law/quizzes        → that course, quizzes tab
//   /criminal-law/briefs         → that course, briefs tab
//
// Default courses already have slug-friendly ids (e.g. "civil-procedure").
// Custom courses get slugified from their name; collisions get "-2", "-3"…

const VALID_TABS        = ['textbook', 'quizzes', 'briefs'];
const DEFAULT_TAB       = 'textbook';
const DEFAULT_COURSE_ID = 'civil-procedure';

function slugify(text) {
  return (text || '')
    .toString()
    .toLowerCase()
    .trim()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Build slug ↔ courseId maps for the given list of courses.
function buildSlugMap(allCourses) {
  const used      = new Set();
  const slugById  = new Map();
  const idBySlug  = new Map();

  (allCourses || []).forEach(c => {
    if (!c || !c.id) return;
    const isCustom = c.id.startsWith('custom-');
    let base = isCustom ? (slugify(c.name) || c.id) : c.id;
    let slug = base, n = 2;
    while (used.has(slug)) { slug = `${base}-${n}`; n++; }
    used.add(slug);
    slugById.set(c.id, slug);
    idBySlug.set(slug,  c.id);
  });

  return { slugById, idBySlug };
}

// Parse the current window.location.pathname into { slug, tab } (either may be null).
function parseLocation() {
  const path = (window.location.pathname || '/').replace(/^\/+|\/+$/g, '');
  if (!path) return { slug: null, tab: null };
  const [slug, tab] = path.split('/');
  return {
    slug: slug || null,
    tab:  VALID_TABS.includes(tab) ? tab : null,
  };
}

// Build a path string from a slug + tab. Omits the tab segment when it's the default.
function buildPath(slug, tab) {
  if (!slug) return '/';
  if (!tab || tab === DEFAULT_TAB) return `/${slug}`;
  return `/${slug}/${tab}`;
}

window.LexRouting = {
  VALID_TABS, DEFAULT_TAB, DEFAULT_COURSE_ID,
  slugify, buildSlugMap, parseLocation, buildPath,
};
