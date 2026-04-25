
// Normalize chapter title format: "Chapter N — Title" → "Chapter N: Title"
function fmtTitle(t) {
  return (t || '').replace(/\s+[\u2014\u2013\-]{1,2}\s+/, ': ');
}
// QuizTab — full quiz system v3: navigation, progress save, multi-quiz per chapter,
// wrong tracker, stats, flags, miss report, question type report, delete quizzes
const { useState: useQState, useRef: useQRef, useEffect: useQEffect } = React;

const QUIZ_TYPES = [
  { value: 'fact',        label: 'Fact-Based',  desc: 'Rules, holdings, definitions'  },
  { value: 'application', label: 'Application', desc: 'Hypos & bar-exam scenarios'    },
  { value: 'mix',         label: 'Mixed',        desc: 'Both types equally'            },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
const qKey = q => (q.question || '').slice(0, 100).trim();
const computeScore = (questions, answers) =>
  Object.entries(answers).filter(([i, a]) => a === questions[+i]?.correct).length;

function QuizTab({ course, onUpdate }) {
  const [selChapter, setSelChapter] = useQState(null);
  const [chDropOpen, setChDropOpen] = useQState(false);
  const [settings,   setSettings]   = useQState({ count: 20, type: 'mix', focusArea: '' });
  const [genState,   setGenState]   = useQState(null); // { total, done, error }
  const [genReport,  setGenReport]  = useQState(null); // { setId, chId, factCount, appCount }
  // Active quiz session
  const [session,    setSession]    = useQState(null);
  // { chId, setId, questions, idx, answers:{}, flaggedKeys:[], sessionStart }
  const [collapsedBanks, setCollapsedBanks] = useQState(new Set());
  const cancelRef = useQRef(false);

  // ── Keyboard shortcuts (must stay above any early return to keep hook order stable) ──
  useQEffect(() => {
    if (!session || session.done) return;
    function handleKey(e) {
      const tag = e.target?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      if (e.key === 'ArrowLeft')  { e.preventDefault(); navigate(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); navigate(1);  }
      if (e.key === 'f' || e.key === 'F') toggleFlag();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [session]);

  function toggleBank(chId) {
    setCollapsedBanks(prev => {
      const next = new Set(prev);
      if (next.has(chId)) next.delete(chId); else next.add(chId);
      return next;
    });
  }

  const chapters  = (course.chapters || []).filter(c => c.content?.trim());
  const quizData  = course.quizzes || {}; // { [chId]: { sets: [...] } }
  const hasApiKey = !!window.LexStore.loadApiKey();
  const maxQ      = hasApiKey ? 500 : 30;

  // ── Persist session progress to store ────────────────────────────────────
  function persistProgress(sess) {
    if (!sess?.chId || !sess?.setId) return;
    const { chId, setId, idx, answers, flaggedKeys } = sess;
    const sets = (quizData[chId]?.sets || []).map(s =>
      s.id === setId ? { ...s, progress: { idx, answers, flaggedKeys, score: computeScore(sess.questions, answers) } } : s
    );
    onUpdate({ quizzes: { ...quizData, [chId]: { ...quizData[chId], sets } } });
  }

  // ── Start a quiz session ──────────────────────────────────────────────────
  function startSession(chId, setId) {
    const set = (quizData[chId]?.sets || []).find(s => s.id === setId);
    if (!set?.questions?.length) return;
    const saved = set.progress;
    setSession({
      chId, setId,
      questions:    set.questions,
      idx:          saved?.idx          || 0,
      answers:      saved?.answers      || {},
      flaggedKeys:  saved?.flaggedKeys  || [],
      sessionStart: Date.now(),
      done: false,
    });
    setGenReport(null);
  }

  function openReview(chId, setId) {
    const set = (quizData[chId]?.sets || []).find(s => s.id === setId);
    if (!set?.questions?.length) return;
    const savedAnswers = set.progress?.answers || {};
    setSession({
      chId, setId,
      questions:   set.questions,
      idx:         0,
      answers:     savedAnswers,
      flaggedKeys: set.progress?.flaggedKeys || [],
      sessionStart: Date.now(),
      isReview:    'completed',
      done:        false,
    });
    setGenReport(null);
  }

  // ── Answer / navigation ───────────────────────────────────────────────────
  function answer(choice) {
    if (!session) return;
    const { idx, answers } = session;
    // Toggle: clicking the already-selected choice deselects it
    const current = answers[idx];
    const newAnswers = { ...answers };
    if (current === choice) delete newAnswers[idx];
    else newAnswers[idx] = choice;
    const updated = { ...session, answers: newAnswers };
    setSession(updated);
    persistProgress(updated);
  }

  function navigate(delta) {
    if (!session) return;
    const newIdx = Math.max(0, Math.min(session.questions.length - 1, session.idx + delta));
    const updated = { ...session, idx: newIdx };
    setSession(updated);
    persistProgress(updated);
  }

  function jumpTo(idx) {
    if (!session) return;
    const updated = { ...session, idx };
    setSession(updated);
    persistProgress(updated);
  }

  function toggleFlag() {
    const q = session?.questions[session.idx];
    if (!q) return;
    const key = qKey(q);
    const flags = session.flaggedKeys;
    const updated = { ...session, flaggedKeys: flags.includes(key) ? flags.filter(k => k !== key) : [...flags, key] };
    setSession(updated);
    persistProgress(updated);
  }

  function finishQuiz() {
    if (!session) return;
    const { chId, setId, questions, answers, flaggedKeys, sessionStart, isReview } = session;
    const score      = computeScore(questions, answers);
    const wrongKeys  = questions.map((q, i) => answers[i] !== q.correct ? qKey(q) : null).filter(Boolean);
    const durationMs = Date.now() - sessionStart;
    const type       = (quizData[chId]?.sets || []).find(s => s.id === setId)?.settings?.type || 'mix';

    // Build updated set
    const sets = (quizData[chId]?.sets || []).map(s => {
      if (s.id !== setId) return s;
      const wrongBank = { ...s.wrongBank };

      // Update wrong bank
      wrongKeys.forEach(key => {
        const q = questions.find(q => qKey(q) === key);
        if (!q) return;
        wrongBank[key] = { ...q, wrongCount: (wrongBank[key]?.wrongCount || 0) + 1, rightStreak: 0, lastAttempted: Date.now() };
      });

      // Update right streaks / retire
      questions.forEach(q => {
        const k = qKey(q);
        if (wrongKeys.includes(k) || !wrongBank[k]) return;
        const streak = (wrongBank[k].rightStreak || 0) + 1;
        if (streak >= 2) delete wrongBank[k];
        else wrongBank[k] = { ...wrongBank[k], rightStreak: streak };
      });

      const flagged  = [...new Set([...(s.flagged || []), ...flaggedKeys])];
      const sessions = [...(s.sessions || []), { date: Date.now(), score, total: questions.length, type, durationMs }];

      return { ...s, wrongBank, flagged, sessions, progress: { idx: session.idx, answers, flaggedKeys, score } };
    });

    onUpdate({ quizzes: { ...quizData, [chId]: { ...quizData[chId], sets } } });
    setSession(prev => ({ ...prev, done: true }));
  }

  function startWrongReview(chId, setId) {
    const set = (quizData[chId]?.sets || []).find(s => s.id === setId);
    const qs  = set?.wrongBank ? Object.values(set.wrongBank) : [];
    if (!qs.length) return;
    const tempId = 'review-' + setId;
    setSession({ chId, setId: tempId, questions: qs, idx: 0, answers: {}, flaggedKeys: [], sessionStart: Date.now(), done: false, isReview: 'wrong' });
  }

  function startFlaggedReview(chId, setId) {
    const set  = (quizData[chId]?.sets || []).find(s => s.id === setId);
    const keys = set?.flagged || [];
    const qs   = (set?.questions || []).filter(q => keys.includes(qKey(q)));
    if (!qs.length) return;
    const tempId = 'flagged-' + setId;
    setSession({ chId, setId: tempId, questions: qs, idx: 0, answers: {}, flaggedKeys: [], sessionStart: Date.now(), done: false, isReview: 'flagged' });
  }

  // ── Delete a quiz set ─────────────────────────────────────────────────────
  function deleteSet(chId, setId) {
    if (!confirm('Delete this quiz? This cannot be undone.')) return;
    const sets = (quizData[chId]?.sets || []).filter(s => s.id !== setId);
    const newData = { ...quizData };
    if (sets.length === 0) delete newData[chId];
    else newData[chId] = { ...newData[chId], sets };
    onUpdate({ quizzes: newData });
  }

  // ── Generation ────────────────────────────────────────────────────────────
  async function generate() {
    if (!selChapter) return;
    const ch      = course.chapters.find(c => c.id === selChapter);
    const count   = Math.min(settings.count, maxQ);
    const BATCH   = hasApiKey ? 20 : 8;
    const batches = Math.ceil(count / BATCH);

    // All questions from existing sets on this chapter (for overlap avoidance)
    const existingQs = (quizData[selChapter]?.sets || []).flatMap(s => s.questions || []);

    cancelRef.current = false;
    setGenState({ total: count, done: 0, error: null });
    const newQs = [];

    try {
      for (let i = 0; i < batches; i++) {
        if (cancelRef.current) break;
        const batchSize = Math.min(BATCH, count - newQs.length);
        const batch = await window.LexStore.generateQuizBatch({
          content: ch.content, batchIndex: i, totalBatches: batches, batchSize,
          questionType: settings.type, chapterTitle: ch.title,
          previousQuestions: newQs,
          allChapterQuestions: existingQs,
          focusArea: settings.focusArea || '',
        });
        newQs.push(...batch);
        setGenState({ total: count, done: Math.min(newQs.length, count), error: null });
        if (i < batches - 1 && !cancelRef.current)
          await new Promise(r => setTimeout(r, hasApiKey ? 400 : 900));
      }

      if (cancelRef.current && newQs.length < 2) { setGenState(null); return; }

      const final = newQs.slice(0, count);
      const factCount = final.filter(q => q.qtype === 'fact').length;
      const appCount  = final.filter(q => q.qtype === 'application').length;

      // Build new set label
      const existingSets = quizData[selChapter]?.sets || [];
      const label = `Quiz ${existingSets.length + 1}`;
      const newSetId = window.LexStore.genId();

      const newSet = {
        id: newSetId, label,
        questions: final,
        settings: { count: final.length, type: settings.type },
        generatedAt: Date.now(),
        summary: { factCount, appCount, total: final.length },
        progress: null,
        wrongBank: {}, flagged: [], sessions: [],
      };

      const updatedSets = [...existingSets, newSet];
      onUpdate({
        quizzes: {
          ...quizData,
          [selChapter]: { ...(quizData[selChapter] || {}), sets: updatedSets },
        },
      });

      setGenState(null);
      setGenReport({ setId: newSetId, chId: selChapter, factCount, appCount, total: final.length, label });
    } catch (err) {
      setGenState(prev => ({ ...prev, error: err.message || 'Generation failed.' }));
    }
  }

  // ── GENERATING overlay ────────────────────────────────────────────────────
  if (genState) {
    const pct = genState.total > 0 ? Math.round(genState.done / genState.total * 100) : 0;
    return (
      <div style={{ ...qS.wrap, display:'flex', alignItems:'center', justifyContent:'center' }}>
        <div style={qS.genCard}>
          <div style={qS.genSpinner} />
          <div style={qS.genTitle}>Generating Questions…</div>
          <div style={qS.genSub}>{genState.done} of {genState.total}</div>
          <div style={qS.progressTrack}><div style={{ ...qS.progressFill, width: `${pct}%` }} /></div>
          <div style={qS.genPct}>{pct}%</div>
          {genState.error && <div style={qS.errorBox}>{genState.error}</div>}
          <button style={qS.btnSecondary} onClick={() => { cancelRef.current = true; setGenState(null); }}>
            {genState.error ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    );
  }

  // ── SCORE screen ──────────────────────────────────────────────────────────
  if (session?.done) {
    const { chId, setId, questions, answers, flaggedKeys, isReview } = session;
    const score      = computeScore(questions, answers);
    const total      = questions.length;
    const pct        = Math.round(score / total * 100);
    const grade      = pct >= 90 ? 'Excellent' : pct >= 75 ? 'Good' : pct >= 60 ? 'Passing' : 'Keep Studying';
    const gCol       = pct >= 75 ? '#4A7C59' : pct >= 60 ? '#2A6049' : '#C0392B';
    const wrongKeys  = questions.map((q, i) => answers[i] !== q.correct ? qKey(q) : null).filter(Boolean);
    const set        = (quizData[chId]?.sets || []).find(s => s.id === setId);
    const wrongCount = Object.keys(set?.wrongBank || {}).length;
    const factRight  = questions.filter((q, i) => q.qtype === 'fact'        && answers[i] === q.correct).length;
    const factTotal  = questions.filter(q => q.qtype === 'fact').length;
    const appRight   = questions.filter((q, i) => q.qtype === 'application' && answers[i] === q.correct).length;
    const appTotal   = questions.filter(q => q.qtype === 'application').length;

    return (
      <div style={qS.wrap}>
        <div style={qS.scoreCard}>
          <div style={qS.scoreSeal}>⚖</div>
          <div style={qS.scoreHeading}>{isReview === 'wrong' ? 'Review Complete' : isReview === 'flagged' ? 'Flagged Review' : 'Quiz Complete'}</div>
          <div style={qS.scoreBig}>{score}<span style={qS.scoreOf}>/{total}</span></div>
          <div style={{ ...qS.scoreGrade, color: gCol }}>{grade} — {pct}%</div>

          {(factTotal > 0 || appTotal > 0) && (
            <div style={qS.scoreBreakdown}>
              {factTotal > 0 && <div style={qS.breakdownRow}><span style={qS.breakdownLabel}>Fact-Based</span><span style={qS.breakdownVal}>{factRight}/{factTotal} ({Math.round(factRight/factTotal*100)}%)</span></div>}
              {appTotal  > 0 && <div style={qS.breakdownRow}><span style={qS.breakdownLabel}>Application</span><span style={qS.breakdownVal}>{appRight}/{appTotal} ({Math.round(appRight/appTotal*100)}%)</span></div>}
            </div>
          )}

          {wrongKeys.length > 0 && (
            <div style={qS.scoreSection}>
              <div style={qS.scoreSectionLabel}>Added to Wrong Bank ({wrongKeys.length})</div>
              {wrongKeys.slice(0, 3).map((k, i) => <div key={i} style={qS.wrongPreview}>{k.slice(0, 75)}{k.length > 75 ? '…' : ''}</div>)}
              {wrongKeys.length > 3 && <div style={qS.wrongPreview}>…and {wrongKeys.length - 3} more</div>}
            </div>
          )}

          <div style={qS.scoreActions}>
            {!isReview && <button style={qS.btnPrimary} onClick={() => startSession(chId, setId)}>Retake</button>}
            {wrongCount > 0 && !isReview && (
              <button style={{ ...qS.btnSecondary, color:'#C0392B', borderColor:'#EBBAB4' }} onClick={() => startWrongReview(chId, setId)}>
                ✗ Review Wrong ({wrongCount})
              </button>
            )}
            <button style={qS.btnGhost} onClick={() => setSession(null)}>← Back</button>
          </div>
        </div>
      </div>
    );
  }

  // ── QUESTION screen ───────────────────────────────────────────────────────
  if (session) {
    const { questions, idx, answers, flaggedKeys, isReview } = session;
    const q          = questions[idx];
    const answered   = answers[idx];
    const hasAnswered = answered !== undefined;
    const isReadOnly  = isReview === 'completed';
    const isFlagged  = flaggedKeys.includes(qKey(q));
    const score      = computeScore(questions, answers);
    const modeLabel  = isReview === 'wrong' ? 'Wrong Answer Review' : isReview === 'flagged' ? 'Flagged Review' : isReview === 'completed' ? 'Review Mode' : null;
    const totalAns   = Object.keys(answers).length;
    const allDone    = totalAns >= questions.length;

    return (
      <div style={qS.wrap}>
        {/* Top bar */}
        <div style={qS.quizBar}>
          <button style={qS.backLink} onClick={() => setSession(null)}>← Back</button>
          <div style={qS.quizProgress}>
            <div style={qS.progressTrack}><div style={{ ...qS.progressFill, width: `${(totalAns / questions.length) * 100}%` }} /></div>
            <span style={qS.progressLabel}>{totalAns} / {questions.length} answered</span>
          </div>
          <div style={qS.scorePill}><span style={{fontWeight:700}}>{score}</span><span style={{opacity:0.75,fontWeight:500,fontSize:12}}> / {questions.length}</span></div>
        </div>

        {/* Two-column: question card left, nav pane right */}
        <div style={{ display:'flex', gap:16, alignItems:'flex-start' }}>
        <div style={{ flex:1, minWidth:0, display:'flex', flexDirection:'column', gap:10 }}>
        <div style={{ ...qS.qCard, marginBottom:0 }}>
          <div style={qS.qHeader}>
            <div style={qS.qMeta}>
              <button style={qS.navBtnSm} onClick={() => navigate(-1)} disabled={idx === 0}>← Prev</button>
              <span style={qS.qNum}>Q{idx + 1} <span style={{fontWeight:400,opacity:0.5}}>of {questions.length}</span></span>
              {q.qtype && <span style={{ ...qS.qtypePill, background: q.qtype === 'application' ? '#EFF6FF' : '#FDF3E0', color: q.qtype === 'application' ? '#1E40AF' : '#8B5E00' }}>{q.qtype === 'application' ? 'Application' : 'Fact-Based'}</span>}
            </div>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              {modeLabel && <span style={qS.modePill}>{modeLabel}</span>}
              <button style={{ ...qS.flagBtn, ...(isFlagged ? qS.flagBtnActive : {}) }} onClick={toggleFlag} title={isFlagged ? 'Unflag' : 'Flag question'}>
                🔖
              </button>
              {allDone && !isReadOnly
                ? <button style={{...qS.navBtnSmPrimary}} onClick={finishQuiz}>Done ✓</button>
                : !isReadOnly && <button style={qS.navBtnSm} onClick={() => navigate(1)} disabled={idx === questions.length - 1}>Next →</button>
              }
              {isReadOnly && idx < questions.length - 1 && <button style={qS.navBtnSm} onClick={() => navigate(1)}>Next →</button>}
            </div>
          </div>

          <div style={qS.qText}>{q.question}</div>

          <div style={qS.choices} key={`choices-${idx}`}>
            {['A','B','C','D'].map(letter => {
              const isCorrect  = letter === q.correct;
              const isSelected = answered === letter;
              let st = qS.choice;
              if (hasAnswered) {
                if (isSelected && isCorrect)  st = { ...qS.choice, ...qS.choiceRight };
                else if (isSelected)          st = { ...qS.choice, ...qS.choiceWrong };
                // After a wrong answer, also reveal the correct choice
                else if (isCorrect && answers[idx] !== q.correct) st = { ...qS.choice, ...qS.choiceRight };
                else                          st = { ...qS.choice, opacity: 0.42 };
              }
              return (
                <button key={letter} style={st} onClick={() => answer(letter)}>
                  <span style={{ ...qS.choiceLetter, background: hasAnswered ? (isCorrect ? '#4A7C59' : isSelected ? '#C0392B' : '#9BAAC0') : '#1A1714' }}>
                    {letter}
                  </span>
                  <span style={qS.choiceText}>{q.choices[letter]}</span>
                </button>
              );
            })}
          </div>

          {hasAnswered && (
            <div style={{ ...qS.explanation, ...(answered === q.correct ? qS.expRight : qS.expWrong) }}>
              <div style={qS.expLabel}>{answered === q.correct ? '✓ Correct' : `✗ Incorrect — Answer: ${q.correct}`}</div>
              <div style={qS.expText}>{q.explanation}</div>
            </div>
          )}

        </div>
        </div>{/* end question card column */}

          {/* Right nav pane */}
          <QuizNavBar questions={questions} answers={answers} currentIdx={idx} onJump={jumpTo} flaggedKeys={flaggedKeys} />
        </div>
      </div>
    );
  }

  // ── SETUP screen ──────────────────────────────────────────────────────────
  if (chapters.length === 0) {
    return (
      <div style={qS.empty}>
        <div style={{ fontSize: 52 }}>🎯</div>
        <div style={qS.emptyTitle}>No Chapter Content Yet</div>
        <div style={qS.emptyDesc}>Add content to at least one chapter in the Textbook tab, then return here.</div>
      </div>
    );
  }

  return (
    <div style={qS.wrap}>

      {/* Post-generation report */}
      {genReport && (
        <div style={qS.genReportBar}>
          <div>
            <span style={qS.genReportTitle}>✓ {genReport.label} generated — {genReport.total} questions</span>
            <span style={qS.genReportDetail}> · {genReport.factCount} fact-based · {genReport.appCount} application</span>
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button style={qS.btnPrimary} onClick={() => startSession(genReport.chId, genReport.setId)}>Start Quiz →</button>
            <button style={qS.btnGhost} onClick={() => setGenReport(null)}>✕</button>
          </div>
        </div>
      )}

      <QuizSetupCard
        chapters={chapters} quizData={quizData}
        selChapter={selChapter} setSelChapter={setSelChapter}
        chDropOpen={chDropOpen} setChDropOpen={setChDropOpen}
        settings={settings} setSettings={setSettings}
        hasApiKey={hasApiKey} maxQ={maxQ} generate={generate}
      />

      {/* Question Banks — grouped by chapter */}
      {Object.keys(quizData).length > 0 && (
        <div style={qS.banksSection}>
          <div style={qS.banksLabel}>Question Banks</div>
          {course.chapters.map(ch => {
            const chData = quizData[ch.id];
            if (!chData?.sets?.length) return null;
            const isCollapsed = collapsedBanks.has(ch.id);
            const allWrong    = chData.sets.reduce((s, set) => s + Object.keys(set.wrongBank || {}).length, 0);

            return (
              <div key={ch.id} style={qS.chapterBank}>
                {(() => {
                  const doneSets = chData.sets.filter(s => s.sessions?.length > 0);
                  const aggPct = doneSets.length > 0
                    ? Math.round(doneSets.flatMap(s => s.sessions).reduce((sum, sess) => sum + sess.score / sess.total, 0) / doneSets.flatMap(s => s.sessions).length * 100)
                    : null;
                  const aggColor = aggPct == null ? '#5A4538' : aggPct >= 75 ? '#4A7C59' : aggPct >= 60 ? '#2A6049' : '#C0392B';
                  return (
                    <div style={qS.chapterBankHeader} onClick={() => toggleBank(ch.id)}>
                      <div style={qS.chapterBankTitle}>{fmtTitle(ch.title)}</div>
                      {aggPct !== null && (
                        <div style={{ fontSize:13.5, fontWeight:700, color: aggColor, marginLeft:'auto', marginRight:8 }}>{aggPct}%</div>
                      )}
                      <span style={{ fontSize:10, color:'#B8A870', userSelect:'none' }}>{isCollapsed ? '▶' : '▼'}</span>
                    </div>
                  );
                })()}

                {!isCollapsed && (
                  <>
                    {chData.sets.map((set) => {
                  const lastSess    = set.sessions?.slice(-1)[0];
                  const lastPct     = lastSess ? Math.round(lastSess.score / lastSess.total * 100) : null;
                  const wrongCount  = Object.keys(set.wrongBank || {}).length;
                  const flagCount   = (set.flagged || []).length;
                  const inProgress  = set.progress && Object.keys(set.progress.answers || {}).length > 0 && !set.sessions?.length;
                  const resumeIdx   = set.progress?.idx || 0;
                  const resumeCount = Object.keys(set.progress?.answers || {}).length;

                  const typeLabel = set.settings?.type === 'fact' ? 'fact-based' : set.settings?.type === 'application' ? 'application' : 'mixed';
                  const isDone = set.sessions?.length > 0;
                  const metaText = isDone
                    ? `${lastPct}% · ${set.questions.length} questions · ${typeLabel}`
                    : inProgress
                      ? `${resumeCount}/${set.questions.length} answered · ${typeLabel}`
                      : `${set.questions.length} questions · ${typeLabel}`;

                  return (
                    <div key={set.id} style={qS.setRow}>
                      <div style={qS.setInfo}>
                        <div style={qS.setLabel}>{set.label}</div>
                        <div style={qS.setMeta}>{metaText}</div>
                      </div>
                      <div style={qS.setActions}>
                        {isDone
                          ? <button style={qS.btnSmall} onClick={() => openReview(ch.id, set.id)}>Review</button>
                          : inProgress
                            ? <button style={qS.btnSmall} onClick={() => startSession(ch.id, set.id)}>▶ Resume</button>
                            : <button style={qS.btnSmall} onClick={() => startSession(ch.id, set.id)}>Take</button>
                        }
                        <button style={{ ...qS.btnSmall, color:'#C0392B', borderColor:'#EBBAB4' }} onClick={() => deleteSet(ch.id, set.id)}>✕</button>
                      </div>
                    </div>
                  );
                })}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Setup screen ──────────────────────────────────────────────────────────────
// (inline component so it can have its own focusOpen state)
function QuizSetupCard({ chapters, quizData, selChapter, setSelChapter, chDropOpen, setChDropOpen, settings, setSettings, hasApiKey, maxQ, generate, genReport, setGenReport, startSession }) {
  const [focusOpen, setFocusOpen] = useQState(false);

  return (
    <div style={qS.setupCard}>
      <div style={qS.setupTitle}>Generate a New Quiz</div>

      {!hasApiKey && (
        <div style={qS.apiWarning}>⚙ No API key — capped at 30 questions. Add your key via ⚙ in the sidebar for up to 500.</div>
      )}

      {/* Row 1: Chapter selector */}
      <div style={qS.fieldGroup}>
        <div style={qS.fieldLabel}>Chapter</div>
        <div style={{ position:'relative' }}>
          <button
            style={{ ...qS.chDropdownTrigger, ...(selChapter ? qS.chDropdownSelected : {}) }}
            onClick={() => setChDropOpen(p => !p)}
          >
            <span style={{ flex:1, textAlign:'left' }}>
              {selChapter ? fmtTitle(chapters.find(c => c.id === selChapter)?.title) : 'Choose a chapter…'}
            </span>
            <span style={{ fontSize:10, opacity:0.6 }}>{chDropOpen ? '▲' : '▼'}</span>
          </button>
          {chDropOpen && (
            <div style={qS.chDropdownList}>
              {chapters.map(ch => {
                const active   = selChapter === ch.id;
                const setCount = quizData[ch.id]?.sets?.length || 0;
                return (
                  <button key={ch.id}
                    style={{ ...qS.chDropdownItem, ...(active ? qS.chDropdownItemActive : {}) }}
                    onClick={() => { setSelChapter(active ? null : ch.id); setChDropOpen(false); }}
                  >
                    <span style={{ ...qS.chNum2, background: '#2A6049', flexShrink:0 }}>{ch.number}</span>
                    <span style={{ flex:1, fontSize:13, color: active ? '#1A1714' : '#3A3020' }}>{fmtTitle(ch.title)}</span>
                    {setCount > 0 && <span style={qS.hasBadge}>{setCount} quiz{setCount > 1 ? 'zes' : ''}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Row 2: Count + Type inline */}
      <div style={{ display:'flex', gap:16, alignItems:'flex-end', marginBottom:18, flexWrap:'wrap' }}>
        <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
          <div style={qS.fieldLabel}>
            Questions{!hasApiKey && <span style={{ color:'#B8A070', marginLeft:5, fontWeight:400 }}>max {maxQ}</span>}
          </div>
          <input
            type="number" min={1} max={hasApiKey ? 500 : 30} step={1}
            value={settings.count}
            onChange={e => { const v = Math.max(1, Math.min(hasApiKey ? 500 : 30, parseInt(e.target.value) || 1)); setSettings(p => ({ ...p, count: v })); }}
            style={qS.countInput}
          />
          {hasApiKey && settings.count > 50 && <div style={qS.largeQNote}>~{Math.ceil(settings.count / 20)} batches</div>}
        </div>

        <div style={{ flex:1, minWidth:180 }}>
          <div style={qS.fieldLabel}>Type</div>
          <div style={qS.typeRow}>
            {QUIZ_TYPES.map(t => {
              const active = settings.type === t.value;
              return (
                <button key={t.value} style={{ ...qS.typeOpt, ...(active ? qS.typeOptActive : {}) }}
                  onClick={() => setSettings(p => ({ ...p, type: t.value }))}>
                  <div style={{ ...qS.typeLabel2, color: active ? '#F8F6F1' : '#1A1714' }}>{t.label}</div>
                  <div style={{ ...qS.typeDesc2, color: active ? 'rgba(253,250,244,.55)' : '#5A4538' }}>{t.desc}</div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Focus area accordion */}
      <div style={{ marginBottom:20 }}>
        <button
          style={{ display:'flex', alignItems:'center', gap:6, background:'none', border:'none', cursor:'pointer', padding:0, marginBottom: focusOpen ? 8 : 0 }}
          onClick={() => setFocusOpen(p => !p)}
        >
          <span style={{ fontSize:10.5, fontWeight:700, color:'#2A6049', textTransform:'uppercase', letterSpacing:'.7px' }}>Focus Area</span>
          <span style={{ fontSize:9, color:'#B8A870' }}>{focusOpen ? '▲' : '▼'}</span>
          {!focusOpen && settings.focusArea?.trim() && <span style={{ fontSize:10.5, color:'#4A7C59', fontWeight:600 }}>● set</span>}
        </button>
        {focusOpen && (
          <textarea
            style={qS.focusTA}
            value={settings.focusArea || ''}
            onChange={e => setSettings(p => ({ ...p, focusArea: e.target.value }))}
            placeholder={'Narrow what Claude quizzes you on. Examples:\n• "pages 1–30"\n• "Erie Railroad v. Tompkins"\n• "the 11 stages of civil litigation"'}
            rows={3}
          />
        )}
      </div>

      <div style={{ display:'flex', alignItems:'center', gap:12 }}>
        <button
          style={{ ...qS.btnPrimary, padding:'11px 28px', fontSize:14, opacity: selChapter ? 1 : 0.4, cursor: selChapter ? 'pointer' : 'not-allowed' }}
          onClick={selChapter ? generate : undefined}
        >
          ✦ Generate {Math.min(settings.count, maxQ)} Questions
        </button>
      </div>
    </div>
  );
}

// ── Quiz navigation bar (right-side panel) ───────────────────────────────────
function QuizNavBar({ questions, answers, currentIdx, onJump, flaggedKeys = [] }) {
  return (
    <div style={qS.navBar}>
      <div style={qS.navBarLabel}>Questions</div>
      <div style={qS.navBarInner}>
        {questions.map((q, i) => {
          const ans      = answers[i];
          const isCur    = i === currentIdx;
          const isRight  = ans === q.correct;
          const isWrong  = ans !== undefined && !isRight;
          const isFlaggedQ = (flaggedKeys || []).includes((q.question || '').slice(0, 100).trim());
          const bg      = isFlaggedQ ? '#D4A017' : isRight ? '#4A7C59' : isWrong ? '#C0392B' : isCur ? '#1A1714' : '#F0EBE0';
          const color   = (isCur || isRight || isWrong || isFlaggedQ) ? 'white' : '#4A3D30';
          const curOutline = isCur ? '2px solid #2A6049' : 'none';
          return (
            <button
              key={i}
              onClick={() => onJump(i)}
              style={{ ...qS.navBox, background: bg, color, fontWeight: isCur ? 700 : 400, outline: curOutline, outlineOffset: 1 }}
              title={`Q${i + 1}`}
            >
              {i + 1}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Chapter stats panel ───────────────────────────────────────────────────────
function ChapterStats({ chData }) {
  const sets    = chData.sets || [];
  const allSess = sets.flatMap(s => s.sessions || []);
  if (!allSess.length) return <div style={{ padding:'12px 16px', fontSize:12.5, color:'#5A4538' }}>No sessions yet.</div>;
  const avg  = Math.round(allSess.reduce((s, x) => s + x.score / x.total, 0) / allSess.length * 100);
  const best = Math.round(Math.max(...allSess.map(s => s.score / s.total)) * 100);

  // Sparkline
  const sparkData = allSess.slice(-10).map(s => Math.round(s.score / s.total * 100));
  const sparkW = 110, sparkH = 30, pad = 3;
  const minV = Math.max(0, Math.min(...sparkData) - 8);
  const maxV = Math.min(100, Math.max(...sparkData) + 5);
  const rng  = maxV - minV || 1;
  const pts  = sparkData.map((v, i) => {
    const x = pad + (i / Math.max(sparkData.length - 1, 1)) * (sparkW - pad * 2);
    const y = sparkH - pad - ((v - minV) / rng) * (sparkH - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const lastPct    = sparkData[sparkData.length - 1];
  const sparkColor = lastPct >= 75 ? '#4A7C59' : lastPct >= 60 ? '#2A6049' : '#C0392B';

  return (
    <div style={qS.statsPanel}>
      <div style={{ display:'flex', gap:10, marginBottom:14, alignItems:'stretch' }}>
        <StatBox label="Sessions"  value={allSess.length} />
        <StatBox label="Avg Score" value={`${avg}%`} />
        <StatBox label="Best"      value={`${best}%`} color="#4A7C59" />
        {sparkData.length > 1 && (
          <div style={{ flex:1, background:'white', border:'1px solid #E2D9CC', borderRadius:6, padding:'7px 10px', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center' }}>
            <svg width={sparkW} height={sparkH} style={{ overflow:'visible' }}>
              <polyline points={pts} fill="none" stroke={sparkColor} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              {(() => {
                const i = sparkData.length - 1;
                const x = pad + (i / Math.max(sparkData.length - 1, 1)) * (sparkW - pad * 2);
                const y = sparkH - pad - ((sparkData[i] - minV) / rng) * (sparkH - pad * 2);
                return <circle cx={x.toFixed(1)} cy={y.toFixed(1)} r="3" fill={sparkColor} />;
              })()}
            </svg>
            <div style={{ fontSize:9.5, color:'#B8A870', marginTop:2 }}>Trend</div>
          </div>
        )}
      </div>
      <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
        {allSess.slice(-6).reverse().map((s, i) => {
          const p = Math.round(s.score / s.total * 100);
          const d = new Date(s.date).toLocaleDateString('en-US', { month:'short', day:'numeric' });
          return (
            <div key={i} style={{ display:'flex', alignItems:'center', gap:10 }}>
              <span style={{ fontSize:11, color:'#5A4538', width:48 }}>{d}</span>
              <div style={{ flex:1, height:5, background:'#E2D9CC', borderRadius:3 }}>
                <div style={{ height:'100%', borderRadius:3, width:`${p}%`, background: p >= 75 ? '#4A7C59' : p >= 60 ? '#2A6049' : '#C0392B', transition:'width .4s' }} />
              </div>
              <span style={{ fontSize:11.5, fontWeight:700, color: p >= 75 ? '#4A7C59' : p >= 60 ? '#2A6049' : '#C0392B', width:36 }}>{p}%</span>
              <span style={{ fontSize:11, color:'#B8A870' }}>{s.score}/{s.total}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatBox({ label, value, color }) {
  return (
    <div style={{ flex:1, background:'white', border:'1px solid #E2D9CC', borderRadius:6, padding:'9px 12px', textAlign:'center' }}>
      <div style={{ fontSize:18, fontWeight:700, fontFamily:'"Lora", "Lora", Georgia, serif', color: color || '#1A1714' }}>{value}</div>
      <div style={{ fontSize:10.5, color:'#5A4538', marginTop:2 }}>{label}</div>
    </div>
  );
}

const qS = {
  wrap:  { flex:1, overflowY:'auto', padding:'24px 36px' },
  empty: { flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:16, padding:60, textAlign:'center' },
  emptyTitle:{ fontFamily:'"Lora", "Lora", Georgia, serif', fontSize:22, fontWeight:700, color:'#1A1714' },
  emptyDesc: { fontSize:14, color:'#4A3D30', maxWidth:380, lineHeight:1.65 },
  // Banners
  missBar:    { display:'flex', alignItems:'center', justifyContent:'space-between', background:'#FEF0EE', border:'1px solid #EBBAB4', borderRadius:8, padding:'10px 16px', marginBottom:16, maxWidth:860 },
  missBarText:{ fontSize:13, color:'#7A2020' },
  missBarBtn: { padding:'6px 14px', background:'#1A1714', color:'#FFFFFF', border:'none', borderRadius:5, fontSize:12.5, fontWeight:600, cursor:'pointer' },
  genReportBar:{ display:'flex', alignItems:'center', justifyContent:'space-between', background:'#EFF8F1', border:'1px solid #86EFAC', borderRadius:8, padding:'11px 18px', marginBottom:16, maxWidth:860, flexWrap:'wrap', gap:10 },
  genReportTitle:{ fontSize:13.5, fontWeight:600, color:'#14532D' },
  genReportDetail:{ fontSize:12.5, color:'#166534' },
  apiWarning:{ padding:'10px 14px', background:'#FDF3E0', border:'1px solid #E8D5A0', borderRadius:6, fontSize:12.5, color:'#8B5E00', marginBottom:18, lineHeight:1.55 },
  // Setup
  setupCard:  { background:'white', borderRadius:12, border:'1px solid #E2D9CC', padding:28, maxWidth:860, boxShadow:'0 2px 14px rgba(26,39,68,.06)', marginBottom:24 },
  setupTitle: { fontFamily:'"Lora", "Lora", Georgia, serif', fontSize:20, fontWeight:700, color:'#1A1714', marginBottom:18 },
  fieldGroup: { marginBottom:18 },
  fieldLabel: { fontSize:10.5, fontWeight:700, color:'#2A6049', textTransform:'uppercase', letterSpacing:'.7px', marginBottom:9 },
  chapterGrid:{ display:'flex', flexDirection:'column', gap:5, maxHeight:220, overflowY:'auto', paddingRight:4 },
  chOpt:      { display:'flex', alignItems:'center', gap:10, padding:'9px 12px', borderRadius:6, border:'1px solid #E2D9CC', background:'none', cursor:'pointer', textAlign:'left', width:'100%', transition:'all .12s' },
  chOptActive:{ background:'#FDF3E0', borderColor:'#2A6049' },
  chNum2:     { width:26, height:26, borderRadius:'50%', color:'#FFFFFF', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:700, flexShrink:0 },
  chTitle2:   { fontSize:13, flex:1 },
  hasBadge:   { fontSize:11, color:'#4A7C59', fontWeight:700, flexShrink:0 },
  settingsRow:{ display:'flex', gap:24, flexWrap:'wrap', marginBottom:18 },
  countInput: { width:120, padding:'8px 12px', border:'1px solid #DDD6CC', borderRadius:6, fontSize:15, fontFamily:'"Lora", "Lora", Georgia, serif', fontWeight:600, color:'#1A1714', background:'white', outline:'none', marginBottom:4 },
  focusTA:    { width:'100%', boxSizing:'border-box', padding:'9px 12px', borderRadius:6, border:'1px solid #DDD6CC', fontSize:13, fontFamily:'"Lora", Georgia, serif', lineHeight:1.55, resize:'vertical', background:'white', outline:'none', color:'#2C2416' },
  largeQNote: { fontSize:11.5, color:'#5A4538', background:'#F8F6F1', padding:'5px 9px', borderRadius:4 },
  typeRow:    { display:'flex', gap:7 },
  typeOpt:    { flex:1, padding:'10px 8px', borderRadius:7, border:'1px solid #E2D9CC', background:'none', cursor:'pointer', textAlign:'center', transition:'all .12s' },
  typeOptActive:{ background:'#1A1714', borderColor:'#1A1714' },
  typeLabel2: { fontSize:12.5, fontWeight:600, marginBottom:2 },
  typeDesc2:  { fontSize:11 },
  noSelHint:  { fontSize:12, color:'#B8A070', marginTop:8 },
  // Banks
  banksSection:  { maxWidth:860 },
  banksLabel:    { fontSize:10.5, fontWeight:700, color:'#2A6049', textTransform:'uppercase', letterSpacing:'.7px', marginBottom:10 },
  chapterBank:   { background:'white', border:'1px solid #E2D9CC', borderRadius:10, marginBottom:10, overflow:'hidden' },
  chapterBankHeader:{ display:'flex', alignItems:'center', gap:12, padding:'12px 16px', borderBottom:'1px solid #F5EFE6', cursor:'pointer', userSelect:'none' },
  chapterBankTitle:{ fontFamily:'"Lora", "Lora", Georgia, serif', fontSize:15, fontWeight:700, color:'#1A1714', flex:1 },
  chapterBankMeta: { fontSize:11.5, color:'#5A4538' },
  statsPanel:    { padding:'14px 16px', background:'#FFFFFF', borderBottom:'1px solid #F5EFE6' },
  setRow:    { display:'flex', alignItems:'center', padding:'10px 16px', borderBottom:'1px solid #F8F6F1', gap:12 },
  setInfo:   { flex:1 },
  setLabel:  { fontSize:14, fontWeight:600, color:'#1A1714' },
  setMeta:   { fontSize:12, color:'#4A3D2E', fontWeight:500, marginTop:3 },
  setActions:{ display:'flex', gap:6, flexShrink:0 },
  btnSmall:  { padding:'5px 11px', background:'white', color:'#1A1714', border:'1px solid #DDD6CC', borderRadius:5, fontSize:12, cursor:'pointer' },
  // Generating
  genCard: { background:'white', borderRadius:12, border:'1px solid #E2D9CC', padding:'44px 52px', maxWidth:460, width:'100%', textAlign:'center', boxShadow:'0 4px 28px rgba(26,39,68,.11)' },
  genSpinner: { width:36, height:36, border:'3px solid #E2D9CC', borderTopColor:'#2A6049', borderRadius:'50%', animation:'spin 0.9s linear infinite', margin:'0 auto 20px' },
  genTitle:{ fontFamily:'"Lora", "Lora", Georgia, serif', fontSize:22, fontWeight:700, color:'#1A1714', marginBottom:8 },
  genSub:  { fontSize:14, color:'#5A4538', marginBottom:20 },
  genPct:  { fontSize:12, color:'#5A4538', marginTop:8, marginBottom:20 },
  progressTrack:{ height:6, background:'#E2D9CC', borderRadius:3 },
  progressFill: { height:'100%', background:'#2A6049', borderRadius:3, transition:'width .4s' },
  errorBox: { padding:12, background:'#FEF0EE', border:'1px solid #EBBAB4', borderRadius:6, color:'#C0392B', fontSize:13, marginBottom:14, textAlign:'left' },
  // Quiz UI
  quizBar:  { display:'flex', alignItems:'center', gap:12, marginBottom:18 },
  backLink: { background:'none', border:'none', color:'#2A6049', fontSize:14, cursor:'pointer', fontWeight:600, padding:0, flexShrink:0 },
  modePill: { fontSize:12, fontWeight:700, background:'#2A6049', color:'#FFFFFF', padding:'4px 11px', borderRadius:10, flexShrink:0 },
  quizProgress:{ flex:1, display:'flex', flexDirection:'column', gap:4 },
  progressLabel:{ fontSize:12, color:'#5A4538', alignSelf:'flex-end', fontWeight:500 },
  scorePill:{ background:'#1A1714', color:'#FFFFFF', padding:'4px 14px', borderRadius:12, fontSize:13, fontWeight:700, flexShrink:0, letterSpacing:'0.3px' },
  qCard:    { background:'white', borderRadius:12, border:'1px solid #E2D9CC', padding:28, maxWidth:800, boxShadow:'0 3px 16px rgba(26,39,68,.07)', marginBottom:12 },
  qHeader:  { display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 },
  qMeta:    { display:'flex', alignItems:'center', gap:8 },
  qNum:     { fontSize:12, fontWeight:700, color:'#5A4538' },
  qtypePill:{ fontSize:11.5, fontWeight:600, padding:'2px 9px', borderRadius:4, letterSpacing:'0.2px' },
  qText:    { fontSize:18, color:'#1A1714', lineHeight:1.72, marginBottom:22, fontFamily:'"Lora", Georgia, serif', fontWeight:400 },
  flagBtn:  { padding:'5px 11px', borderRadius:6, border:'1px solid #E2D9CC', background:'none', cursor:'pointer', fontSize:12, color:'#5A4538', flexShrink:0 },
  flagBtnActive:{ background:'#FDF3E0', borderColor:'#2A6049', color:'#2A6049', fontWeight:600 },
  choices:  { display:'flex', flexDirection:'column', gap:8 },
  choice:   { display:'flex', alignItems:'flex-start', gap:12, padding:'12px 14px', borderRadius:8, border:'1.5px solid #E2D9CC', background:'none', cursor:'pointer', textAlign:'left', width:'100%' },
  choiceRight:{ background:'#EFF8F1', borderColor:'#4A7C59', boxShadow:'0 0 0 2px rgba(74,124,89,.18)' },
  choiceWrong:{ background:'#FEF0EE', borderColor:'#C0392B' },
  choiceLetter:{ width:28, height:28, borderRadius:'50%', color:'white', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, fontSize:12.5, flexShrink:0 },
  choiceText:  { fontSize:14, color:'#2C2416', lineHeight:1.5, paddingTop:4 },
  explanation:{ marginTop:16, padding:14, borderRadius:8, border:'1px solid' },
  expRight: { background:'#EFF8F1', borderColor:'#4A7C59' },
  expWrong: { background:'#FEF0EE', borderColor:'#C0392B' },
  expLabel: { fontWeight:700, fontSize:13.5, marginBottom:6, letterSpacing:'0.1px' },
  expText:  { fontSize:13.5, color:'#2C2416', lineHeight:1.65 },
  navBtns:  { display:'flex', alignItems:'center', gap:8, marginTop:0, width:'100%' },
  navBtnSm:        { padding:'6px 13px', background:'white', color:'#1A1714', border:'1px solid #D8D0C4', borderRadius:5, fontSize:13, cursor:'pointer', fontWeight:600 },
  navBtnSmPrimary: { padding:'5px 14px', background:'#1A1714', color:'#FFFFFF', border:'none', borderRadius:5, fontSize:12.5, cursor:'pointer', fontWeight:600 },
  navBtn:   { padding:'8px 16px', background:'white', color:'#1A1714', border:'1px solid #DDD6CC', borderRadius:6, fontSize:13, cursor:'pointer' },
  changeBtn:{ padding:'8px 16px', background:'#F8F6F1', color:'#5A4538', border:'1px solid #DDD6CC', borderRadius:6, fontSize:12.5, cursor:'pointer' },
  // Nav bar (right side panel)
  navBar:      { width:180, flexShrink:0, background:'white', border:'1px solid #E2D9CC', borderRadius:10, padding:'12px 10px', maxHeight:'70vh', overflowY:'auto', position:'sticky', top:0 },
  navBarLabel: { fontSize:9.5, fontWeight:700, color:'#2A6049', textTransform:'uppercase', letterSpacing:'1px', marginBottom:8, paddingLeft:2 },
  navBarInner: { display:'flex', flexWrap:'wrap', gap:4 },
  navBox:      { width:32, height:32, borderRadius:5, fontSize:11, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', transition:'background .1s', fontFamily:'"Lora", Georgia, serif' },
  // Chapter dropdown
  chDropdownTrigger: { display:'flex', alignItems:'center', gap:8, width:'100%', padding:'9px 12px', borderRadius:6, border:'1px solid #E2D9CC', background:'white', cursor:'pointer', fontSize:13, color:'#4A3D30' },
  chDropdownSelected:{ borderColor:'#2A6049', color:'#1A1714', fontWeight:500 },
  chDropdownList:    { position:'absolute', top:'calc(100% + 4px)', left:0, right:0, background:'white', border:'1px solid #E2D9CC', borderRadius:8, boxShadow:'0 8px 24px rgba(26,39,68,.12)', zIndex:100, maxHeight:280, overflowY:'auto' },
  chDropdownItem:    { display:'flex', alignItems:'center', gap:10, width:'100%', padding:'9px 12px', background:'none', border:'none', borderBottom:'1px solid #F8F6F1', cursor:'pointer', textAlign:'left' },
  chDropdownItemActive:{ background:'#FDF3E0' },
  // Score
  scoreCard:    { background:'white', borderRadius:14, border:'1px solid #E2D9CC', padding:'38px 32px', maxWidth:500, margin:'0 auto', textAlign:'center', boxShadow:'0 6px 28px rgba(26,39,68,.1)' },
  scoreSeal:    { fontSize:48, marginBottom:10 },
  scoreHeading: { fontFamily:'"Lora", "Lora", Georgia, serif', fontSize:24, fontWeight:700, color:'#1A1714', marginBottom:12 },
  scoreBig:  { fontSize:58, fontWeight:700, color:'#1A1714', lineHeight:1 },
  scoreOf:   { fontSize:30, color:'#5A4538' },
  scoreGrade:{ fontSize:16, marginTop:8, fontWeight:600, marginBottom:16 },
  scoreBreakdown:{ background:'#F8F6F1', borderRadius:7, padding:'12px 16px', marginBottom:14, textAlign:'left' },
  breakdownRow:  { display:'flex', justifyContent:'space-between', fontSize:13, marginBottom:4 },
  breakdownLabel:{ color:'#4A3D30' },
  breakdownVal:  { fontWeight:600, color:'#1A1714' },
  scoreSection:  { marginTop:14, background:'#F8F6F1', borderRadius:7, padding:'10px 14px', textAlign:'left' },
  scoreSectionLabel:{ fontSize:10.5, fontWeight:700, color:'#2A6049', textTransform:'uppercase', letterSpacing:'.7px', marginBottom:7 },
  wrongPreview:  { fontSize:12, color:'#3A3020', marginBottom:3, lineHeight:1.4, fontStyle:'italic' },
  scoreActions:  { display:'flex', gap:8, justifyContent:'center', marginTop:20, flexWrap:'wrap' },
  // Buttons
  btnPrimary:  { padding:'9px 20px', background:'#1A1714', color:'#FFFFFF', border:'none', borderRadius:6, fontSize:13, fontWeight:600, cursor:'pointer' },
  btnSecondary:{ padding:'7px 14px', background:'white', color:'#1A1714', border:'1px solid #DDD6CC', borderRadius:6, fontSize:12.5, cursor:'pointer' },
  btnGhost:    { padding:'9px 16px', background:'none', color:'#4A3D30', border:'1px solid #DDD6CC', borderRadius:6, fontSize:13, cursor:'pointer' },
};

Object.assign(window, { QuizTab });
