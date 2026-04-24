
// Normalize chapter title format: "Chapter N — Title" → "Chapter N: Title"
function fmtTitle(t) {
  return (t || '').replace(/\s+[\u2014\u2013\-]{1,2}\s+/, ': ');
}
// CaseBriefsTab — write briefs, download as Word doc
const { useState: useCBState, useRef: useCBRef } = React;

const BRIEF_FIELDS = [
  { key: 'facts',             label: 'Facts',               placeholder: 'Describe the key facts relevant to the legal issue…'          },
  { key: 'proceduralHistory', label: 'Procedural History',  placeholder: 'How did the case reach this court?…'                          },
  { key: 'issue',             label: 'Issue',               placeholder: 'What is the precise legal question before the court?…'         },
  { key: 'holding',           label: 'Holding/Rule',        placeholder: "State the court's ruling and the legal rule or principle it establishes…" },
  { key: 'reasoning',         label: 'Reasoning',           placeholder: "Explain the court's legal reasoning and analysis…"            },
];

function CaseBriefsTab({ course, onUpdate, initialCase, onClearInitialCase }) {
  const [selected,       setSelected]       = useCBState(initialCase || null);
  const [search,         setSearch]         = useCBState('');
  const [showAddModal,   setShowAddModal]   = useCBState(false);
  const [newCaseName,    setNewCaseName]    = useCBState('');
  const [newCaseChapter, setNewCaseChapter] = useCBState('');
  const [downloading,    setDownloading]    = useCBState(false);
  const [saveFlash,      setSaveFlash]      = useCBState(false);

  React.useEffect(() => {
    if (initialCase) { setSelected(initialCase); onClearInitialCase?.(); }
  }, [initialCase]);
  const [collapsedChs,   setCollapsedChs]   = useCBState(new Set());
  const [reviewPanel,    setReviewPanel]    = useCBState(null); // { fieldKey, fieldLabel, loading, result }

  // ── Import state ──
  const [importOpen,        setImportOpen]        = useCBState(false);
  const [importStep,        setImportStep]        = useCBState('input'); // input | parsing | preview
  const [importInputMode,   setImportInputMode]   = useCBState('paste'); // paste | upload
  const [importText,        setImportText]        = useCBState('');
  const [importFileName,    setImportFileName]    = useCBState('');
  const [importError,       setImportError]       = useCBState('');
  const [importParsed,      setImportParsed]      = useCBState([]);
  const [importAssignments, setImportAssignments] = useCBState({});
  const importFileRef = useCBRef(null);

  function toggleChapter(chId) {
    setCollapsedChs(prev => {
      const next = new Set(prev);
      if (next.has(chId)) next.delete(chId); else next.add(chId);
      return next;
    });
  }

  async function runRedFlagReview(fieldKey, fieldLabel, fieldContent) {
    if (!fieldContent?.trim()) return;
    setReviewPanel({ fieldKey, fieldLabel, loading: true, result: null });
    try {
      const result = await window.LexStore.generateRedFlagReview({
        caseName: selected, fieldLabel, fieldContent,
      });
      setReviewPanel({ fieldKey, fieldLabel, loading: false, result });
    } catch (err) {
      setReviewPanel({ fieldKey, fieldLabel, loading: false, result: '⚠ Error: ' + (err.message || 'Review failed.') });
    }
  }

  const chapters = course.chapters || [];
  const briefs   = course.briefs   || {};

  // Stats
  const totalCases     = chapters.reduce((s, ch) => s + (ch.cases?.length || 0), 0);
  const completedCount = Object.values(briefs).filter(b => b.facts || b.holding).length;

  // Filtered cases grouped by chapter
  const q = search.toLowerCase();
  const groups = chapters
    .map(ch => ({
      chapter: ch,
      cases: (ch.cases || []).filter(c => !q || c.toLowerCase().includes(q)),
    }))
    .filter(g => g.cases.length > 0);

  // Current brief
  const currentBrief   = selected ? (briefs[selected] || {}) : null;
  const briefedFields  = currentBrief ? BRIEF_FIELDS.filter(f => currentBrief[f.key]).length : 0;
  const isComplete     = briefedFields >= 4;

  function updateField(field, value) {
    const updated = {
      ...briefs,
      [selected]: { ...(briefs[selected] || {}), [field]: value },
    };
    onUpdate({ briefs: updated });
    // flash
    setSaveFlash(true);
    setTimeout(() => setSaveFlash(false), 800);
  }

  // ── Import helpers ──
  function openImport() {
    setImportOpen(true);
    setImportStep('input');
    setImportInputMode('paste');
    setImportText('');
    setImportFileName('');
    setImportError('');
    setImportParsed([]);
    setImportAssignments({});
  }

  function normalizeName(n) {
    return (n || '').toLowerCase().replace(/[.,;:'"`]/g, '').replace(/\s+/g, ' ').trim();
  }

  function findExistingCase(name) {
    if (briefs[name]) return name;
    const target = normalizeName(name);
    return Object.keys(briefs).find(k => normalizeName(k) === target) || null;
  }

  async function handleImportFile(file) {
    if (!file) return;
    setImportFileName(file.name);
    setImportError('');
    setImportText('');
    try {
      const text = await window.LexStore.readBriefFile(file);
      if (!text.trim()) throw new Error('The file appears to be empty.');
      setImportText(text);
    } catch (err) {
      setImportError(err.message || 'Could not read the file.');
      setImportFileName('');
    }
  }

  async function runImportParse() {
    const text = importText.trim();
    if (!text) { setImportError('Paste some text or upload a file first.'); return; }
    setImportStep('parsing');
    setImportError('');
    try {
      const parsed = await window.LexStore.extractBriefsFromText(text);
      const assignments = {};
      parsed.forEach(p => {
        const existingKey = findExistingCase(p.caseName);
        if (existingKey) {
          assignments[p.caseName] = {
            mode: 'fill',
            existingKey,
            chapter: briefs[existingKey]?.chapter || chapters[0]?.id || null,
          };
        } else {
          assignments[p.caseName] = {
            mode: chapters.length ? 'add' : 'skip',
            existingKey: null,
            chapter: chapters[0]?.id || null,
          };
        }
      });
      setImportParsed(parsed);
      setImportAssignments(assignments);
      setImportStep('preview');
    } catch (err) {
      setImportError(err.message || 'Could not parse briefs.');
      setImportStep('input');
    }
  }

  function setAssignment(caseName, updates) {
    setImportAssignments(prev => ({ ...prev, [caseName]: { ...prev[caseName], ...updates } }));
  }

  function commitImport() {
    const updatedBriefs   = { ...briefs };
    const updatedChapters = chapters.map(ch => ({ ...ch, cases: [...(ch.cases || [])] }));
    const FIELD_KEYS = ['facts','proceduralHistory','issue','holding','reasoning'];

    for (const p of importParsed) {
      const a = importAssignments[p.caseName] || {};
      if (a.mode === 'skip') continue;

      const newFields = {};
      FIELD_KEYS.forEach(k => { if (p[k] && p[k].trim()) newFields[k] = p[k].trim(); });

      if (a.mode === 'replace' && a.existingKey) {
        updatedBriefs[a.existingKey] = { ...(briefs[a.existingKey] || {}), ...newFields };
      } else if (a.mode === 'fill' && a.existingKey) {
        const merged = { ...(briefs[a.existingKey] || {}) };
        Object.keys(newFields).forEach(k => {
          if (!merged[k] || !String(merged[k]).trim()) merged[k] = newFields[k];
        });
        updatedBriefs[a.existingKey] = merged;
      } else if (a.mode === 'add' && a.chapter) {
        updatedBriefs[p.caseName] = {
          chapter: a.chapter, facts:'', proceduralHistory:'', issue:'', holding:'', reasoning:'',
          ...newFields,
        };
        const ch = updatedChapters.find(c => c.id === a.chapter);
        if (ch && !ch.cases.includes(p.caseName)) ch.cases.push(p.caseName);
      }
    }

    onUpdate({ chapters: updatedChapters, briefs: updatedBriefs });
    setImportOpen(false);
  }

  function addCase() {
    if (!newCaseName.trim()) return;
    const chId = newCaseChapter || chapters[0]?.id;
    if (!chId) return;
    const name = newCaseName.trim();
    const updatedChapters = chapters.map(ch =>
      ch.id === chId ? { ...ch, cases: [...(ch.cases || []), name] } : ch
    );
    const updatedBriefs = {
      ...briefs,
      [name]: { chapter: chId, facts:'', proceduralHistory:'', issue:'', holding:'', reasoning:'' },
    };
    onUpdate({ chapters: updatedChapters, briefs: updatedBriefs });
    setNewCaseName(''); setNewCaseChapter('');
    setShowAddModal(false);
    setSelected(name);
  }

  function downloadDoc() {
    setDownloading(true);
    const html = window.LexStore.generateBriefsHTML(course);
    const blob = new Blob(['\uFEFF', html], { type: 'application/msword' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `${course.name} – Case Briefs.doc`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setTimeout(() => setDownloading(false), 1000);
  }

  const chapterOfSelected = selected
    ? chapters.find(ch => ch.cases?.includes(selected))
    : null;

  return (
    <div style={cb.root}>

      {/* ── LEFT PANEL ── */}
      <div style={cb.left}>

        {/* Header */}
        <div style={cb.leftHead}>
          <div style={cb.stats}>
            <span style={cb.statBig}>{completedCount}</span>
            <span style={cb.statSmall}>/ {totalCases} briefed</span>
          </div>
          <div style={{ display:'flex', gap:6 }}>
            <button
              style={cb.impBtn}
              onClick={openImport}
              title="Import briefs from text or a Word doc"
            >
              ↑ Import
            </button>
            <button
              style={{ ...cb.dlBtn, ...(downloading ? cb.dlBtnAnim : {}) }}
              onClick={downloadDoc}
              title="Download all briefs as a Word document"
            >
              {downloading ? '…' : '↓'} .doc
            </button>
          </div>
        </div>

        {/* Search */}
        <div style={cb.searchWrap}>
          <input
            style={cb.search}
            placeholder="Search cases…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {/* Case list */}
        <div style={cb.caseList}>
          {totalCases === 0 ? (
            <div style={cb.noData}>
              No cases yet. Add chapter content or add cases manually.
            </div>
          ) : groups.length === 0 ? (
            <div style={cb.noData}>No matches for "{search}".</div>
          ) : (
          groups.map(({ chapter, cases }) => {
              const isCollapsed = collapsedChs.has(chapter.id);
              return (
              <div key={chapter.id}>
                <button style={cb.groupLabelBtn} onClick={() => toggleChapter(chapter.id)}>
                  <span style={cb.groupLabelText}>{fmtTitle(chapter.title)}</span>
                  <span style={cb.groupChevron}>{isCollapsed ? '▶' : '▼'}</span>
                </button>
                {!isCollapsed && cases.map(caseName => {
                  const b         = briefs[caseName] || {};
                  const written   = b.facts || b.holding;
                  const isSel     = selected === caseName;
                  return (
                    <button
                      key={caseName}
                      style={{ ...cb.caseBtn, ...(isSel ? cb.caseBtnSel : {}) }}
                      onClick={() => setSelected(caseName)}
                    >
                      <span style={{ ...cb.dot, background: written ? '#4A7C59' : '#D0C8B0' }} />
                      <span style={{ ...cb.caseName2, color: isSel ? '#1A1714' : '#2C2416' }}>
                        {caseName}
                      </span>
                      {written && <span style={cb.checkMark}>✓</span>}
                    </button>
                  );
                })}
              </div>
              );
            })
          )}

          <button style={cb.addCaseBtn} onClick={() => setShowAddModal(true)}>
            + Add Case Manually
          </button>
        </div>
      </div>

      {/* ── RIGHT PANEL ── */}
      <div style={cb.right}>
        {!selected ? (
          <div style={cb.noSel}>
            <div style={{ fontSize: 52 }}>⚖</div>
            <div style={cb.noSelTitle}>Select a Case</div>
            <div style={cb.noSelDesc}>
              Choose a case from the list to begin writing your brief.
              Your work is saved automatically as you type.
            </div>
          </div>
        ) : (
          <div style={cb.editor}>
            {/* Brief header */}
            <div style={cb.edHead}>
              <div style={cb.edHeadLeft}>
                <div style={cb.edCaseName}>{selected}</div>
                {chapterOfSelected && (
                  <div style={cb.edChapter}>{chapterOfSelected.title}</div>
                )}
              </div>
              <div style={cb.edHeadRight}>
                {saveFlash && <span style={cb.savedFlash}>Saved ✓</span>}
                {isComplete && !saveFlash && (
                  <span style={cb.completeBadge}>Brief Complete ✓</span>
                )}
                <div style={cb.progressDots}>
                  {BRIEF_FIELDS.map(f => (
                    <span
                      key={f.key}
                      style={{ ...cb.fieldDot, background: currentBrief[f.key] ? '#4A7C59' : '#DDD6CC' }}
                      title={f.label}
                    />
                  ))}
                </div>
              </div>
            </div>

            {/* Fields */}
            <div style={cb.fields}>
              {BRIEF_FIELDS.map(f => (
                <div key={f.key} style={cb.fieldGroup}>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6 }}>
                    <label style={cb.fieldLabel}>{f.label}</label>
                    <button
                      style={{
                        ...cb.reviewBtn,
                        ...(reviewPanel?.fieldKey === f.key && !reviewPanel.loading ? cb.reviewBtnActive : {}),
                      }}
                      onClick={() => runRedFlagReview(f.key, f.label, currentBrief[f.key])}
                      disabled={!currentBrief[f.key]?.trim()}
                      title="AI Red Flag Review"
                    >
                      {reviewPanel?.fieldKey === f.key && reviewPanel.loading ? '…' : '🚩 Review'}
                    </button>
                  </div>
                  <textarea
                    style={{
                      ...cb.fieldTA,
                      borderColor: currentBrief[f.key] ? '#C8D8C0' : '#E2D9CC',
                    }}
                    value={currentBrief[f.key] || ''}
                    onChange={e => updateField(f.key, e.target.value)}
                    placeholder={f.placeholder}
                    rows={4}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Red Flag Review Panel ── */}
      {reviewPanel && (
        <div style={cb.reviewPanelWrap}>
          <div style={cb.reviewPanelHead}>
            <div>
              <span style={cb.reviewPanelIcon}>🚩</span>
              <span style={cb.reviewPanelTitle}>Red Flag Review</span>
              <span style={cb.reviewPanelField}>{reviewPanel.fieldLabel}</span>
            </div>
            <button style={cb.reviewPanelClose} onClick={() => setReviewPanel(null)}>✕</button>
          </div>
          <div style={cb.reviewPanelBody}>
            {reviewPanel.loading ? (
              <div style={cb.reviewLoading}>
                <div style={cb.reviewSpinner} />
                Reviewing…
              </div>
            ) : (
              <div style={cb.reviewResult}>
                {(reviewPanel.result || '').split('\n').filter(l => l.trim()).map((line, i) => (
                  <p key={i} style={{ margin:'0 0 8px', fontSize:13, color:'#2C2416', lineHeight:1.65 }}>{line}</p>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Import Modal ── */}
      {importOpen && (
        <div style={cb.overlay}>
          <div style={{ ...cb.modal, maxWidth: 680 }}>
            <div style={cb.modalHead}>
              <div style={cb.modalTitle}>
                {importStep === 'preview' ? 'Import Preview' : 'Import Case Briefs'}
              </div>
              <button style={cb.modalX} onClick={() => setImportOpen(false)}>✕</button>
            </div>

            {importStep === 'input' && (
              <>
                <div style={cb.modalBody}>
                  <div style={cb.impTabs}>
                    <button
                      style={{ ...cb.impTab, ...(importInputMode === 'paste' ? cb.impTabActive : {}) }}
                      onClick={() => setImportInputMode('paste')}
                    >
                      Paste Text
                    </button>
                    <button
                      style={{ ...cb.impTab, ...(importInputMode === 'upload' ? cb.impTabActive : {}) }}
                      onClick={() => setImportInputMode('upload')}
                    >
                      Upload File
                    </button>
                  </div>

                  {importInputMode === 'paste' ? (
                    <textarea
                      style={cb.impTextarea}
                      placeholder="Paste your briefs here. Include the case name and labels like Facts, Issue, Holding, etc. Typos are fine — AI will figure it out. Missing sections will be left blank on the website."
                      value={importText}
                      onChange={e => setImportText(e.target.value)}
                      rows={12}
                      autoFocus
                    />
                  ) : (
                    <div style={cb.impUploadArea}>
                      <input
                        ref={importFileRef}
                        type="file"
                        accept=".docx,.doc,.txt"
                        style={{ display:'none' }}
                        onChange={e => handleImportFile(e.target.files?.[0])}
                      />
                      <button style={cb.impUploadBtn} onClick={() => importFileRef.current?.click()}>
                        {importFileName ? 'Choose a different file' : 'Choose File'}
                      </button>
                      <div style={cb.impUploadText}>
                        {importFileName
                          ? <><strong style={{ color:'#2A6049' }}>✓ {importFileName}</strong> — ready to parse</>
                          : <>Accepts <code style={cb.impCode}>.docx</code>, <code style={cb.impCode}>.doc</code>, or <code style={cb.impCode}>.txt</code></>}
                      </div>
                      {importText && (
                        <div style={cb.impPreviewBox}>
                          {importText.slice(0, 500)}{importText.length > 500 ? '…' : ''}
                        </div>
                      )}
                    </div>
                  )}

                  {importError && <div style={cb.impError}>⚠ {importError}</div>}
                </div>
                <div style={cb.modalFoot}>
                  <button style={cb.btnGhost} onClick={() => setImportOpen(false)}>Cancel</button>
                  <button
                    style={cb.btnPrimary}
                    onClick={runImportParse}
                    disabled={!importText.trim()}
                  >
                    Parse with AI
                  </button>
                </div>
              </>
            )}

            {importStep === 'parsing' && (
              <div style={cb.impParsing}>
                <div style={cb.reviewSpinner} />
                <div style={cb.impParsingText}>
                  Reading your briefs…
                  <div style={cb.impParsingSub}>Usually takes 5–20 seconds.</div>
                </div>
              </div>
            )}

            {importStep === 'preview' && (
              <>
                <div style={{ ...cb.modalBody, maxHeight:'62vh', overflowY:'auto', paddingRight:18 }}>
                  <p style={cb.impDesc}>
                    Found <strong>{importParsed.length}</strong> {importParsed.length === 1 ? 'brief' : 'briefs'}. Review and confirm — nothing is saved until you click Import.
                  </p>
                  {importParsed.map(p => {
                    const a = importAssignments[p.caseName] || {};
                    const isExisting = !!a.existingKey;
                    const FIELDS = [
                      ['facts',             'Facts'],
                      ['proceduralHistory', 'Proc. History'],
                      ['issue',             'Issue'],
                      ['holding',           'Holding/Rule'],
                      ['reasoning',         'Reasoning'],
                    ];
                    return (
                      <div key={p.caseName} style={cb.impCaseCard}>
                        <div style={cb.impCaseHead}>
                          <div style={cb.impCaseName}>{p.caseName}</div>
                          <span style={{ ...cb.impBadge, ...(isExisting ? cb.impBadgeUpdate : cb.impBadgeNew) }}>
                            {isExisting ? 'EXISTING' : 'NEW'}
                          </span>
                        </div>
                        {isExisting && (
                          <div style={cb.impMatchNote}>
                            Matches existing case: <em>{a.existingKey}</em>
                          </div>
                        )}
                        <div style={cb.impFields}>
                          {FIELDS.map(([k, lbl]) => (
                            <span key={k} style={{ ...cb.impFieldTag, ...(p[k] ? cb.impFieldTagFilled : {}) }}>
                              {p[k] ? '✓' : '—'} {lbl}
                            </span>
                          ))}
                        </div>
                        {!isExisting && a.mode === 'add' && chapters.length > 0 && (
                          <div style={cb.impRow}>
                            <label style={cb.impRowLabel}>Chapter:</label>
                            <select
                              style={cb.impSelect}
                              value={a.chapter || ''}
                              onChange={e => setAssignment(p.caseName, { chapter: e.target.value })}
                            >
                              {chapters.map(ch => (
                                <option key={ch.id} value={ch.id}>{ch.title}</option>
                              ))}
                            </select>
                          </div>
                        )}
                        <div style={cb.impModes}>
                          {isExisting ? (
                            <>
                              <label style={cb.impRadio}>
                                <input type="radio" checked={a.mode === 'fill'}
                                  onChange={() => setAssignment(p.caseName, { mode: 'fill' })} />
                                Fill empty fields only
                              </label>
                              <label style={cb.impRadio}>
                                <input type="radio" checked={a.mode === 'replace'}
                                  onChange={() => setAssignment(p.caseName, { mode: 'replace' })} />
                                Replace all fields
                              </label>
                              <label style={cb.impRadio}>
                                <input type="radio" checked={a.mode === 'skip'}
                                  onChange={() => setAssignment(p.caseName, { mode: 'skip' })} />
                                Skip
                              </label>
                            </>
                          ) : (
                            <>
                              <label style={{ ...cb.impRadio, ...(chapters.length === 0 ? { opacity:0.5 } : {}) }}>
                                <input type="radio" checked={a.mode === 'add'}
                                  disabled={chapters.length === 0}
                                  onChange={() => setAssignment(p.caseName, { mode: 'add' })} />
                                Add as new case{chapters.length === 0 ? ' (add a chapter first)' : ''}
                              </label>
                              <label style={cb.impRadio}>
                                <input type="radio" checked={a.mode === 'skip'}
                                  onChange={() => setAssignment(p.caseName, { mode: 'skip' })} />
                                Skip
                              </label>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={cb.modalFoot}>
                  <button style={cb.btnGhost} onClick={() => setImportStep('input')}>← Back</button>
                  {(() => {
                    const n = importParsed.filter(p => (importAssignments[p.caseName]?.mode || 'skip') !== 'skip').length;
                    return (
                      <button style={{ ...cb.btnPrimary, opacity: n ? 1 : 0.4 }} disabled={!n} onClick={commitImport}>
                        Import {n} {n === 1 ? 'Brief' : 'Briefs'}
                      </button>
                    );
                  })()}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Add Case Modal ── */}
      {showAddModal && (
        <div style={cb.overlay}>
          <div style={cb.modal}>
            <div style={cb.modalHead}>
              <div style={cb.modalTitle}>Add Case Manually</div>
              <button style={cb.modalX} onClick={() => { setShowAddModal(false); setNewCaseName(''); }}>✕</button>
            </div>
            <div style={cb.modalBody}>
              <div style={cb.mFieldGroup}>
                <label style={cb.mLabel}>Case Name</label>
                <input
                  style={cb.mInput}
                  placeholder="e.g. Pennoyer v. Neff"
                  value={newCaseName}
                  onChange={e => setNewCaseName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addCase()}
                  autoFocus
                />
              </div>
              {chapters.length > 0 && (
                <div style={cb.mFieldGroup}>
                  <label style={cb.mLabel}>Chapter</label>
                  <select
                    style={cb.mSelect}
                    value={newCaseChapter || chapters[0]?.id || ''}
                    onChange={e => setNewCaseChapter(e.target.value)}
                  >
                    {chapters.map(ch => (
                      <option key={ch.id} value={ch.id}>{ch.title}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div style={cb.modalFoot}>
              <button style={cb.btnGhost} onClick={() => { setShowAddModal(false); setNewCaseName(''); }}>Cancel</button>
              <button style={cb.btnPrimary} onClick={addCase} disabled={!newCaseName.trim()}>Add Case</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const cb = {
  root:  { flex:1, display:'flex', overflow:'hidden' },
  // Left
  left:     { width:272, minWidth:272, display:'flex', flexDirection:'column', background:'#FFFFFF', borderRight:'1px solid #E2D9CC' },
  leftHead: { padding:'14px 18px', borderBottom:'1px solid #E2D9CC', display:'flex', alignItems:'center', justifyContent:'space-between' },
  stats:    { display:'flex', alignItems:'baseline', gap:4 },
  statBig:  { fontFamily:'"Lora", "Lora", Georgia, serif', fontSize:26, fontWeight:700, color:'#1A1714' },
  statSmall:{ fontSize:12.5, color:'#5A4538' },
  dlBtn:    { padding:'5px 12px', background:'#1A1714', color:'#FFFFFF', border:'none', borderRadius:5, fontSize:11.5, fontWeight:700, cursor:'pointer', letterSpacing:'.4px' },
  dlBtnAnim:{ opacity:.6 },
  searchWrap:{ padding:'9px 12px', borderBottom:'1px solid #E2D9CC' },
  search:   { width:'100%', boxSizing:'border-box', padding:'7px 10px', borderRadius:6, border:'1px solid #DDD6CC', fontSize:12.5, background:'white', outline:'none' },
  caseList: { flex:1, overflowY:'auto', padding:'6px 0 20px' },
  noData:   { padding:'20px 18px', fontSize:12.5, color:'#5A4538', lineHeight:1.6 },
  groupLabelBtn: { display:'flex', alignItems:'center', justifyContent:'space-between', width:'100%', padding:'12px 18px 6px', background:'none', border:'none', cursor:'pointer', textAlign:'left', borderTop:'1px solid #E2D9CC', marginTop:4 },
  groupLabelText:{ fontSize:11.5, fontWeight:700, color:'#1A1714', letterSpacing:'0.3px' },
  groupChevron:  { fontSize:9, color:'#2A6049', opacity:0.8, flexShrink:0 },
  reviewBtn:       { padding:'3px 9px', background:'white', border:'1px solid #DDD6CC', borderRadius:4, fontSize:11, color:'#5A4538', cursor:'pointer', flexShrink:0, transition:'all .1s' },
  reviewBtnActive: { background:'#FEF0EE', borderColor:'#C0392B', color:'#C0392B' },
  // Review panel
  reviewPanelWrap:  { position:'fixed', right:0, top:0, bottom:0, width:280, background:'white', borderLeft:'1px solid #E2D9CC', boxShadow:'-6px 0 24px rgba(26,39,68,.1)', zIndex:500, display:'flex', flexDirection:'column' },
  reviewPanelHead:  { padding:'14px 18px', background:'#F5EFE6', borderBottom:'1px solid #E2D9CC', display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:8 },
  reviewPanelIcon:  { fontSize:14, marginRight:6 },
  reviewPanelTitle: { fontFamily:'"Lora", "Lora", Georgia, serif', fontSize:13.5, fontWeight:700, color:'#1A1714', marginRight:6 },
  reviewPanelField: { fontSize:11.5, color:'#5A4538', fontStyle:'italic' },
  reviewPanelClose: { background:'none', border:'none', fontSize:15, color:'#5A4538', cursor:'pointer', flexShrink:0, padding:0 },
  reviewPanelBody:  { flex:1, overflowY:'auto', padding:'16px 18px' },
  reviewLoading:    { display:'flex', flexDirection:'column', alignItems:'center', gap:14, paddingTop:40, color:'#5A4538', fontSize:13 },
  reviewSpinner:    { width:24, height:24, border:'3px solid #E8D5A0', borderTopColor:'#2A6049', borderRadius:'50%', animation:'spin 0.8s linear infinite' },
  reviewResult:     { fontSize:13, lineHeight:1.65 },
  caseBtn:  { display:'flex', alignItems:'center', gap:8, width:'100%', padding:'7px 18px', background:'none', border:'none', cursor:'pointer', textAlign:'left', transition:'background .1s' },
  caseBtnSel:{ background:'rgba(26,39,68,.07)' },
  dot:      { width:7, height:7, borderRadius:'50%', flexShrink:0, transition:'background .2s' },
  caseName2:{ fontSize:13, fontStyle:'italic', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  checkMark:{ fontSize:11, color:'#4A7C59', fontWeight:700, flexShrink:0 },
  addCaseBtn:{ width:'100%', padding:'10px 18px', background:'none', border:'none', borderTop:'1px solid #E2D9CC', color:'#2A6049', fontSize:12.5, cursor:'pointer', textAlign:'left', marginTop:8 },
  // Right
  right:    { flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:'#F8F6F1' },
  noSel:    { flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:14, padding:48, textAlign:'center' },
  noSelTitle:{ fontFamily:'"Lora", "Lora", Georgia, serif', fontSize:22, fontWeight:700, color:'#1A1714' },
  noSelDesc: { fontSize:13.5, color:'#4A3D2E', maxWidth:340, lineHeight:1.65 },
  editor:   { flex:1, display:'flex', flexDirection:'column', overflow:'hidden' },
  edHead:   { padding:'18px 30px', background:'white', borderBottom:'1px solid #E2D9CC', display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:16 },
  edHeadLeft:{},
  edCaseName:{ fontFamily:'"Lora", "Lora", Georgia, serif', fontSize:21, fontWeight:700, color:'#1A1714', fontStyle:'italic' },
  edChapter: { fontSize:11.5, color:'#5A4538', marginTop:3 },
  edHeadRight:{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:6, flexShrink:0 },
  savedFlash:{ fontSize:11.5, color:'#4A7C59', fontWeight:600 },
  completeBadge:{ fontSize:11.5, color:'#4A7C59', background:'#EFF8F1', padding:'3px 9px', borderRadius:4, border:'1px solid #C3E6CB', fontWeight:600 },
  progressDots:{ display:'flex', gap:4 },
  fieldDot: { width:8, height:8, borderRadius:'50%', display:'inline-block', transition:'background .2s' },
  fields:   { flex:1, overflowY:'auto', padding:'22px 30px', display:'flex', flexDirection:'column', gap:18 },
  fieldGroup:{ display:'flex', flexDirection:'column', gap:6 },
  fieldLabel:{ fontSize:10.5, fontWeight:700, color:'#2A6049', textTransform:'uppercase', letterSpacing:'.7px' },
  fieldTA:  { padding:'10px 12px', borderRadius:6, border:'1.5px solid', fontSize:13.5, fontFamily:'"Lora", Georgia, serif', lineHeight:1.65, resize:'vertical', background:'white', outline:'none', transition:'border-color .2s' },
  // Modal
  overlay:  { position:'fixed', inset:0, background:'rgba(26,39,68,.52)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000, backdropFilter:'blur(2px)' },
  modal:    { background:'#FFFFFF', borderRadius:12, width:'90%', maxWidth:460, boxShadow:'0 24px 64px rgba(26,39,68,.28)', overflow:'hidden' },
  modalHead:{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'17px 22px', borderBottom:'1px solid #E2D9CC', background:'#F5EFE6' },
  modalTitle:{ fontFamily:'"Lora", "Lora", Georgia, serif', fontSize:16.5, fontWeight:700, color:'#1A1714' },
  modalX:   { background:'none', border:'none', fontSize:16, color:'#5A4538', cursor:'pointer' },
  modalBody:{ padding:'20px 22px 12px' },
  modalFoot:{ padding:'14px 22px', borderTop:'1px solid #E2D9CC', display:'flex', gap:8, justifyContent:'flex-end' },
  mFieldGroup:{ marginBottom:15 },
  mLabel:   { display:'block', fontSize:10.5, fontWeight:700, color:'#2A6049', textTransform:'uppercase', letterSpacing:'.7px', marginBottom:6 },
  mInput:   { width:'100%', boxSizing:'border-box', padding:'9px 12px', borderRadius:6, border:'1px solid #DDD6CC', fontSize:14, fontFamily:'"Lora", Georgia, serif', fontStyle:'italic', background:'white', outline:'none' },
  mSelect:  { width:'100%', padding:'9px 12px', borderRadius:6, border:'1px solid #DDD6CC', fontSize:13, background:'white', outline:'none' },
  btnPrimary:{ padding:'9px 20px', background:'#1A1714', color:'#FFFFFF', border:'none', borderRadius:6, fontSize:13, fontWeight:600, cursor:'pointer' },
  btnGhost: { padding:'9px 20px', background:'none', color:'#4A3D30', border:'1px solid #DDD6CC', borderRadius:6, fontSize:13, cursor:'pointer' },

  // ── Import ──
  impBtn:   { padding:'5px 12px', background:'white', color:'#1A1714', border:'1px solid #1A1714', borderRadius:5, fontSize:11.5, fontWeight:700, cursor:'pointer', letterSpacing:'.4px' },
  impTabs:  { display:'flex', gap:4, marginBottom:14, borderBottom:'1px solid #E2D9CC' },
  impTab:   { padding:'8px 16px', background:'none', border:'none', borderBottom:'2px solid transparent', fontSize:13, fontWeight:600, color:'#8B7355', cursor:'pointer', marginBottom:-1 },
  impTabActive:{ color:'#1A1714', borderBottomColor:'#2A6049' },
  impTextarea:{ width:'100%', boxSizing:'border-box', padding:'11px 13px', borderRadius:6, border:'1px solid #DDD6CC', fontSize:13, fontFamily:'"Lora", Georgia, serif', lineHeight:1.6, background:'white', outline:'none', resize:'vertical', minHeight:240 },
  impUploadArea:{ display:'flex', flexDirection:'column', alignItems:'flex-start', gap:12, padding:'18px 4px' },
  impUploadBtn: { padding:'9px 18px', background:'#2A6049', color:'white', border:'none', borderRadius:6, fontSize:13, fontWeight:600, cursor:'pointer' },
  impUploadText:{ fontSize:12.5, color:'#5A4538' },
  impCode:  { background:'#F5EFE6', padding:'1px 5px', borderRadius:3, fontSize:11.5, fontFamily:'monospace', color:'#1A1714' },
  impPreviewBox:{ width:'100%', maxHeight:140, overflowY:'auto', padding:'10px 12px', background:'#F8F6F1', border:'1px solid #E2D9CC', borderRadius:6, fontSize:12, color:'#4A3D2E', lineHeight:1.55, whiteSpace:'pre-wrap', fontFamily:'"Lora", Georgia, serif' },
  impError: { marginTop:14, padding:'9px 12px', background:'#FEF0EE', border:'1px solid #F5C6C2', borderRadius:6, color:'#C0392B', fontSize:12.5 },
  impParsing:{ padding:'48px 22px 52px', display:'flex', flexDirection:'column', alignItems:'center', gap:18 },
  impParsingText:{ fontSize:14, fontWeight:600, color:'#1A1714', textAlign:'center' },
  impParsingSub: { fontSize:12, color:'#5A4538', fontWeight:400, marginTop:4 },
  impDesc:  { fontSize:13, color:'#3A3020', lineHeight:1.55, marginBottom:14 },
  impCaseCard:{ border:'1px solid #E2D9CC', borderRadius:8, padding:'12px 14px', marginBottom:10, background:'#FDFBF7' },
  impCaseHead:{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:10, marginBottom:6 },
  impCaseName:{ fontFamily:'"Lora", Georgia, serif', fontSize:15, fontWeight:700, fontStyle:'italic', color:'#1A1714', flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  impBadge: { fontSize:10, fontWeight:700, letterSpacing:'.6px', padding:'3px 7px', borderRadius:3, flexShrink:0 },
  impBadgeNew:   { background:'#E8F2EC', color:'#2A6049', border:'1px solid #B8D4C2' },
  impBadgeUpdate:{ background:'#FBF2DC', color:'#8B6914', border:'1px solid #E8D5A0' },
  impMatchNote:{ fontSize:11.5, color:'#5A4538', marginBottom:8 },
  impFields:{ display:'flex', flexWrap:'wrap', gap:5, marginBottom:10 },
  impFieldTag:{ fontSize:11, padding:'3px 8px', borderRadius:3, background:'#EFEAE0', color:'#8B7355', fontWeight:500 },
  impFieldTagFilled:{ background:'#E8F2EC', color:'#2A6049', fontWeight:600 },
  impRow:   { display:'flex', alignItems:'center', gap:8, marginBottom:8 },
  impRowLabel:{ fontSize:11.5, fontWeight:700, color:'#5A4538', textTransform:'uppercase', letterSpacing:'.4px' },
  impSelect:{ flex:1, padding:'5px 8px', borderRadius:4, border:'1px solid #DDD6CC', fontSize:12.5, background:'white', outline:'none' },
  impModes: { display:'flex', flexWrap:'wrap', gap:14, paddingTop:6, borderTop:'1px dashed #E2D9CC' },
  impRadio: { display:'flex', alignItems:'center', gap:5, fontSize:12.5, color:'#2C2416', cursor:'pointer' },
};

Object.assign(window, { CaseBriefsTab });
