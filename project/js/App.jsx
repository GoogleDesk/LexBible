// App — root component, state management, tweaks
const { useState: useAppState, useEffect: useAppEffect } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{"sidebarWidth":"232","accentColor":"#2A6049","bodyFont":"Lora"}/*EDITMODE-END*/;

function App() {
  const [data,         setData]         = useAppState(() => window.LexStore.loadData());
  const [activeCourse, setActiveCourse] = useAppState('civil-procedure');
  const [tweaksOn,     setTweaksOn]     = useAppState(false);
  const [tweaks,       setTweaks]       = useAppState(TWEAK_DEFAULTS);

  useAppEffect(() => { window.LexStore.saveData(data); }, [data]);

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
    if (activeCourse === courseId) setActiveCourse('civil-procedure');
  }

  function updateTweak(key, val) {
    const next = { ...tweaks, [key]: val };
    setTweaks(next);
    window.parent.postMessage({ type: '__edit_mode_set_keys', edits: next }, '*');
  }

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
        onSelect={setActiveCourse}
        onResetCourse={resetCourse}
        onAddCourse={addCourse}
        onDeleteCourse={deleteCourse}
      />

      {activeCourseData && (
        <CourseView
          course={activeCourseData}
          onUpdate={updates => updateCourse(activeCourse, updates)}
        />
      )}

      {tweaksOn && (
        <TweaksPanel tweaks={tweaks} onChange={updateTweak} onClose={() => setTweaksOn(false)} />
      )}
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
