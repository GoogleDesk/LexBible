// App — root component, state management, tweaks
const { useState: useAppState, useEffect: useAppEffect } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{"sidebarWidth":"232","accentColor":"#2A6049","bodyFont":"Lora"}/*EDITMODE-END*/;

// ── Supabase singleton (created once per page load) ──────────────────────────
function getSupabaseClient() {
  if (window.__lexSupabase) return window.__lexSupabase;
  const cfg = window.LEXBROTHER_CONFIG || {};
  if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.startsWith('PASTE_') ||
      !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_ANON_KEY.startsWith('PASTE_')) {
    return null;
  }
  if (!window.supabase || !window.supabase.createClient) return null;
  window.__lexSupabase = window.supabase.createClient(
    cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY,
    { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
  );
  return window.__lexSupabase;
}

function App() {
  const supabase = getSupabaseClient();

  const [session,      setSession]      = useAppState(null);
  const [authReady,    setAuthReady]    = useAppState(false); // true after first getSession resolves
  const [dataReady,    setDataReady]    = useAppState(false); // true after initCloud resolves
  const [initError,    setInitError]    = useAppState('');
  const [data,         setData]         = useAppState(null);
  const [activeCourse, setActiveCourse] = useAppState(window.LexRouting.DEFAULT_COURSE_ID);
  const [activeTab,    setActiveTab]    = useAppState(window.LexRouting.DEFAULT_TAB);
  const [tweaksOn,     setTweaksOn]     = useAppState(false);
  const [tweaks,       setTweaks]       = useAppState(TWEAK_DEFAULTS);

  // Subscribe to Supabase auth state
  useAppEffect(() => {
    if (!supabase) { setAuthReady(true); return; }
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => sub.subscription.unsubscribe();
  }, [supabase]);

  // When we have a session, initialize cloud sync and load the user's data
  useAppEffect(() => {
    if (!supabase || !session) { setDataReady(false); setData(null); return; }
    let cancelled = false;
    setDataReady(false); setInitError('');
    (async () => {
      try {
        await window.LexStore.initCloud(supabase, session.user.id);
        if (cancelled) return;
        setData(window.LexStore.loadData());
        setDataReady(true);
      } catch (err) {
        if (cancelled) return;
        setInitError(err.message || 'Could not load your data.');
      }
    })();
    return () => { cancelled = true; };
  }, [supabase, session?.user?.id]);

  // Persist changes back to the cloud whenever local state changes (debounced in storage.js)
  useAppEffect(() => {
    if (!dataReady || !data) return;
    window.LexStore.saveData(data);
  }, [data, dataReady]);

  // Best-effort flush any pending save when the tab closes
  useAppEffect(() => {
    const onUnload = () => { window.LexStore.flushPendingSave?.(); };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  // ── URL routing: hydrate state from URL once data loads, then keep URL in sync
  useAppEffect(() => {
    if (!dataReady || !data) return;
    const all = [
      ...window.LexStore.DEFAULT_COURSES,
      ...(data.customCourses || []),
    ];
    const { idBySlug } = window.LexRouting.buildSlugMap(all);
    const parsed = window.LexRouting.parseLocation();
    const courseId = parsed.slug && idBySlug.get(parsed.slug);
    if (courseId) setActiveCourse(courseId);
    if (parsed.tab) setActiveTab(parsed.tab);
    // If the URL pointed to a missing course, normalize it without adding a history entry
    if (parsed.slug && !courseId) {
      const slug = window.LexRouting.buildSlugMap(all).slugById.get(window.LexRouting.DEFAULT_COURSE_ID);
      window.history.replaceState(null, '', window.LexRouting.buildPath(slug, window.LexRouting.DEFAULT_TAB));
    }
  }, [dataReady]); // intentional: hydrate once when data first becomes ready

  // Push state→URL whenever the user navigates inside the app
  useAppEffect(() => {
    if (!dataReady || !data || !activeCourse) return;
    const all = [
      ...window.LexStore.DEFAULT_COURSES,
      ...(data.customCourses || []),
    ];
    const { slugById } = window.LexRouting.buildSlugMap(all);
    const slug = slugById.get(activeCourse);
    if (!slug) return;
    const newPath = window.LexRouting.buildPath(slug, activeTab);
    if (window.location.pathname !== newPath) {
      window.history.pushState(null, '', newPath);
    }
  }, [activeCourse, activeTab, dataReady, data]);

  // Browser back/forward
  useAppEffect(() => {
    if (!dataReady || !data) return;
    function onPop() {
      const all = [
        ...window.LexStore.DEFAULT_COURSES,
        ...(data.customCourses || []),
      ];
      const { idBySlug } = window.LexRouting.buildSlugMap(all);
      const parsed = window.LexRouting.parseLocation();
      const courseId = (parsed.slug && idBySlug.get(parsed.slug)) || window.LexRouting.DEFAULT_COURSE_ID;
      setActiveCourse(courseId);
      setActiveTab(parsed.tab || window.LexRouting.DEFAULT_TAB);
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [dataReady, data]);

  useAppEffect(() => {
    const handler = e => {
      if (e.data?.type === '__activate_edit_mode')   setTweaksOn(true);
      if (e.data?.type === '__deactivate_edit_mode') setTweaksOn(false);
    };
    window.addEventListener('message', handler);
    window.parent.postMessage({ type: '__edit_mode_available' }, '*');
    return () => window.removeEventListener('message', handler);
  }, []);

  function updateCourse(courseId, updates) {
    setData(prev => ({
      ...prev,
      courses: { ...prev.courses, [courseId]: { ...prev.courses[courseId], ...updates } },
    }));
  }

  function resetCourse(courseId) {
    const course = [...window.LexStore.DEFAULT_COURSES, ...(data.customCourses || [])].find(c => c.id === courseId);
    if (!course) return;
    setData(prev => ({
      ...prev,
      courses: { ...prev.courses, [courseId]: { ...course, chapters: [], quizzes: {}, briefs: {} } },
    }));
  }

  function addCourse(name) {
    const abbr = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 6);
    const id   = 'custom-' + window.LexStore.genId();
    const newCourse = { id, name, abbr, isCustom: true };
    setData(prev => ({
      ...prev,
      customCourses: [...(prev.customCourses || []), newCourse],
      courses: { ...prev.courses, [id]: { ...newCourse, chapters: [], quizzes: {}, briefs: {} } },
    }));
    setActiveCourse(id);
  }

  function deleteCourse(courseId) {
    setData(prev => {
      const newCourses = { ...prev.courses };
      delete newCourses[courseId];
      return {
        ...prev,
        customCourses: (prev.customCourses || []).filter(c => c.id !== courseId),
        courses: newCourses,
      };
    });
    if (activeCourse === courseId) {
      setActiveCourse(window.LexRouting.DEFAULT_COURSE_ID);
      setActiveTab(window.LexRouting.DEFAULT_TAB);
    }
  }

  function updateTweak(key, val) {
    const next = { ...tweaks, [key]: val };
    setTweaks(next);
    window.parent.postMessage({ type: '__edit_mode_set_keys', edits: next }, '*');
  }

  async function signOut() {
    try { await window.LexStore.flushPendingSave?.(); } catch(e) {}
    window.LexStore.clearCloud?.();
    if (supabase) await supabase.auth.signOut();
    setData(null); setDataReady(false); setSession(null);
  }

  // ── Render gates ────────────────────────────────────────────────────────────
  if (!supabase)   return <ConfigMissingScreen />;
  if (!authReady)  return <LoadingScreen label="Starting up…" />;
  if (!session)    return <AuthScreen supabase={supabase} />;
  if (initError)   return <ErrorScreen message={initError} onRetry={() => window.location.reload()} />;
  if (!dataReady || !data) return <LoadingScreen label="Loading your data…" />;

  const defaultCourses = window.LexStore.DEFAULT_COURSES.map(c => ({
    ...c, ...(data.courses[c.id] || {}),
  }));

  const customCourses = (data.customCourses || []).map(c => ({
    ...c, ...(data.courses[c.id] || {}),
  }));

  const activeCourseData = data.courses[activeCourse];

  return (
    <div style={{ display:'flex', height:'100vh', overflow:'hidden', fontFamily: tweaks.bodyFont + ',serif' }}>
      <Sidebar
        courses={defaultCourses}
        customCourses={customCourses}
        activeCourse={activeCourse}
        onSelect={id => { setActiveCourse(id); setActiveTab(window.LexRouting.DEFAULT_TAB); }}
        onResetCourse={resetCourse}
        onAddCourse={addCourse}
        onDeleteCourse={deleteCourse}
        userEmail={session.user.email}
        onSignOut={signOut}
      />

      {activeCourseData && (
        <CourseView
          course={activeCourseData}
          onUpdate={updates => updateCourse(activeCourse, updates)}
          activeTab={activeTab}
          onTabChange={setActiveTab}
        />
      )}

      {tweaksOn && (
        <TweaksPanel tweaks={tweaks} onChange={updateTweak} onClose={() => setTweaksOn(false)} />
      )}
    </div>
  );
}

// ── Small gate screens ────────────────────────────────────────────────────────
function LoadingScreen({ label }) {
  return (
    <div style={{ position:'fixed', inset:0, display:'flex', alignItems:'center', justifyContent:'center', background:'#F8F6F1', fontFamily:'"Lora", Georgia, serif', color:'#6B5B47', fontSize:14 }}>
      <div style={{ textAlign:'center' }}>
        <div style={{ width:24, height:24, border:'2.5px solid #E2D9CC', borderTopColor:'#2A6049', borderRadius:'50%', margin:'0 auto 14px', animation:'spin 0.8s linear infinite' }} />
        {label}
      </div>
    </div>
  );
}

function ErrorScreen({ message, onRetry }) {
  return (
    <div style={{ position:'fixed', inset:0, display:'flex', alignItems:'center', justifyContent:'center', background:'#F8F6F1', fontFamily:'"Lora", Georgia, serif', padding:20 }}>
      <div style={{ background:'white', border:'1px solid #E2D9CC', borderRadius:12, padding:'28px 30px', maxWidth:440, width:'100%', boxShadow:'0 8px 32px rgba(26,39,68,.08)' }}>
        <h2 style={{ fontFamily:'"Playfair Display", Georgia, serif', fontSize:19, color:'#9B2335', margin:'0 0 10px' }}>Could not load your data</h2>
        <p style={{ fontSize:14, color:'#6B5B47', lineHeight:1.55, margin:'0 0 18px' }}>{message}</p>
        <button onClick={onRetry} style={{ padding:'9px 16px', fontSize:13, fontWeight:600, background:'#2A6049', color:'white', border:'none', borderRadius:5, cursor:'pointer', fontFamily:'inherit' }}>Retry</button>
      </div>
    </div>
  );
}

// ── Tweaks Panel ──────────────────────────────────────────────────────────────
function TweaksPanel({ tweaks, onChange, onClose }) {
  const accents = [
    { label: 'Forest',  value: '#2A6049' },
    { label: 'Teal',    value: '#0D7A7A' },
    { label: 'Crimson', value: '#9B2335' },
    { label: 'Slate',   value: '#4A5568' },
  ];
  const fonts = [
    { label: 'Lora',            value: 'Lora'            },
    { label: 'Georgia',         value: 'Georgia'         },
    { label: 'Times New Roman', value: 'Times New Roman' },
  ];
  return (
    <div style={twS.panel}>
      <div style={twS.head}>
        <span style={twS.title}>Tweaks</span>
        <button style={twS.close} onClick={onClose}>✕</button>
      </div>
      <div style={twS.section}>
        <div style={twS.sectionLabel}>Accent Color</div>
        <div style={twS.swatches}>
          {accents.map(a => (
            <button key={a.value} title={a.label} onClick={() => onChange('accentColor', a.value)}
              style={{ ...twS.swatch, background: a.value, outline: tweaks.accentColor === a.value ? `2px solid ${a.value}` : 'none', outlineOffset: 2 }} />
          ))}
        </div>
      </div>
      <div style={twS.section}>
        <div style={twS.sectionLabel}>Body Font</div>
        {fonts.map(f => (
          <button key={f.value}
            style={{ ...twS.fontOpt, ...(tweaks.bodyFont === f.value ? twS.fontOptActive : {}), fontFamily: f.value }}
            onClick={() => onChange('bodyFont', f.value)}>{f.label}</button>
        ))}
      </div>
      <div style={twS.footer}>Changes saved automatically</div>
    </div>
  );
}

const twS = {
  panel:  { position:'fixed', bottom:20, right:20, background:'white', border:'1px solid #E2D9CC', borderRadius:10, padding:18, width:210, boxShadow:'0 8px 32px rgba(26,39,68,.15)', zIndex:9999 },
  head:   { display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 },
  title:  { fontFamily:'"Lora", "Lora", Georgia, serif', fontWeight:700, color:'#1A1714', fontSize:15 },
  close:  { background:'none', border:'none', cursor:'pointer', color:'#8B7355', fontSize:15 },
  section:{ marginBottom:14 },
  sectionLabel:{ fontSize:10, fontWeight:700, color:'#2A6049', textTransform:'uppercase', letterSpacing:'1px', marginBottom:8 },
  swatches:{ display:'flex', gap:7 },
  swatch: { width:24, height:24, borderRadius:'50%', border:'none', cursor:'pointer', transition:'outline .1s' },
  fontOpt:{ display:'block', width:'100%', padding:'6px 10px', background:'none', border:'1px solid #E2D9CC', borderRadius:5, fontSize:13, cursor:'pointer', marginBottom:5, textAlign:'left' },
  fontOptActive:{ background:'#1A1714', color:'#FFFFFF', borderColor:'#1A1714' },
  footer: { fontSize:10.5, color:'#B8A870', borderTop:'1px solid #F5EFE6', paddingTop:10, marginTop:4 },
};

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
