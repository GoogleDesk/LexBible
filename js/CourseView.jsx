// CourseView — tab shell for each course (no reset button; handled by sidebar 3-dot menu)
const { useState: useCVState } = React;

const TABS = [
  { id: 'textbook', label: 'Textbook'    },
  { id: 'quizzes',  label: 'Quizzes'     },
  { id: 'briefs',   label: 'Case Briefs' },
];

const { useRef: useCVRef } = React;
function CourseView({ course, onUpdate, activeTab, onTabChange }) {
  const tab    = activeTab || 'textbook';
  const setTab = onTabChange || (() => {});
  const [headerActions, setHeaderActions] = useCVState({});
  const [pendingCase, setPendingCase] = useCVState(null);

  function navigateToCase(caseName) {
    setPendingCase(caseName);
    setTab('briefs');
  }

  return (
    <div style={cvS.root}>
      <div style={cvS.header}>
        <div style={cvS.headerLeft}>
          <div style={{ display:'flex', alignItems:'center', gap:0, flexWrap:'wrap' }}>
            <h1 style={cvS.title}>{course.name}</h1>
            {tab === 'textbook' && (headerActions.replaceTOC || headerActions.addChapter) && (
              <>
                <span style={cvS.titleDivider} />
                <div style={cvS.headerBtns}>
                  {headerActions.replaceTOC && (
                    <button style={cvS.headerBtnGhost} onClick={headerActions.replaceTOC}>↺ Replace TOC</button>
                  )}
                  {headerActions.addChapter && (
                    <button style={cvS.headerBtnPrimary} onClick={headerActions.addChapter}>+ Add Chapter</button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        <nav style={cvS.tabs}>
          {TABS.map(t => (
            <button
              key={t.id}
              style={{ ...cvS.tab, ...(tab === t.id ? cvS.tabActive : {}) }}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      <div style={cvS.body}>
        {tab === 'textbook' && <TextbookTab   course={course} onUpdate={onUpdate} onRegisterActions={setHeaderActions} onNavigateToCase={navigateToCase} />}
        {tab === 'quizzes'  && <QuizTab       course={course} onUpdate={onUpdate} />}
        {tab === 'briefs'   && <CaseBriefsTab course={course} onUpdate={onUpdate} initialCase={pendingCase} onClearInitialCase={() => setPendingCase(null)} />}
      </div>
    </div>
  );
}

const cvS = {
  root: {
    flex: 1, display: 'flex', flexDirection: 'column',
    height: '100vh', overflow: 'hidden', background: '#F8F6F1',
  },
  header: {
    padding: '22px 36px 0',
    background: '#F8F6F1',
    borderBottom: '1px solid #E2D9CC',
    display: 'flex', alignItems: 'flex-end',
    justifyContent: 'space-between', gap: 32,
  },
  headerLeft: { paddingBottom: 14 },
  titleDivider: { display:'inline-block', width:1, height:18, background:'#D8D0C4', margin:'0 18px 0 16px', verticalAlign:'middle', flexShrink:0 },
  headerBtns:   { display:'flex', alignItems:'center', gap:8 },
  headerBtnGhost:   { padding:'3px 10px', background:'none', border:'1px solid #D8D0C4', borderRadius:4, fontSize:11, color:'#4A3D30', cursor:'pointer', fontWeight:500, whiteSpace:'nowrap' },
  headerBtnPrimary: { padding:'3px 10px', background:'#1A1714', border:'none', borderRadius:4, fontSize:11, color:'#FFFFFF', cursor:'pointer', fontWeight:600, whiteSpace:'nowrap' },
  title: {
    fontFamily: '"Lora", "Lora", Georgia, serif',
    fontSize: 26, fontWeight: 700, color: '#1A1714',
    margin: 0, marginBottom: 5, letterSpacing: '-0.3px',
  },
  meta:  { display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' },
  tabs:  { display: 'flex', gap: 0, alignSelf: 'flex-end' },
  tab: {
    padding: '11px 24px',
    background: 'none', border: 'none',
    borderBottom: '2.5px solid transparent',
    cursor: 'pointer', fontSize: 14,
    color: '#5A4A35', fontWeight: 500,
    transition: 'all .14s',
    fontFamily: '"Lora", Georgia, serif',
  },
  tabActive: {
    color: '#1A1714',
    borderBottom: '2.5px solid #2A6049',
    fontWeight: 700,
  },
  body: { flex: 1, overflow: 'hidden', display: 'flex' },
};

Object.assign(window, { CourseView });
