// LexBrother — Data Layer v3
const STORAGE_KEY = 'lexbrother_v1';
const APIKEY_KEY  = 'lexbrother_apikey';

const DEFAULT_COURSES = [
  { id: 'civil-procedure',        name: 'Civil Procedure',         abbr: 'CivPro'  },
  { id: 'constitutional-law',     name: 'Constitutional Law',       abbr: 'ConLaw'  },
  { id: 'contracts',              name: 'Contracts',                abbr: 'K'       },
  { id: 'criminal-law',           name: 'Criminal Law',             abbr: 'CrimLaw' },
  { id: 'property',               name: 'Property',                 abbr: 'Prop'    },
  { id: 'torts',                  name: 'Torts',                    abbr: 'Torts'   },
  { id: 'legal-research-writing', name: 'Legal Research & Writing', abbr: 'LRW'     },
];

function genId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function freshCourse(c) {
  return { ...c, chapters: [], quizzes: {}, briefs: {} };
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);

      // Ensure customCourses array exists
      if (!data.customCourses) data.customCourses = [];

      // Ensure all default courses exist
      DEFAULT_COURSES.forEach(c => {
        if (!data.courses[c.id]) data.courses[c.id] = freshCourse(c);
      });

      // ── Migration: convert old single-quiz format → sets format ──────────
      Object.values(data.courses).forEach(course => {
        if (!course.quizzes) { course.quizzes = {}; return; }
        Object.keys(course.quizzes).forEach(chId => {
          const q = course.quizzes[chId];
          if (q && !q.sets) {
            // Old format had questions/wrongBank/flagged/sessions at top level
            course.quizzes[chId] = {
              sets: q.questions ? [{
                id: genId(), label: 'Quiz 1',
                questions:   q.questions || [],
                settings:    q.settings  || { count: (q.questions||[]).length, type: 'mix' },
                generatedAt: q.generatedAt || Date.now(),
                summary:     null,
                progress:    null,
                wrongBank:   q.wrongBank || {},
                flagged:     q.flagged   || [],
                sessions:    q.sessions  || [],
              }] : [],
            };
          }
        });
      });

      return data;
    }
  } catch(e) { console.warn('LexBrother: load error', e); }

  const data = { courses: {}, customCourses: [] };
  DEFAULT_COURSES.forEach(c => { data.courses[c.id] = freshCourse(c); });
  return data;
}

function saveData(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
  catch(e) { console.warn('LexBrother: save error', e); }
}

// ── API Key ───────────────────────────────────────────────────────────────────
function loadApiKey() { return localStorage.getItem(APIKEY_KEY) || ''; }
function saveApiKey(key) {
  if (key) localStorage.setItem(APIKEY_KEY, key.trim());
  else localStorage.removeItem(APIKEY_KEY);
}

// ── Anthropic direct call ─────────────────────────────────────────────────────
async function callAnthropicAPI(apiKey, prompt, maxTokens = 16000) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-7',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${response.status}`);
  }
  const data = await response.json();
  return data.content[0].text;
}

async function callBuiltIn(prompt) { return window.claude.complete(prompt); }

async function callClaude(prompt, maxTokens = 16000) {
  const key = loadApiKey();
  if (key) return callAnthropicAPI(key, prompt, maxTokens);
  return callBuiltIn(prompt);
}

// ── TOC: basic cleanup ────────────────────────────────────────────────────────
function basicCleanTOC(raw) {
  return raw
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
    .split('\n')
    .filter(line => !/^\s*(xl{0,3}i{0,3}v?|l?x{0,3}i{0,3}v?|[ivxlcdm]+|\d{1,4})\s*$/i.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

// ── TOC: AI extraction → returns parsed chapters array directly ───────────────
async function aiCleanTOC(rawText) {
  const pre = rawText
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ');

  const prompt =
`You are extracting structure from a raw law school casebook table of contents copy-pasted from a PDF. Very messy: page numbers between content lines, section letters alone on lines.

Extract EVERY chapter and EVERY legal case within each chapter. Do NOT skip any.

Rules:
- "chapter" = any line matching "Chapter N" or similar. ALWAYS format chapter titles as "Chapter N: Title" using a colon separator (never em dash or hyphen)
- "case" = court cases: "Party v. Party", "In re Name", "People v. Name", "United States v. Name", "State v. Name", "Commonwealth v. Name", "Regina v. Name", etc.
- Include cases from ALL sub-sections, no matter how deep
- Do NOT include journal articles, books, author names, notes, problems
- Remove all page numbers (arabic and roman numerals)
- Fix HTML entities (&amp; → &)
- Be EXHAUSTIVE — if in doubt whether something is a case, include it

Return ONLY valid JSON — no markdown:
[{"number":1,"title":"Chapter 1: Foundations","cases":["Regina v. Dudley and Stephens"]},...]

Raw TOC:
${pre}`;

  const text = await callClaude(prompt, 8192);
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Could not parse chapter list. Try again.');

  let parsed;
  try { parsed = JSON.parse(match[0]); }
  catch(e) {
    const lastBrace = match[0].lastIndexOf('}');
    try { parsed = JSON.parse(match[0].slice(0, lastBrace + 1) + ']'); }
    catch(e2) { throw new Error('JSON from AI was malformed. Please try again.'); }
  }

  return parsed.map((ch, i) => ({
    id: genId(),
    title: ch.title || `Chapter ${ch.number || (i + 1)}`,
    number: ch.number || (i + 1),
    isCustom: false, sections: [],
    content: '', cases: (ch.cases || []).map(c => c.trim()).filter(Boolean),
    contentStatus: 'empty',
  }));
}

// ── Content cleanup ───────────────────────────────────────────────────────────
function basicCleanContent(raw) {
  return raw
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
    .replace(/\bp\.\s*\d+\s*/g, '')
    .replace(/([""'\.!?])\d{1,3}(\s)/g, '$1$2')
    .replace(/([""'\.!?])\d{1,3}$/gm, '$1')
    // Convert standalone page numbers → [Page N] markers (preserve for focus-area quizzing)
    .replace(/^\s*(\d{1,4})\s*$/gm, (_, n) => {
      const num = parseInt(n, 10);
      return (num > 0 && num < 3000) ? `[Page ${n}]` : '';
    })
    .replace(/^\s*[ivxlcdmIVXLCDM]{1,6}\s*$/gm, '')
    .replace(/^Chapter \d+\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Case extraction (fully-presented only: standalone name + citation) ────────
function extractCasesFromContent(content) {
  const lines = content.split('\n').map(l => l.trim());
  const cases = [];
  const caseNameRe = /^([A-Z][A-Za-z\s',\.\-]{1,60})\s+v\.?\s+([A-Z][A-Za-z\s',\.\-]{1,60})$/;
  const inReRe     = /^In re\s+[A-Z][A-Za-z\s',\.\-]{1,60}$/i;
  const citationRe = /\(\d{4}\)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (!caseNameRe.test(line) && !inReRe.test(line)) continue;
    const window = lines.slice(i + 1, i + 5).join(' ');
    if (citationRe.test(window)) {
      const name = line.trim();
      if (!cases.includes(name)) cases.push(name);
    }
  }
  return cases;
}

// ── Regex TOC parser (fallback without API key) ───────────────────────────────
function parseTOC(text) {
  const lines = text.split('\n').map(l => l.trimEnd());
  const chapters = [];
  let current = null;
  const chapterRe = /^(chapter\s+\d+[\w]*|part\s+[\divxlc]+|unit\s+\d+)/i;
  const caseRe    = /\b([A-Z][A-Za-z',\.\-\s]{1,50})\s+v\.?\s+([A-Z][A-Za-z',\.\-\s]{1,50})/;
  const numOnlyRe = /^\s*[\divxlc]+\s*$/i;

  lines.forEach(raw => {
    const indent  = (raw.match(/^(\s*)/) || ['',''])[1].length;
    const trimmed = raw.trim();
    if (!trimmed || numOnlyRe.test(trimmed)) return;

    if (chapterRe.test(trimmed)) {
      current = { id: genId(), title: trimmed, number: chapters.length + 1,
        isCustom: false, sections: [], content: '', cases: [], contentStatus: 'empty' };
      chapters.push(current);
    } else if (current) {
      const m = trimmed.match(caseRe);
      if (m) {
        const cn = (m[1].trim() + ' v. ' + m[2].trim()).replace(/\s+/g, ' ');
        if (cn.length < 100 && !current.cases.includes(cn)) current.cases.push(cn);
      }
      current.sections.push({ id: genId(), title: trimmed, indent });
    }
  });
  return chapters;
}

// ── Question identity key ─────────────────────────────────────────────────────
function qKey(q) { return (q.question || '').slice(0, 100).trim(); }

// ── Quiz batch generation (rigorous, coverage-mandated) ───────────────────────
async function generateQuizBatch({
  content, batchIndex, totalBatches, batchSize, questionType, chapterTitle,
  previousQuestions = [], allChapterQuestions = [], focusArea = '',
}) {
  const typeInstructions = {
    fact: `Generate ${batchSize} FACT-BASED questions. Each must test specific rules, legal standards, case holdings, statutory elements, or doctrinal definitions. Tag each with "qtype":"fact".`,
    application: `Generate ${batchSize} APPLICATION questions. Each must present a novel hypothetical fact pattern (not found verbatim in the text) and require applying legal doctrine to reach a conclusion. Bar-exam issue-spotting style. Tag each with "qtype":"application".`,
    mix: `Generate ${batchSize} questions: roughly half fact-based (rules, holdings, definitions) tagged "qtype":"fact" and half application-based (novel hypotheticals requiring doctrinal application) tagged "qtype":"application". Alternate between types for variety.`,
  }[questionType] || `Generate ${batchSize} mixed questions tagged with "qtype":"fact" or "qtype":"application".`;

  const allPrior = [...allChapterQuestions, ...previousQuestions];
  const coveredTopics = allPrior.length > 0
    ? allPrior.map((q, i) => `${i + 1}. ${(q.question || '').slice(0, 90)}`).join('\n')
    : null;

  const batchNote = totalBatches > 1
    ? `This is batch ${batchIndex + 1} of ${totalBatches} (questions ${allPrior.length + 1}–${allPrior.length + batchSize} of the total set).`
    : 'This is the only batch.';

  // Detect whether the chapter content contains court cases
  const hasCases = /\bv\.\s+[A-Z]/.test(content.slice(0, 8000));

  const caseQuestionInstructions = hasCases ? `
═══ CASE-BASED QUESTION TYPES (REQUIRED when asking about a specific case) ═══
When your question concerns a named court case, vary the question type across these categories — do NOT only ask about holdings. Distribute questions across all categories:

1. ISSUE — What precise legal question did the court address? What was genuinely disputed?
2. FACTS — Key facts; how specific facts shaped the outcome; similarities/differences vs. other cases in the chapter; which facts were legally significant and why
3. PROCEDURAL HISTORY — How the case reached this court; what motions/rulings occurred below; procedural posture vs. procedural history distinction; in criminal cases: charges, bail, prior proceedings
4. RULE OF LAW — What legal standard, test, or doctrine does the case stand for? How does it fit into the broader doctrinal framework?
5. HOLDING — The court's specific ruling; what it decided and what it did NOT decide
6. REASONING — The court's legal analysis; the strongest and weakest parts of the majority's logic
7. CONCURRENCE / DISSENT — Where a concurrence or dissent exists: what the concurring/dissenting judge agreed or disagreed with, and why that matters for understanding the rule
8. ALTERED FACTS HYPOTHETICALS — "If [key fact] were different, would the outcome change?" These require deep causal reasoning about which facts were dispositive
9. CRITIQUE — Which side had the stronger argument? What are the vulnerabilities in the majority's reasoning? What are the strongest counterarguments?
10. PERSPECTIVE — How would this ruling be analyzed from the plaintiff's perspective? The defendant's? A policy perspective? A different interpretive school (textualist vs. purposivist, etc.)?
` : '';

  const focusInstruction = focusArea.trim() ? `
═══ STUDENT-SPECIFIED FOCUS AREA ═══
The student has requested that questions focus specifically on: "${focusArea.trim()}"
— If this references page numbers (e.g. "pages 30–55"), concentrate questions on content near [Page N] markers in that range.
— If this references a specific case name, prioritize all 10 case-question categories for that case.
— If this references a concept or doctrine (e.g. "the 11 stages of civil litigation"), ensure the majority of questions test that concept deeply.
— Still draw on surrounding context for distractors and explanations, but weight question selection heavily toward the focus area.
` : '';

  const prompt =
`You are a rigorous law professor writing comprehensive 1L exam questions for: "${chapterTitle}".

${batchNote}
${focusInstruction}
═══ MANDATORY COVERAGE REQUIREMENT ═══
You MUST test the ENTIRE chapter — every case, doctrine, rule, note, problem, and concept.
STEP 1: Mentally catalog every distinct topic in the chapter content below.
STEP 2: Every topic must receive at least ONE question before any topic receives a second question.
STEP 3: Only after full chapter coverage may you write additional questions on already-covered topics.
STEP 4: Where genuinely applicable across different sections, include 1-2 compare/contrast questions that test understanding of how two different doctrines or cases relate to or differ from each other.
${caseQuestionInstructions}
═══ QUESTION QUALITY ═══
• Questions must test DEEP understanding — NOT surface-level recognition of a single sentence
• Application questions MUST use novel fact patterns not found verbatim in the text
• Fact questions must require synthesis, NOT single-sentence lookup
• One answer must be clearly and unambiguously correct
• Distractors must be plausible but clearly wrong on careful analysis
• Explanations: 3-5 sentences citing specific rules, cases, or facts from the content

═══ QUESTION TYPE ═══
${typeInstructions}

${coveredTopics
  ? `═══ ALREADY COVERED — AVOID REPEATING UNTIL ALL TOPICS ARE COVERED ═══\n${coveredTopics}\n`
  : '═══ FIRST BATCH — Start with foundational topics and the most important cases/doctrines. ═══'}

═══ OUTPUT FORMAT ═══
Return ONLY a valid JSON array — no markdown fences, no commentary:
[{"question":"...","choices":{"A":"...","B":"...","C":"...","D":"..."},"correct":"A","explanation":"...","qtype":"fact"}]

Chapter content (note: [Page N] markers indicate page breaks — use them to honor page-range focus areas):
${content.slice(0, 90000)}`;

  const apiKey = loadApiKey();
  const text   = apiKey
    ? await callAnthropicAPI(apiKey, prompt, 16000)
    : await callBuiltIn(prompt);

  let match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`Batch ${batchIndex + 1}: Could not parse JSON response.`);

  let questions;
  try {
    questions = JSON.parse(match[0]);
  } catch(e) {
    const lastBrace = match[0].lastIndexOf('}');
    if (lastBrace === -1) throw new Error(`Batch ${batchIndex + 1}: Could not parse JSON.`);
    try { questions = JSON.parse(match[0].slice(0, lastBrace + 1) + ']'); }
    catch(e2) { throw new Error(`Batch ${batchIndex + 1}: Malformed JSON. Try again.`); }
  }

  if (!Array.isArray(questions) || !questions.length)
    throw new Error(`Batch ${batchIndex + 1}: Empty response.`);

  return questions;
}

// ── Briefs DOCX export ────────────────────────────────────────────────────────
function generateBriefsHTML(course) {
  const chapters = course.chapters || [];
  const briefs   = course.briefs   || {};
  const tnr      = "font-family:'Times New Roman',Times,serif;";

  const fields = [
    { key: 'facts',             label: 'FACTS'              },
    { key: 'proceduralHistory', label: 'PROCEDURAL HISTORY' },
    { key: 'issue',             label: 'ISSUE'              },
    { key: 'holding',           label: 'HOLDING/RULE'       },
    { key: 'reasoning',         label: 'REASONING'          },
  ];

  let body = '';
  chapters.forEach(ch => {
    const cases = (ch.cases || []).filter(c => {
      const b = briefs[c];
      return b && (b.facts || b.holding || b.issue || b.reasoning);
    });
    if (!cases.length) return;

    body += `<h2 style="${tnr}font-size:13pt;font-weight:bold;border-bottom:1pt solid #000;padding-bottom:4pt;margin-top:24pt;">${ch.title}</h2>`;

    cases.forEach((caseName, i) => {
      const b = briefs[caseName] || {};
      if (i > 0) body += `<hr style="border:none;border-top:0.5pt solid #000;margin:18pt 0;">`;
      body += `<p style="${tnr}font-size:12pt;font-weight:bold;font-style:italic;margin:14pt 0 8pt;">${caseName}</p>`;
      fields.forEach(f => {
        if (!b[f.key]) return;
        body += `<p style="${tnr}font-size:11pt;font-weight:bold;text-transform:uppercase;letter-spacing:0.5pt;margin:8pt 0 2pt;">${f.label}</p>
<p style="${tnr}font-size:12pt;line-height:1.7;margin:0 0 4pt;">${b[f.key].replace(/\n/g, '<br>')}</p>`;
      });
    });
  });

  if (!body) body = `<p style="${tnr}font-size:12pt;">No completed briefs to export yet.</p>`;

  return `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head><meta charset='utf-8'>
<style>
@page { size:8.5in 11in; margin:1.0in 1.0in 1.0in 1.0in; }
body { ${tnr} margin:0; color:#000; }
* { color:#000 !important; background:white !important; }
</style>
</head><body>
<h1 style="${tnr}font-size:14pt;font-weight:bold;border-bottom:1pt solid #000;padding-bottom:6pt;">${course.name} — Case Briefs</h1>
${body}</body></html>`;
}

// ── Miss Report DOCX export ───────────────────────────────────────────────────
function generateMissReportHTML(course) {
  const chapters = course.chapters || [];
  const quizzes  = course.quizzes  || {};
  const tnr      = "font-family:'Times New Roman',Times,serif;";
  let body = '';
  let totalWrong = 0;

  chapters.forEach(ch => {
    // Aggregate wrong banks across ALL sets for this chapter
    const sets   = quizzes[ch.id]?.sets || [];
    const wrongs = sets.flatMap(s => Object.values(s.wrongBank || {}));
    if (!wrongs.length) return;
    totalWrong += wrongs.length;

    body += `<h2 style="${tnr}font-size:13pt;font-weight:bold;border-bottom:1pt solid #000;padding-bottom:4pt;margin-top:24pt;">${ch.title}</h2>`;

    wrongs.forEach((q, i) => {
      body += `<div style="margin-bottom:18pt;">
<p style="${tnr}font-size:12pt;font-weight:bold;margin:10pt 0 6pt;">${i + 1}. ${q.question}</p>
${['A','B','C','D'].map(l => `<p style="${tnr}font-size:11pt;margin:2pt 0;${l === q.correct ? 'font-weight:bold;' : ''}">${l}. ${q.choices[l]}${l === q.correct ? ' ✓' : ''}</p>`).join('')}
<p style="${tnr}font-size:11pt;font-style:italic;margin:7pt 0 3pt;"><strong>Explanation:</strong> ${q.explanation}</p>
<p style="${tnr}font-size:10pt;">Times missed: ${q.wrongCount || 1} &nbsp;|&nbsp; Correct streak to retire: ${2 - (q.rightStreak || 0)}</p>
</div>`;
    });
  });

  if (!body) body = `<p style="${tnr}font-size:12pt;">No missed questions on record yet.</p>`;

  return `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head><meta charset='utf-8'>
<style>body{${tnr}margin:1in;color:#000;}*{color:#000!important;background:white!important;}</style>
</head><body>
<h1 style="${tnr}font-size:14pt;font-weight:bold;border-bottom:1pt solid #000;padding-bottom:6pt;">${course.name} — Missed Questions Report</h1>
<p style="${tnr}font-size:11pt;margin-bottom:18pt;">Total to review: ${totalWrong}</p>
${body}</body></html>`;
}

// ── Red Flag Review ───────────────────────────────────────────────────────────
async function generateRedFlagReview({ caseName, fieldLabel, fieldContent }) {
  const prompt =
`You are a law professor doing a quick red-flag check on a 1L student's case brief for "${caseName}" — specifically the "${fieldLabel}" section.

Student's entry:
"""
${fieldContent}
"""

Your job: flag MAJOR omissions only. This is a brief, not an essay — minor details are fine to skip.

Focus area for "${fieldLabel}":
- Facts: were the legally dispositive facts included? Any critical facts that drove the outcome missing?
- Procedural History: is the court level and how the case arrived there clear?
- Issue: is there a precise, answerable legal question?
- Holding/Rule: is the ruling specific and clear as to what was actually decided, AND is the governing rule or legal principle the case stands for stated?
- Reasoning: is the core legal logic (not every detail) present?

Respond in 1–4 bullet points max. Only flag things that genuinely matter for understanding or exam prep. If nothing major is missing, say so in one sentence. No praise, no summary — just gaps. 150 words absolute maximum.`;

  return callClaude(prompt, 512);
}

window.LexStore = {
  DEFAULT_COURSES,
  loadData, saveData,
  loadApiKey, saveApiKey,
  callClaude, callAnthropicAPI, callBuiltIn,
  parseTOC, basicCleanTOC, basicCleanContent,
  aiCleanTOC,
  extractCasesFromContent,
  generateQuizBatch,
  generateBriefsHTML,
  generateMissReportHTML,
  generateRedFlagReview,
  qKey,
  genId,
};
