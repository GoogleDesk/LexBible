// Sidebar — course navigation, custom courses, reset/delete
const { useState: useSidebarState, useEffect: useSidebarEffect } = React;

function Sidebar({ courses, customCourses, activeCourse, onSelect, onResetCourse, onAddCourse, onDeleteCourse, userEmail, onSignOut }) {
  const [hoveredId,    setHoveredId]    = useSidebarState(null);
  const [confirmModal, setConfirmModal] = useSidebarState(null); // { id, mode: 'reset'|'delete' }
  const [confirmText,  setConfirmText]  = useSidebarState('');
  const [apiKeyModal,  setApiKeyModal]  = useSidebarState(false);
  const [apiKeyInput,  setApiKeyInput]  = useSidebarState('');
  const [apiKeySaved,  setApiKeySaved]  = useSidebarState(false);
  const [addingCourse, setAddingCourse] = useSidebarState(false);
  const [newCourse,    setNewCourse]    = useSidebarState('');

  useSidebarEffect(() => {
    if (apiKeyModal) setApiKeyInput(window.LexStore.loadApiKey());
  }, [apiKeyModal]);

  const canConfirm = confirmText.trim().toLowerCase() === (confirmModal?.mode === 'delete' ? 'delete course' : 'reset course');

  function doConfirm() {
    if (!canConfirm || !confirmModal) return;
    if (confirmModal.mode === 'delete') onDeleteCourse(confirmModal.id);
    else onResetCourse(confirmModal.id);
    setConfirmModal(null); setConfirmText('');
  }

  function saveApiKey() {
    window.LexStore.saveApiKey(apiKeyInput);
    setApiKeySaved(true);
    setTimeout(() => { setApiKeySaved(false); setApiKeyModal(false); }, 900);
  }

  function handleAddCourse() {
    const name = newCourse.trim();
    if (!name) return;
    onAddCourse(name);
    setNewCourse(''); setAddingCourse(false);
  }

  function CourseItem({ course, isCustom }) {
    const active  = activeCourse === course.id;
    const hovered = hoveredId === course.id;
    const chCount    = (course.chapters || []).length;
    const totalCases = (course.chapters || []).reduce((s, ch) => s + (ch.cases?.length || 0), 0);
    const briefCount = Object.values(course.briefs || {}).filter(b => b.facts || b.holding).length;

    return (
      <div
        style={{ position: 'relative' }}
        onMouseEnter={() => setHoveredId(course.id)}
        onMouseLeave={() => setHoveredId(null)}
      >
        <button
          onClick={() => onSelect(course.id)}
          style={{ ...sS.item, ...(active ? sS.itemActive : {}) }}
        >
          {active && <span style={sS.activeBar} />}
          <div style={sS.itemText}>
            <div style={{ ...sS.itemName, color: '#1A1714', fontWeight: active ? 700 : 500 }}>
              {course.name}
            </div>
            {(chCount > 0 || briefCount > 0) && (
              <div style={sS.itemMeta}>
                {chCount > 0 && <span>{chCount} ch</span>}
                {chCount > 0 && totalCases > 0 && <span style={{opacity:0.6, fontWeight:700}}>·</span>}
                {totalCases > 0 && <span>{briefCount}/{totalCases} briefed</span>}
              </div>
            )}
          </div>
          {hovered && (
            <button
              style={sS.resetDot}
              onClick={e => { e.stopPropagation(); setConfirmText(''); setConfirmModal({ id: course.id, mode: isCustom ? 'delete' : 'reset' }); }}
            />
          )}
        </button>
      </div>
    );
  }

  return (
    <>
      <aside style={sS.aside}>
        <div style={sS.logo}>
          <div style={sS.logoText}>Lex<span style={sS.logoGold}>Brother</span></div>
          <div style={sS.logoSub}>Law School Companion</div>
        </div>

        <nav style={sS.nav}>
          <div style={sS.navLabel}>Courses</div>

          {/* Default courses */}
          {courses.map(course => <CourseItem key={course.id} course={course} isCustom={false} />)}

          {/* Custom courses */}
          {customCourses.length > 0 && (
            <>
              <div style={sS.separator} />
              {customCourses.map(course => <CourseItem key={course.id} course={course} isCustom={true} />)}
            </>
          )}

          {/* Add course */}
          {addingCourse ? (
            <div style={sS.addCourseForm}>
              <input
                style={sS.addCourseInput}
                placeholder="Course name…"
                value={newCourse}
                onChange={e => setNewCourse(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAddCourse(); if (e.key === 'Escape') { setAddingCourse(false); setNewCourse(''); } }}
                autoFocus
              />
              <div style={{ display:'flex', gap:5 }}>
                <button style={sS.addCourseBtn} onClick={handleAddCourse}>Add</button>
                <button style={sS.addCourseBtnGhost} onClick={() => { setAddingCourse(false); setNewCourse(''); }}>✕</button>
              </div>
            </div>
          ) : (
            <button style={sS.addCourseTrigger} onClick={() => setAddingCourse(true)}>
              + Add Course
            </button>
          )}
        </nav>

        <div style={sS.footer}>
          <div style={sS.footerDot} />
          <span style={sS.footerText}>1L · Spring 2026</span>
          <button style={sS.keyBtn} onClick={() => setApiKeyModal(true)} title="API Key Settings">
            {window.LexStore.loadApiKey() ? '✦' : '⚙'}
          </button>
        </div>

        {userEmail && (
          <div style={sS.account}>
            <span style={sS.accountEmail} title={userEmail}>{userEmail}</span>
            <button style={sS.signOutBtn} onClick={onSignOut} title="Sign out">Sign out</button>
          </div>
        )}
      </aside>

      {/* ── Confirm Modal (reset or delete) ── */}
      {confirmModal && (() => {
        const isDelete  = confirmModal.mode === 'delete';
        const courseObj = [...courses, ...customCourses].find(c => c.id === confirmModal.id);
        const keyword   = isDelete ? 'delete course' : 'reset course';
        return (
          <div style={sS.overlay}>
            <div style={sS.modal}>
              <div style={sS.modalHead}>
                <div style={sS.modalTitle}>{isDelete ? 'Delete' : 'Reset'} {courseObj?.name}?</div>
              </div>
              <div style={sS.modalBody}>
                <p style={sS.modalDesc}>
                  {isDelete
                    ? <>This will <strong>permanently delete</strong> the course and all its data. This cannot be undone.</>
                    : <>This will permanently delete all chapters, quizzes, and case briefs for <strong>{courseObj?.name}</strong>. Cannot be undone.</>}
                </p>
                <p style={sS.modalDesc}>
                  Type <strong style={{ fontFamily:'monospace', color:'#C0392B' }}>{keyword}</strong> to confirm:
                </p>
                <input
                  style={{ ...sS.confirmInput, borderColor: canConfirm ? '#C0392B' : '#DDD6CC' }}
                  value={confirmText}
                  onChange={e => setConfirmText(e.target.value)}
                  placeholder={keyword}
                  autoFocus
                  onKeyDown={e => { if (e.key === 'Enter' && canConfirm) doConfirm(); if (e.key === 'Escape') { setConfirmModal(null); setConfirmText(''); } }}
                />
              </div>
              <div style={sS.modalFoot}>
                <button style={sS.btnGhost} onClick={() => { setConfirmModal(null); setConfirmText(''); }}>Cancel</button>
                <button style={{ ...sS.btnDanger, opacity: canConfirm ? 1 : 0.35 }} disabled={!canConfirm} onClick={doConfirm}>
                  {isDelete ? 'Delete Course' : 'Reset Course'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── API Key Modal ── */}
      {apiKeyModal && (
        <div style={sS.overlay}>
          <div style={sS.modal}>
            <div style={sS.modalHead}>
              <div style={sS.modalTitle}>Anthropic API Key</div>
              <button style={sS.modalX} onClick={() => setApiKeyModal(false)}>✕</button>
            </div>
            <div style={sS.modalBody}>
              <p style={sS.modalDesc}>
                Your API key enables AI-powered TOC cleanup and quiz generation up to 500 questions via Claude Opus. Synced to your account so it's available on all your devices.
              </p>
              <input
                style={sS.confirmInput}
                type="password"
                placeholder="sk-ant-…"
                value={apiKeyInput}
                onChange={e => setApiKeyInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveApiKey()}
                autoFocus
              />
              {apiKeyInput && (
                <button style={{ ...sS.btnGhost, marginTop: 8, fontSize: 11.5, display:'block' }}
                  onClick={() => { setApiKeyInput(''); window.LexStore.saveApiKey(''); }}>
                  Clear saved key
                </button>
              )}
            </div>
            <div style={sS.modalFoot}>
              <button style={sS.btnGhost} onClick={() => setApiKeyModal(false)}>Cancel</button>
              <button style={sS.btnPrimary} onClick={saveApiKey}>{apiKeySaved ? 'Saved ✓' : 'Save Key'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const sS = {
  aside: { width:232, minWidth:232, background:'#EEE8DF', height:'100vh', display:'flex', flexDirection:'column', borderRight:'1px solid #D8D0C0', overflow:'visible', position:'relative', zIndex:10 },
  logo:    { padding:'26px 22px 18px', borderBottom:'1px solid #D8D0C0' },
  logoText:{ fontFamily:'"Lora", "Lora", Georgia, serif', fontSize:24, fontWeight:700, color:'#1A1714', letterSpacing:'-0.3px' },
  logoGold:{ color:'#2A6049' },
  logoSub: { fontSize:11.5, color:'rgba(26,23,20,0.55)', marginTop:3, letterSpacing:'0.8px', textTransform:'uppercase', fontWeight:500 },
  nav:     { flex:1, overflowY:'auto', overflowX:'visible', padding:'10px 0' },
  navLabel:{ fontSize:11.5, fontWeight:700, color:'rgba(26,23,20,0.6)', letterSpacing:'1.8px', textTransform:'uppercase', padding:'8px 22px 4px' },
  separator:{ height:1, background:'rgba(26,23,20,0.1)', margin:'8px 0' },
  item:    { display:'flex', alignItems:'center', width:'100%', padding:'9px 10px 9px 22px', background:'none', border:'none', cursor:'pointer', textAlign:'left', position:'relative', gap:6, transition:'background 0.12s' },
  itemActive:{ background:'rgba(42,96,73,0.12)' },
  activeBar: { position:'absolute', left:0, top:'18%', bottom:'18%', width:3, background:'#2A6049', borderRadius:'0 2px 2px 0' },
  itemText:  { flex:1, minWidth:0 },
  itemName:  { fontSize:14.5, fontWeight:500, lineHeight:1.35 },
  itemMeta:  { display:'flex', gap:8, marginTop:2, fontSize:12.5, color:'rgba(26,23,20,0.75)', fontWeight:500 },
  resetDot:  { width:8, height:8, borderRadius:'50%', background:'#EF4444', border:'none', cursor:'pointer', flexShrink:0, padding:0, opacity:0.85 },
  // Add course
  addCourseForm:   { padding:'8px 14px' },
  addCourseInput:  { width:'100%', boxSizing:'border-box', padding:'6px 9px', borderRadius:5, border:'1px solid rgba(42,96,73,0.3)', background:'rgba(26,23,20,0.07)', color:'#1A1714', fontSize:12.5, outline:'none', marginBottom:6 },
  addCourseBtn:    { flex:1, padding:'5px 10px', background:'#2A6049', color:'#FFFFFF', border:'none', borderRadius:4, fontSize:12, fontWeight:700, cursor:'pointer' },
  addCourseBtnGhost:{ padding:'5px 8px', background:'none', border:'1px solid rgba(26,23,20,0.15)', borderRadius:4, color:'rgba(26,23,20,0.5)', fontSize:12, cursor:'pointer' },
  addCourseTrigger:{ width:'100%', padding:'8px 22px', background:'none', border:'none', color:'#2A6049', fontWeight:600, fontSize:14, cursor:'pointer', textAlign:'left', letterSpacing:'0.3px' },
  // Footer
  footer:    { padding:'12px 16px 12px 22px', borderTop:'1px solid #D8D0C0', display:'flex', alignItems:'center', gap:8 },
  footerDot: { width:9, height:9, borderRadius:'50%', background:'#2A6049', flexShrink:0 },
  footerText:{ fontSize:11, color:'rgba(26,23,20,0.7)', flex:1, fontWeight:500 },
  keyBtn:    { background:'none', border:'none', fontSize:16, cursor:'pointer', padding:2, color:'#1A1714', opacity:0.8, fontFamily:'system-ui,sans-serif' },
  account:   { padding:'8px 16px 12px 22px', borderTop:'1px solid #D8D0C0', display:'flex', alignItems:'center', gap:8 },
  accountEmail:{ flex:1, minWidth:0, fontSize:11, color:'rgba(26,23,20,0.6)', fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  signOutBtn:{ background:'none', border:'1px solid rgba(26,23,20,0.15)', borderRadius:4, padding:'3px 8px', fontSize:11, color:'rgba(26,23,20,0.7)', cursor:'pointer', fontFamily:'inherit' },
  // Modals
  overlay:   { position:'fixed', inset:0, background:'rgba(26,39,68,.55)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:2000, backdropFilter:'blur(2px)' },
  modal:     { background:'#FFFFFF', borderRadius:12, width:'90%', maxWidth:440, boxShadow:'0 24px 64px rgba(26,39,68,.3)', overflow:'hidden' },
  modalHead: { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'17px 22px', borderBottom:'1px solid #E2D9CC', background:'#F5EFE6' },
  modalTitle:{ fontFamily:'"Lora", "Lora", Georgia, serif', fontSize:16.5, fontWeight:700, color:'#1A1714' },
  modalX:    { background:'none', border:'none', fontSize:16, color:'#8B7355', cursor:'pointer' },
  modalBody: { padding:'20px 22px 12px' },
  modalDesc: { fontSize:13.5, color:'#3A3020', lineHeight:1.65, marginBottom:12 },
  modalFoot: { padding:'14px 22px', borderTop:'1px solid #E2D9CC', display:'flex', gap:8, justifyContent:'flex-end' },
  confirmInput:{ width:'100%', boxSizing:'border-box', padding:'9px 12px', borderRadius:6, border:'1.5px solid', fontSize:14, fontFamily:'monospace', background:'white', outline:'none', transition:'border-color .2s' },
  btnPrimary:{ padding:'9px 20px', background:'#1A1714', color:'#FFFFFF', border:'none', borderRadius:6, fontSize:13, fontWeight:600, cursor:'pointer' },
  btnDanger: { padding:'9px 20px', background:'#C0392B', color:'white', border:'none', borderRadius:6, fontSize:13, fontWeight:600, cursor:'pointer', transition:'opacity .2s' },
  btnGhost:  { padding:'9px 20px', background:'none', color:'#6B5F4A', border:'1px solid #DDD6CC', borderRadius:6, fontSize:13, cursor:'pointer' },
};

Object.assign(window, { Sidebar });
