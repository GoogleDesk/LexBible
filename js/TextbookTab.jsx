
// Normalize chapter title format: "Chapter N — Title" → "Chapter N: Title"
function fmtTitle(t) {
  return (t || '').replace(/\s+[\u2014\u2013\-]{1,2}\s+/, ': ');
}
// TextbookTab — TOC builder, chapter content, AI cleaning
const { useState: useTBState, useRef: useTBRef } = React;

// ── File parsers (DOCX + PDF) loaded on demand ────────────────────────────────
async function parseDOCXFile(file) {
  if (!window.JSZip) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js';
      s.onload = res; s.onerror = () => rej(new Error('Failed to load JSZip'));
      document.head.appendChild(s);
    });
  }
  const ab = await file.arrayBuffer();
  const zip = await window.JSZip.loadAsync(ab);
  const xmlFile = zip.file('word/document.xml');
  if (!xmlFile) throw new Error('Not a valid DOCX file.');
  const xml = await xmlFile.async('string');
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  let text = '';
  let pageNum = 1;

  function getNodeText(node) {
    let out = '';
    for (const child of node.childNodes) {
      const local = child.localName;
      if (local === 'br') {
        const bType = child.getAttributeNS(W, 'type');
        if (bType === 'page') { pageNum++; out += `\n[Page ${pageNum}]\n`; }
        else out += '\n';
      } else if (local === 'lastRenderedPageBreak') {
        pageNum++; out += `\n[Page ${pageNum}]\n`;
      } else if (local === 't') {
        out += child.textContent;
      } else {
        out += getNodeText(child);
      }
    }
    return out;
  }

  const paras = doc.getElementsByTagNameNS(W, 'p');
  for (const p of paras) {
    const t = getNodeText(p).trimEnd();
    text += t + '\n';
  }
  return `[Page 1]\n` + text.trim();
}

async function parsePDFFile(file) {
  if (!window.pdfjsLib) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s.onload = res; s.onerror = () => rej(new Error('Failed to load PDF.js'));
      document.head.appendChild(s);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  const ab = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: ab }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim();
    if (pageText) text += `[Page ${i}]\n${pageText}\n\n`;
  }
  return text.trim();
}

function TextbookTab({ course, onUpdate, onRegisterActions, onNavigateToCase }) {
  const [showTOCModal,     setShowTOCModal]     = useTBState(false);
  const [showContentModal, setShowContentModal] = useTBState(null);
  const [showAddChapter,   setShowAddChapter]   = useTBState(false);
  const [expandedChapter,  setExpandedChapter]  = useTBState(null);
  const [tocText,          setTocText]          = useTBState('');
  const [contentText,      setContentText]      = useTBState('');
  const [newChapterTitle,  setNewChapterTitle]  = useTBState('');
  const [phase,            setPhase]            = useTBState('idle'); // idle | cleaning | parsing | saving
  const [statusMsg,        setStatusMsg]        = useTBState('');
  const [draggedId,        setDraggedId]        = useTBState(null);

  const chapters = course.chapters || [];
  const hasApiKey = !!window.LexStore.loadApiKey();

  // ── TOC: clean then parse ─────────────────────────────────────────────────
  async function handleParseTOC() {
    if (!tocText.trim()) return;
    try {
      setPhase('cleaning');
      setStatusMsg(hasApiKey ? 'Claude is reading and extracting chapters…' : 'Applying basic cleanup…');

      let parsedChapters;

      if (hasApiKey) {
        parsedChapters = await window.LexStore.aiCleanTOC(tocText);
      } else {
        setStatusMsg('Building chapter menu…');
        await new Promise(r => setTimeout(r, 300));
        parsedChapters = window.LexStore.parseTOC(window.LexStore.basicCleanTOC(tocText));
      }

      setPhase('parsing');
      setStatusMsg('Saving…');

      // No cases from TOC — cases are extracted from chapter content only
      onUpdate({ chapters: parsedChapters });
      setShowTOCModal(false);
      setTocText('');
    } catch (err) {
      setStatusMsg('Error: ' + (err.message || 'Unknown error'));
      await new Promise(r => setTimeout(r, 3500));
    }
    setPhase('idle');
    setStatusMsg('');
  }

  // ── Content: clean then save ──────────────────────────────────────────────
  async function handleSaveContent(chapterId, newTitle) {
    const ch = chapters.find(c => c.id === chapterId);
    if (!ch) return;
    const trimmedTitle = (newTitle || '').trim();
    const titleToUse   = trimmedTitle || ch.title;
    const titleChanged = !!trimmedTitle && trimmedTitle !== ch.title;
    const hasContent   = contentText.trim().length > 0;

    if (!hasContent && !titleChanged) {
      setShowContentModal(null);
      setContentText('');
      return;
    }

    // Rename-only path: chapter has no new content to process.
    if (!hasContent) {
      onUpdate({
        chapters: chapters.map(c => c.id === chapterId ? { ...c, title: titleToUse } : c),
      });
      setShowContentModal(null);
      setContentText('');
      return;
    }

    try {
      // Always use basic cleanup for content — fast, free, good enough.
      // Claude reads the content for quiz generation and handles minor messiness fine.
      setPhase('cleaning');
      setStatusMsg('Saving chapter…');
      const cleaned = window.LexStore.basicCleanContent(contentText);

      setPhase('saving');
      setStatusMsg('Extracting fully-presented cases…');

      // Only extract cases with court + citation (fully presented, not mere references)
      const extracted = window.LexStore.extractCasesFromContent(cleaned);
      const allCases = [...new Set([...(ch.cases || []), ...extracted])];
      const newBriefs = { ...(course.briefs || {}) };
      allCases.forEach(c => { if (!newBriefs[c]) newBriefs[c] = emptyBrief(chapterId); });

      onUpdate({
        chapters: chapters.map(c =>
          c.id === chapterId
            ? { ...c, title: titleToUse, content: cleaned, cases: allCases, contentStatus: 'complete' }
            : c
        ),
        briefs: newBriefs,
      });
      setShowContentModal(null);
      setContentText('');
    } catch (err) {
      setStatusMsg('Error: ' + (err.message || 'Unknown error'));
      await new Promise(r => setTimeout(r, 3500));
    }
    setPhase('idle');
    setStatusMsg('');
  }

  function handleAddCustomChapter() {
    if (!newChapterTitle.trim()) return;
    const ch = {
      id: window.LexStore.genId(), title: newChapterTitle.trim(),
      number: chapters.length + 1, isCustom: true,
      sections: [], content: '', cases: [], contentStatus: 'empty',
    };
    onUpdate({ chapters: [...chapters, ch] });
    setNewChapterTitle(''); setShowAddChapter(false);
  }

  function handleDeleteChapter(chId) {
    if (!confirm('Delete this chapter and all its data?')) return;
    onUpdate({ chapters: chapters.filter(c => c.id !== chId) });
  }

  function handleDragOverChapter(targetId) {
    if (!draggedId || draggedId === targetId) return;
    const fromIdx = chapters.findIndex(c => c.id === draggedId);
    const toIdx   = chapters.findIndex(c => c.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...chapters];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    onUpdate({ chapters: next.map((c, i) => ({ ...c, number: i + 1 })) });
  }

  function openContentModal(chId) {
    const ch = chapters.find(c => c.id === chId);
    setContentText(ch?.content || '');
    setShowContentModal(chId);
  }

  const busy = phase !== 'idle';

  // Register header actions for CourseView to render in the title bar
  React.useEffect(() => {
    onRegisterActions?.({
      replaceTOC: () => setShowTOCModal(true),
      addChapter: () => setShowAddChapter(true),
    });
  }, []);

  // ── Empty state ───────────────────────────────────────────────────────────
  if (chapters.length === 0) {
    return (
      <div style={tbS.empty}>
        <div style={tbS.emptyShield}>📖</div>
        <div style={tbS.emptyHeading}>Set Up Your Textbook</div>
        <div style={tbS.emptyBody}>
          Copy your table of contents from the e-textbook and paste it below.
          {hasApiKey
            ? ' Claude will clean and structure it automatically.'
            : ' Basic formatting will be applied. Add your API key (⚙ in the sidebar) for full AI cleanup.'}
        </div>
        <button style={tbS.btnPrimary} onClick={() => setShowTOCModal(true)}>
          Paste Table of Contents →
        </button>
        {!hasApiKey && (
          <div style={tbS.noKeyNote}>
            ⚙ No API key set — AI cleanup is enhanced with a key. Basic cleanup still works.
          </div>
        )}
        {showTOCModal && (
          <TOCModal
            tocText={tocText} setTocText={setTocText}
            onSubmit={handleParseTOC}
            onClose={() => { setShowTOCModal(false); setTocText(''); setPhase('idle'); setStatusMsg(''); }}
            busy={busy} statusMsg={statusMsg} hasApiKey={hasApiKey}
          />
        )}
      </div>
    );
  }

  return (
    <div style={tbS.root}>
      <div style={tbS.list}>
        {chapters.map(ch => (
          <ChapterCard
            key={ch.id} chapter={ch}
            expanded={expandedChapter === ch.id}
            onExpand={() => setExpandedChapter(expandedChapter === ch.id ? null : ch.id)}
            onEditChapter={() => openContentModal(ch.id)}
            onDelete={() => handleDeleteChapter(ch.id)}
            isDragged={draggedId === ch.id}
            isDragActive={draggedId !== null}
            onDragStart={() => setDraggedId(ch.id)}
            onDragOverCard={() => handleDragOverChapter(ch.id)}
            onDragEnd={() => setDraggedId(null)}
            briefsDone={(ch.cases || []).filter(c => { const b = (course.briefs || {})[c]; return b && (b.facts || b.holding); }).length}
            briefsTotal={(ch.cases || []).length}
            onNavigateToCase={onNavigateToCase}
          />
        ))}

        {showAddChapter ? (
          <div style={tbS.addCard}>
            <input
              style={tbS.addInput}
              placeholder="e.g. Appendix: Model Penal Code"
              value={newChapterTitle}
              onChange={e => setNewChapterTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAddCustomChapter(); if (e.key === 'Escape') setShowAddChapter(false); }}
              autoFocus
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={tbS.btnPrimary} onClick={handleAddCustomChapter}>Add Chapter</button>
              <button style={tbS.btnGhost}   onClick={() => { setShowAddChapter(false); setNewChapterTitle(''); }}>Cancel</button>
            </div>
          </div>
        ) : (
          <button style={tbS.addTrigger} onClick={() => setShowAddChapter(true)}>
            + Add Custom Chapter
          </button>
        )}
      </div>

      {showTOCModal && (
        <TOCModal
          tocText={tocText} setTocText={setTocText}
          onSubmit={handleParseTOC}
          onClose={() => { setShowTOCModal(false); setTocText(''); setPhase('idle'); setStatusMsg(''); }}
          busy={busy} statusMsg={statusMsg} hasApiKey={hasApiKey}
        />
      )}
      {showContentModal && (
        <ContentModal
          chapter={chapters.find(c => c.id === showContentModal)}
          value={contentText} onChange={setContentText}
          onSubmit={(newTitle) => handleSaveContent(showContentModal, newTitle)}
          onClose={() => { setShowContentModal(null); setContentText(''); setPhase('idle'); setStatusMsg(''); }}
          busy={busy} statusMsg={statusMsg} hasApiKey={hasApiKey}
        />
      )}
    </div>
  );
}

// ── Chapter Card ──────────────────────────────────────────────────────────────
function ChapterCard({ chapter, expanded, onExpand, onEditChapter, onDelete, isDragged, isDragActive, onDragStart, onDragOverCard, onDragEnd, briefsDone = 0, briefsTotal = 0, onNavigateToCase }) {
  const hasContent = chapter.contentStatus === 'complete';
  const caseCount  = chapter.cases?.length || 0;

  function handleHandleDragStart(e) {
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', chapter.id); } catch (_) { /* Firefox quirk */ }
    onDragStart?.();
  }
  function handleCardDragOver(e) {
    if (!isDragActive) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    onDragOverCard?.();
  }

  return (
    <div
      style={{ ...tbS.card, ...(expanded ? tbS.cardOpen : {}), ...(isDragged ? tbS.cardDragging : {}) }}
      onDragOver={handleCardDragOver}
      onDrop={(e) => { if (isDragActive) e.preventDefault(); }}
    >
      <div style={tbS.cardHeader} onClick={onExpand}>
        <div
          style={{ ...tbS.chNum, ...tbS.chNumHandle, ...(isDragged ? tbS.chNumDragging : {}) }}
          draggable={true}
          onDragStart={handleHandleDragStart}
          onDragEnd={() => onDragEnd?.()}
          onClick={e => e.stopPropagation()}
          title="Drag to reorder"
          aria-label={`Drag handle for chapter ${chapter.number}`}
        >
          {chapter.number}
        </div>
        <div style={tbS.cardInfo}>
          <div style={tbS.cardTitle}>{fmtTitle(chapter.title)}</div>
          <div style={tbS.cardMeta}>
            {chapter.isCustom && <span style={tbS.customTag}>Custom</span>}
            {hasContent && briefsTotal > 0
              ? <span style={{ color: briefsDone === briefsTotal ? '#4A7C59' : '#4A7C59', fontWeight: 500 }}>{briefsDone}/{briefsTotal} cases briefed</span>
              : hasContent
                ? <span style={{ color: '#5A4538' }}>No cases found</span>
                : <span style={{ color: '#2A6049', fontWeight: 500 }}>No content yet</span>
            }
          </div>
        </div>
        <div style={tbS.cardBtns} onClick={e => e.stopPropagation()}>
          <button style={tbS.iconBtn} onClick={onEditChapter} title="Edit chapter">✎</button>
          <button style={{ ...tbS.iconBtn, color: '#C0392B' }} onClick={onDelete} title="Delete chapter">✕</button>
        </div>
        <span style={{ ...tbS.chevron, ...(expanded ? tbS.chevronOpen : {}) }}>›</span>
      </div>

      {expanded && (
        <div style={tbS.cardBody}>
          {caseCount > 0 && (
            <div style={tbS.casesArea}>
              <div style={tbS.casesLabel}>Cases in this chapter</div>
              <div style={tbS.caseTags}>
                {chapter.cases.map((c, i) => (
                  <button key={i} style={{ ...tbS.caseTag, cursor: onNavigateToCase ? 'pointer' : 'default', ...(onNavigateToCase ? { borderColor:'#2A6049', color:'#1A1714' } : {}) }}
                    onClick={() => onNavigateToCase?.(c)}
                    title={onNavigateToCase ? `Open brief for ${c}` : undefined}
                  >{c}</button>
                ))}
              </div>
            </div>
          )}
          {caseCount === 0 && hasContent && (
            <div style={{ fontSize: 12.5, color: '#5A4538', fontStyle: 'italic' }}>
              No cases detected — you can add them manually in the Case Briefs tab.
            </div>
          )}
          {!hasContent && (
            <button style={{ ...tbS.btnPrimary, marginTop: 14 }} onClick={onEditChapter}>
              + Paste Chapter Content
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── TOC Modal ─────────────────────────────────────────────────────────────────
function TOCModal({ tocText, setTocText, onSubmit, onClose, busy, statusMsg, hasApiKey }) {
  const [fileLoading, setFileLoading] = useTBState(false);
  const [fileError,   setFileError]   = useTBState('');
  const fileRef = useTBRef(null);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileError('');
    setFileLoading(true);
    try {
      let extracted = '';
      if (file.name.endsWith('.docx')) {
        extracted = await parseDOCXFile(file);
      } else if (file.name.endsWith('.pdf')) {
        extracted = await parsePDFFile(file);
      } else {
        throw new Error('Unsupported file type. Please upload a .docx or .pdf file.');
      }
      setTocText(extracted);
    } catch (err) {
      setFileError(err.message || 'Failed to parse file.');
    } finally {
      setFileLoading(false);
      e.target.value = '';
    }
  }

  return (
    <div style={tbS.overlay}>
      <div style={tbS.modal}>
        <div style={tbS.modalHead}>
          <div style={tbS.modalTitle}>Paste Table of Contents</div>
          <button style={tbS.modalX} onClick={onClose} disabled={busy}>✕</button>
        </div>
        <div style={tbS.modalBody}>
          <p style={tbS.modalDesc}>
            Copy your full TOC from the e-textbook and paste below, or upload a <strong>.docx</strong> or <strong>.pdf</strong>.
            {hasApiKey
              ? ' Claude will clean up page numbers, formatting issues, and HTML entities automatically before building the menu.'
              : ' Basic cleanup will remove page numbers and fix encoding. For deeper AI cleanup, add your API key via ⚙ in the sidebar.'}
          </p>

          {/* Upload row */}
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
            <button
              style={{ ...tbS.btnSecondary, fontSize:12.5, padding:'7px 14px', flexShrink:0 }}
              onClick={() => fileRef.current?.click()}
              disabled={busy || fileLoading}
            >
              {fileLoading ? '⏳ Parsing…' : '↑ Upload .docx / .pdf'}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".docx,.pdf"
              style={{ display:'none' }}
              onChange={handleFile}
            />
            {tocText && !fileLoading && (
              <span style={{ fontSize:12, color:'#4A7C59' }}>✓ {tocText.length.toLocaleString()} chars loaded</span>
            )}
            {fileError && (
              <span style={{ fontSize:12, color:'#C0392B' }}>⚠ {fileError}</span>
            )}
          </div>

          <textarea
            style={tbS.textarea}
            value={tocText}
            onChange={e => setTocText(e.target.value)}
            placeholder={"Paste your raw TOC here — page numbers, messy formatting and all…\n\nOr use the upload button above for .docx / .pdf files."}
            rows={16}
            disabled={busy || fileLoading}
          />
          {busy && <div style={tbS.statusBar}>{statusMsg}</div>}
        </div>
        <div style={tbS.modalFoot}>
          <button style={tbS.btnGhost}   onClick={onClose} disabled={busy}>Cancel</button>
          <button style={tbS.btnPrimary} onClick={onSubmit} disabled={!tocText.trim() || busy || fileLoading}>
            {busy ? statusMsg || 'Working…' : (hasApiKey ? '✦ Clean & Build Menu →' : 'Build Menu →')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Content Modal ─────────────────────────────────────────────────────────────
function ContentModal({ chapter, value, onChange, onSubmit, onClose, busy, statusMsg, hasApiKey }) {
  const [fileLoading, setFileLoading] = useTBState(false);
  const [fileError,   setFileError]   = useTBState('');
  const [draftTitle,  setDraftTitle]  = useTBState(chapter?.title || '');
  const [titleFocused, setTitleFocused] = useTBState(false);
  const fileRef = useTBRef(null);

  React.useEffect(() => { setDraftTitle(chapter?.title || ''); }, [chapter?.id]);

  const trimmedTitle = draftTitle.trim();
  const titleChanged = !!trimmedTitle && trimmedTitle !== chapter?.title;
  const canSave      = !busy && !fileLoading && (value.trim().length > 0 || titleChanged);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileError('');
    setFileLoading(true);
    try {
      let extracted = '';
      if (file.name.endsWith('.docx')) {
        extracted = await parseDOCXFile(file);
      } else if (file.name.endsWith('.pdf')) {
        extracted = await parsePDFFile(file);
      } else {
        throw new Error('Unsupported file type. Please upload a .docx or .pdf file.');
      }
      onChange(extracted);
    } catch (err) {
      setFileError(err.message || 'Failed to parse file.');
    } finally {
      setFileLoading(false);
      e.target.value = '';
    }
  }

  return (
    <div style={tbS.overlay}>
      <div style={{ ...tbS.modal, maxWidth: 800 }}>
        <div style={tbS.modalHead}>
          <input
            style={{ ...tbS.modalTitleInput, ...(titleFocused ? tbS.modalTitleInputFocused : {}) }}
            value={draftTitle}
            onChange={e => setDraftTitle(e.target.value)}
            onFocus={e => { setTitleFocused(true); e.target.select(); }}
            onBlur={() => setTitleFocused(false)}
            onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
            disabled={busy}
            placeholder="Chapter name"
            aria-label="Chapter name"
          />
          <button style={tbS.modalX} onClick={onClose} disabled={busy}>✕</button>
        </div>
        <div style={tbS.modalBody}>
          <p style={tbS.modalDesc}>
            Paste raw chapter text, or upload a <strong>.docx</strong> or <strong>.pdf</strong> file.
            Page numbers (inline or from file) are preserved as <code style={{ background:'#F5EFE6', padding:'1px 5px', borderRadius:3, fontSize:12 }}>[Page N]</code> markers so you can focus quizzes on specific pages later.
            {hasApiKey
              ? ' Claude will clean and structure the text and extract cases automatically.'
              : ' Basic cleanup will be applied. Add your API key for full AI cleanup.'}
          </p>

          {/* Upload row */}
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
            <button
              style={{ ...tbS.btnSecondary, fontSize:12.5, padding:'7px 14px', flexShrink:0 }}
              onClick={() => fileRef.current?.click()}
              disabled={busy || fileLoading}
            >
              {fileLoading ? '⏳ Parsing…' : '↑ Upload .docx / .pdf'}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".docx,.pdf"
              style={{ display:'none' }}
              onChange={handleFile}
            />
            {value && !fileLoading && (
              <span style={{ fontSize:12, color:'#4A7C59' }}>✓ {value.length.toLocaleString()} chars loaded</span>
            )}
            {fileError && (
              <span style={{ fontSize:12, color:'#C0392B' }}>⚠ {fileError}</span>
            )}
          </div>

          <textarea
            style={{ ...tbS.textarea, minHeight: 320 }}
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={"Paste raw chapter text here — or use the upload button above for .docx / .pdf…\n\nTip: if pasting, include page numbers as-is (e.g. a lone '47' on its own line) and they'll be converted to [Page 47] markers automatically."}
            rows={18}
            disabled={busy || fileLoading}
          />
          {busy && <div style={tbS.statusBar}>{statusMsg}</div>}
        </div>
        <div style={tbS.modalFoot}>
          <button style={tbS.btnGhost}   onClick={onClose} disabled={busy}>Cancel</button>
          <button style={tbS.btnPrimary} onClick={() => onSubmit(draftTitle)} disabled={!canSave}>
            {busy
              ? statusMsg || 'Working…'
              : value.trim()
                ? (hasApiKey ? '✦ Clean & Save →' : 'Save & Extract Cases →')
                : 'Save Name →'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Tiny helpers ──────────────────────────────────────────────────────────────

function emptyBrief(chId) {
  return { chapter: chId, facts: '', proceduralHistory: '', issue: '', holding: '', reasoning: '' };
}

const tbS = {
  empty: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, padding: 60, textAlign: 'center' },
  emptyShield:  { fontSize: 64 },
  emptyHeading: { fontFamily: '"Lora", "Lora", Georgia, serif', fontSize: 26, fontWeight: 700, color: '#1A1714' },
  emptyBody:    { fontSize: 15, color: '#4A3D30', maxWidth: 440, lineHeight: 1.65 },
  noKeyNote:    { fontSize: 12, color: '#B8A070', background: '#FDF3E0', padding: '8px 14px', borderRadius: 6, border: '1px solid #E8D5A0', maxWidth: 440, lineHeight: 1.55 },
  root:    { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 36px', borderBottom: '1px solid #E2D9CC' },
  list: { flex: 1, overflowY: 'auto', padding: '18px 36px 48px' },
  card: { background: 'white', borderRadius: 8, border: '1px solid #E2D9CC', marginBottom: 6, transition: 'box-shadow .15s, opacity .15s, transform .15s', position: 'relative' },
  cardOpen: { boxShadow: '0 3px 18px rgba(26,39,68,.08)' },
  cardDragging: { opacity: 0.45 },
  cardHeader: { display: 'flex', alignItems: 'center', gap: 14, padding: '15px 18px', cursor: 'pointer', userSelect: 'none' },
  chNum: { width: 28, height: 28, borderRadius: '50%', background: '#1A1714', color: '#F8F6F1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: '"Lora", Georgia, serif', fontSize: 11.5, fontWeight: 700, flexShrink: 0 },
  chNumHandle: { cursor: 'grab', transition: 'transform .12s, box-shadow .12s' },
  chNumDragging: { cursor: 'grabbing', boxShadow: '0 4px 14px rgba(26,23,20,.4)', transform: 'scale(1.06)' },
  cardInfo: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 15.5, fontWeight: 700, color: '#1A1714', lineHeight: 1.35, fontFamily: '"Lora", "Lora", Georgia, serif' },
  cardMeta:  { fontSize: 12.5, color: '#5A4A35', fontWeight: 500, marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' },
  customTag: { background: '#FDF3E0', color: '#2A6049', padding: '1px 6px', borderRadius: 3, border: '1px solid #E8D5A0', fontWeight: 600, fontSize: 11 },
  cardBtns: { display: 'flex', gap: 4 },
  iconBtn:  { background: 'none', border: '1px solid #E2D9CC', borderRadius: 4, width: 27, height: 27, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#4A3D30', fontSize: 13 },
  chevron:     { fontSize: 18, color: '#C8A84C', transform: 'rotate(0deg)', transition: 'transform .2s', marginLeft: 2 },
  chevronOpen: { transform: 'rotate(90deg)' },
  cardBody: { padding: '4px 16px 18px 64px', borderTop: '1px solid #F5EFE6' },
  sections: { marginBottom: 10 },
  secItem:  { fontSize: 11.5, color: '#4A3D30', padding: '2px 0', borderLeft: '2px solid #E8D5A0', paddingLeft: 10, marginBottom: 1 },
  casesArea:  { marginTop: 12 },
  casesLabel: { fontSize: 10.5, fontWeight: 700, color: '#2A6049', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 7 },
  caseTags:   { display: 'flex', flexWrap: 'wrap', gap: 4 },
  caseTag:    { display: 'inline-block', background: '#F8F6F1', border: '1px solid #DDD6CC', borderRadius: 3, padding: '2px 8px', fontSize: 11.5, color: '#1A1714', fontStyle: 'italic' },
  addCard: { background: 'white', borderRadius: 8, border: '2px dashed #2A6049', padding: 16, marginBottom: 9, display: 'flex', flexDirection: 'column', gap: 10 },
  addInput: { width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #DDD6CC', fontSize: 14, fontFamily: '"Lora", "Lora", Georgia, serif', background: '#FFFFFF', outline: 'none', boxSizing: 'border-box' },
  addTrigger: { width: '100%', padding: 11, background: 'none', border: '1px dashed #C8BEA8', borderRadius: 7, color: '#5A4538', fontSize: 13, cursor: 'pointer' },
  statusBar: { marginTop: 10, padding: '8px 12px', background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 6, fontSize: 13, color: '#1E40AF' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(26,39,68,.52)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, backdropFilter: 'blur(2px)' },
  modal:   { background: '#FFFFFF', borderRadius: 12, width: '90%', maxWidth: 660, boxShadow: '0 24px 64px rgba(26,39,68,.28)', overflow: 'hidden' },
  modalHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '18px 24px', borderBottom: '1px solid #E2D9CC', background: '#F5EFE6' },
  modalTitle: { fontFamily: '"Lora", "Lora", Georgia, serif', fontSize: 17, fontWeight: 700, color: '#1A1714' },
  modalTitleInput: { flex: 1, minWidth: 0, fontFamily: '"Lora", "Lora", Georgia, serif', fontSize: 17, fontWeight: 700, color: '#1A1714', background: 'transparent', border: '1px solid transparent', borderRadius: 5, padding: '4px 8px', margin: '-4px -8px', outline: 'none', cursor: 'text', transition: 'background .12s, border-color .12s' },
  modalTitleInputFocused: { background: 'white', border: '1px solid #2A6049' },
  modalX:     { background: 'none', border: 'none', fontSize: 17, color: '#5A4538', cursor: 'pointer' },
  modalBody:  { padding: '22px 24px' },
  modalDesc:  { fontSize: 13.5, color: '#4A3D30', marginBottom: 14, lineHeight: 1.65, marginTop: 0 },
  modalFoot:  { padding: '14px 24px', borderTop: '1px solid #E2D9CC', display: 'flex', gap: 8, justifyContent: 'flex-end' },
  textarea:   { width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: 6, border: '1px solid #DDD6CC', fontSize: 13, fontFamily: '"Lora", Georgia, serif', lineHeight: 1.6, background: 'white', resize: 'vertical', minHeight: 200, outline: 'none' },
  btnPrimary:   { padding: '9px 18px', background: '#1A1714', color: '#F8F6F1', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  btnSecondary: { padding: '9px 18px', background: 'white', color: '#1A1714', border: '1px solid #DDD6CC', borderRadius: 6, fontSize: 13, cursor: 'pointer' },
  btnGhost:     { padding: '9px 18px', background: 'none', color: '#4A3D30', border: '1px solid #DDD6CC', borderRadius: 6, fontSize: 13, cursor: 'pointer' },
};

Object.assign(window, { TextbookTab });
