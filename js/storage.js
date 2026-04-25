// LexBrother — Data Layer v4 (Supabase-backed, in-memory cache + debounced sync)
const STORAGE_KEY = 'lexbrother_v1';     // legacy localStorage key — migrated to cloud on first sign-in
const APIKEY_KEY  = 'lexbrother_apikey'; // legacy localStorage key — migrated to cloud on first sign-in

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

// ── Cloud state (populated by initCloud after sign-in) ────────────────────────
const cloud = {
  client:    null,   // Supabase client
  userId:    null,   // signed-in user's UUID
  data:      null,   // cached courses blob
  apiKey:    '',     // cached Anthropic key
  saveTimer: null,   // debounce timer id
  saving:    false,  // true while an upsert is in flight
  pending:   false,  // true if a save was requested during an in-flight upsert
};

// Normalize an arbitrary data object into current shape + run legacy migrations.
// Runs for data from Supabase, localStorage, or a fresh empty object.
function normalizeData(raw) {
  const data = (raw && typeof raw === 'object') ? raw : {};
  if (!data.courses) data.courses = {};
  if (!data.customCourses) data.customCourses = [];

  // Ensure all default courses exist
  DEFAULT_COURSES.forEach(c => {
    if (!data.courses[c.id]) data.courses[c.id] = freshCourse(c);
  });

  // Legacy migration: convert old single-quiz format → sets format
  Object.values(data.courses).forEach(course => {
    if (!course.quizzes) { course.quizzes = {}; return; }
    Object.keys(course.quizzes).forEach(chId => {
      const q = course.quizzes[chId];
      if (q && !q.sets) {
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

function emptyData() {
  const data = { courses: {}, customCourses: [] };
  DEFAULT_COURSES.forEach(c => { data.courses[c.id] = freshCourse(c); });
  return data;
}

// Initialize cloud sync after sign-in. Fetches the user's row from Supabase,
// or creates it (migrating any local data up on first sign-in).
async function initCloud(client, userId) {
  cloud.client = client;
  cloud.userId = userId;

  const { data: row, error } = await client
    .from('user_data')
    .select('data, api_key')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(`Could not load your data: ${error.message}`);

  if (row) {
    cloud.data   = normalizeData(row.data);
    cloud.apiKey = row.api_key || '';
    return;
  }

  // First sign-in on this account — migrate localStorage if any, else start fresh.
  let seedData   = null;
  let seedApiKey = '';
  try {
    const rawLocal = localStorage.getItem(STORAGE_KEY);
    if (rawLocal) seedData = JSON.parse(rawLocal);
    seedApiKey = localStorage.getItem(APIKEY_KEY) || '';
  } catch(e) { /* ignore corrupt legacy data */ }

  cloud.data   = normalizeData(seedData || emptyData());
  cloud.apiKey = seedApiKey;

  const { error: insertErr } = await client.from('user_data').insert({
    user_id: userId, data: cloud.data, api_key: cloud.apiKey,
  });
  if (insertErr) throw new Error(`Could not create your cloud record: ${insertErr.message}`);
}

// Actually push the current cache to Supabase.
async function flushSave() {
  if (!cloud.client || !cloud.userId) return;
  if (cloud.saving) { cloud.pending = true; return; }
  cloud.saving = true;
  try {
    const { error } = await cloud.client
      .from('user_data')
      .update({ data: cloud.data, api_key: cloud.apiKey, updated_at: new Date().toISOString() })
      .eq('user_id', cloud.userId);
    if (error) console.warn('LexBrother: cloud save error', error);
  } finally {
    cloud.saving = false;
    if (cloud.pending) { cloud.pending = false; scheduleSave(); }
  }
}

function scheduleSave() {
  if (cloud.saveTimer) clearTimeout(cloud.saveTimer);
  cloud.saveTimer = setTimeout(() => { cloud.saveTimer = null; flushSave(); }, 800);
}

// Synchronous-ish façade the rest of the app already uses.
function loadData() {
  return cloud.data || emptyData();
}

function saveData(data) {
  cloud.data = data;
  scheduleSave();
}

// Best-effort flush (e.g. before page unload or sign-out).
async function flushPendingSave() {
  if (cloud.saveTimer) { clearTimeout(cloud.saveTimer); cloud.saveTimer = null; }
  await flushSave();
}

function clearCloud() {
  if (cloud.saveTimer) { clearTimeout(cloud.saveTimer); cloud.saveTimer = null; }
  cloud.client = null;
  cloud.userId = null;
  cloud.data   = null;
  cloud.apiKey = '';
}

// ── API Key (cached in the same cloud row) ────────────────────────────────────
function loadApiKey() { return cloud.apiKey || ''; }
function saveApiKey(key) {
  cloud.apiKey = (key || '').trim();
  scheduleSave();
}

// ── Anthropic direct call ─────────────────────────────────────────────────────
// Returns { text, stopReason, usage, raw }. Supports system prompts, structured
// content blocks (for cache_control), and extended thinking.
async function callAnthropicAPI(apiKey, {
  system,                 // string | array of content blocks
  messages,               // array of {role, content} where content is string or block array
  prompt,                 // convenience: builds messages = [{role:'user', content: prompt}]
  maxTokens = 16000,
  thinking,               // {type:'enabled', budget_tokens:N} | undefined
} = {}) {
  const body = {
    model: 'claude-opus-4-7',
    max_tokens: maxTokens,
    messages: messages || [{ role: 'user', content: prompt || '' }],
  };
  if (system)   body.system   = system;
  if (thinking) body.thinking = thinking;
  // When thinking is enabled the API requires temperature=1 (the default), so we omit it.

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${response.status}`);
  }
  const data = await response.json();
  // Extended thinking emits thinking blocks before the answer — pull the text block.
  const textBlock = (data.content || []).find(b => b.type === 'text');
  return {
    text:       textBlock ? textBlock.text : '',
    stopReason: data.stop_reason || null,
    usage:      data.usage || null,
    raw:        data,
  };
}

async function callBuiltIn(prompt) { return window.claude.complete(prompt); }

// Simple string-in / string-out shim used by single-prompt callers (TOC, briefs, red-flag).
async function callClaude(prompt, maxTokens = 16000) {
  const key = loadApiKey();
  if (key) {
    const { text } = await callAnthropicAPI(key, { prompt, maxTokens });
    return text;
  }
  return callBuiltIn(prompt);
}

// Rich variant — returns {text, stopReason, usage, raw} so callers can detect
// truncation, pass system prompts, enable extended thinking, etc.
async function callClaudeRich(options = {}) {
  const key = loadApiKey();
  if (key) return callAnthropicAPI(key, options);
  const text = await callBuiltIn(flattenForBuiltIn(options));
  return { text, stopReason: 'end_turn', usage: null, raw: null };
}

// Flatten rich options to a single string for the built-in window.claude.complete fallback,
// which doesn't support system prompts or structured content blocks.
function flattenForBuiltIn({ system, messages, prompt } = {}) {
  const blockText = b => (typeof b === 'string' ? b : (b && b.text) || '');
  const parts = [];
  if (system) {
    parts.push(Array.isArray(system) ? system.map(blockText).join('\n\n') : String(system));
  }
  if (messages && messages.length) {
    for (const m of messages) {
      const c = m.content;
      parts.push(Array.isArray(c) ? c.map(blockText).join('\n\n') : String(c || ''));
    }
  } else if (prompt) {
    parts.push(prompt);
  }
  return parts.join('\n\n');
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

// ── Quiz generation: single-pass char limit ───────────────────────────────────
// Anything larger needs map-reduce (see follow-up commit). Until then we throw
// loudly rather than silently slicing the chapter's tail off.
const QUIZ_MAX_SINGLE_PASS_CHARS = 400000;

// ── Quiz generation: stable system prompt (cached across batches and runs) ────
// Chapter-agnostic, run-agnostic. Per-run stuff (chapter title, focus area,
// batch number, covered topics) is assembled into the user message instead.
const QUIZ_SYSTEM_PROMPT = `You are a rigorous law professor writing comprehensive 1L exam questions.

═══ MANDATORY COVERAGE REQUIREMENT ═══
You MUST test the ENTIRE chapter — every case, doctrine, rule, note, problem, and concept.
STEP 1: Catalog every distinct topic in the chapter content.
STEP 2: Every topic must receive at least ONE question before any topic receives a second question.
STEP 3: Only after full chapter coverage may you write additional questions on already-covered topics.
STEP 4: Include compare/contrast questions wherever the chapter contains comparable doctrines, cases, or rules — as many as the material genuinely supports. There is NO upper limit on compare/contrast questions. Under-using compare/contrast on a chapter that contains, for example, five related cases is a quality failure.

═══ APPLICATION QUESTIONS — ANTI-COPYING RULES (MANDATORY) ═══
Application questions test whether the student can apply a doctrine to a NEW situation. Reusing a hypothetical from the source text defeats the entire purpose of an application question.

FORBIDDEN:
• Copying any fact pattern, hypothetical, or scenario from the source text.
• Lightly paraphrasing a source hypothetical (e.g. changing names while keeping the structure or commercial context).
• Asking a question whose answer can be located by Ctrl-F-ing the chapter.

REQUIRED:
• Construct a fact pattern that tests the SAME doctrine using DIFFERENT facts.
• Change at least TWO of: parties, jurisdiction, factual context, claim/cause of action, procedural posture.
• Self-check before finalizing each application question:
  (a) Does this rule appear in the source? (it should — that's what's being tested)
  (b) Does this fact pattern appear in the source? (it must NOT)
  (c) Could the question be answered by skim-reading the source? (it must NOT)
  If any check fails, rewrite the question.

ILLUSTRATIVE EXAMPLE:
  Source: "In Hadley v. Baxendale, a miller's broken crankshaft was sent for repair; the carrier's delay caused lost profits..."
  BAD application question: "A miller sends a broken crankshaft to a carrier..."        ← copied
  GOOD application question: "A bakery contracts with a courier to deliver a custom industrial mixer needed for a wedding-cake order; the courier delays delivery and the bakery loses the wedding contract..."   ← same doctrine, novel facts

═══ CASE-BASED QUESTION TYPES (required when asking about a specific case) ═══
When your question concerns a named court case, vary the question type across these categories — do NOT only ask about holdings. Distribute questions across all categories the case material genuinely supports:

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

═══ QUESTION QUALITY ═══
• Questions must test DEEP understanding — NOT surface-level recognition of a single sentence.
• Fact-based questions must require synthesis across the source, NOT single-sentence lookup.
• Application questions must obey the anti-copying rules above.
• One answer must be clearly and unambiguously correct.
• Distractors must reflect plausible 1L misconceptions, not random wrong answers.
• Explanations: 3-5 sentences citing specific rules, cases, or facts from the chapter (cite [Page N] markers when traceable).

═══ INPUT NOISE TOLERANCE ═══
The chapter content was copy-pasted from a PDF or e-textbook and is expected to contain typos, broken spacing (e.g. "T h e" or "absolve s"), run-together words, missing periods, mid-sentence section labels, stray punctuation, and similar artifacts. Mentally normalize this noise before extracting topics — read for legal substance, not surface formatting. NEVER skip a topic, case, rule, doctrine, or note because the surrounding text is poorly formatted: if the legal substance is recoverable from context, you must catalog and test it. Only ignore content that is genuinely unintelligible after a best-effort charitable reading. When you write the question, restate the rule or facts in clean prose — do not quote the garbled source verbatim.

═══ OUTPUT FORMAT ═══
Return ONLY a valid JSON array — no markdown fences, no commentary, no preamble. Each question object MUST have exactly these keys:

  "question":    string  — the question stem
  "choices":     object  — keys "A","B","C","D" each mapping to the answer text
  "correct":     string  — one of "A" | "B" | "C" | "D"
  "explanation": string  — 3-5 sentences citing the source
  "qtype":       string  — "fact" or "application"
  "topic":       string  — short canonical label for the doctrine/case/rule being tested (used for cross-batch deduplication)

Example shape:
[{"question":"...","choices":{"A":"...","B":"...","C":"...","D":"..."},"correct":"A","explanation":"...","qtype":"fact","topic":"Erie doctrine — substantive vs procedural"}]`;

// ── Quiz batch generation (rigorous, coverage-mandated) ───────────────────────
async function generateQuizBatch({
  content, batchIndex, totalBatches, batchSize, questionType, chapterTitle,
  previousQuestions = [], allChapterQuestions = [], focusArea = '',
}) {
  if (content.length > QUIZ_MAX_SINGLE_PASS_CHARS) {
    throw new Error(
      `This chapter is too long for single-pass quiz generation ` +
      `(${content.length.toLocaleString()} chars; current limit is ${QUIZ_MAX_SINGLE_PASS_CHARS.toLocaleString()}). ` +
      `Map-reduce mode for very long chapters is coming in the next update — for now, please split the chapter into smaller sub-chapters or trim its content.`
    );
  }

  const typeInstruction = {
    fact:        `Generate ${batchSize} FACT-BASED questions. Each must test specific rules, legal standards, case holdings, statutory elements, or doctrinal definitions. Tag each with "qtype":"fact".`,
    application: `Generate ${batchSize} APPLICATION questions. Each must present a novel hypothetical fact pattern that obeys the anti-copying rules and require applying legal doctrine to reach a conclusion. Bar-exam issue-spotting style. Tag each with "qtype":"application".`,
    mix:         `Generate ${batchSize} questions: roughly half fact-based (rules, holdings, definitions) tagged "qtype":"fact" and half application-based (novel hypotheticals — anti-copying rules apply) tagged "qtype":"application". Alternate between types for variety.`,
  }[questionType] || `Generate ${batchSize} mixed questions tagged with "qtype":"fact" or "qtype":"application".`;

  const allPrior = [...allChapterQuestions, ...previousQuestions];
  const coveredItems = allPrior.length > 0
    ? allPrior.map((q, i) => {
        const topic = q.topic ? `[${q.topic}] ` : '';
        const stem  = (q.question || '').slice(0, 200);
        return `${i + 1}. ${topic}${stem}`;
      }).join('\n')
    : null;

  const batchNote = totalBatches > 1
    ? `This is batch ${batchIndex + 1} of ${totalBatches} (questions ${allPrior.length + 1}–${allPrior.length + batchSize} of the total set).`
    : 'This is the only batch.';

  const focusInstruction = focusArea.trim() ? `
═══ STUDENT-SPECIFIED FOCUS AREA ═══
The student has requested that questions focus specifically on: "${focusArea.trim()}"
— If this references page numbers (e.g. "pages 30–55"), concentrate questions on content near [Page N] markers in that range.
— If this references a specific case name, prioritize all 10 case-question categories for that case.
— If this references a concept or doctrine (e.g. "the 11 stages of civil litigation"), ensure the majority of questions test that concept deeply.
— Still draw on surrounding context for distractors and explanations, but weight question selection heavily toward the focus area.
` : '';

  // Cached block: chapter title + full chapter content. Stable across all batches in a run.
  const chapterBlock =
`Chapter: "${chapterTitle}"

[Page N] markers indicate page breaks — use them to honor page-range focus areas and to cite source locations in explanations.

Chapter content:
${content}`;

  // Fresh block: per-batch state. Changes every call, so not cached.
  const batchBlock =
`${batchNote}
${focusInstruction}
═══ THIS BATCH ═══
${typeInstruction}

${coveredItems
  ? `═══ ALREADY COVERED — AVOID REPEATING UNTIL ALL CHAPTER TOPICS ARE COVERED ═══\n${coveredItems}\n`
  : '═══ FIRST BATCH — Start with foundational topics and the most important cases/doctrines. ═══'}

Now produce the JSON array of questions for this batch.`;

  const result = await callClaudeRich({
    system: [
      { type: 'text', text: QUIZ_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: chapterBlock, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: batchBlock },
      ],
    }],
    maxTokens: 32000,
    thinking: { type: 'enabled', budget_tokens: 16000 },
  });

  if (result.stopReason === 'max_tokens') {
    throw new Error(
      `Batch ${batchIndex + 1}: Output was truncated (hit max_tokens before completing). ` +
      `Try again, or reduce the batch size.`
    );
  }

  const text = result.text;
  const match = text.match(/\[[\s\S]*\]/);
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

// ── Brief Import: file reading + AI extraction ────────────────────────────────
function ensureMammoth() {
  if (window.mammoth) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/mammoth@1.8.0/mammoth.browser.min.js';
    s.onload  = () => resolve();
    s.onerror = () => reject(new Error('Could not load the Word-doc parser. Check your connection.'));
    document.head.appendChild(s);
  });
}

async function readBriefFile(file) {
  if (!file) throw new Error('No file selected.');
  const name = (file.name || '').toLowerCase();

  if (name.endsWith('.docx')) {
    await ensureMammoth();
    const buf = await file.arrayBuffer();
    const { value } = await window.mammoth.extractRawText({ arrayBuffer: buf });
    return (value || '').trim();
  }

  const text = await file.text();

  // LexBrother exports .doc as Word-HTML, so detect and strip
  if (name.endsWith('.doc') || /<html|<body|<p[\s>]/i.test(text)) {
    const tmp = document.createElement('div');
    tmp.innerHTML = text;
    tmp.querySelectorAll('p,h1,h2,h3,h4,h5,h6,div,br,li').forEach(el => {
      el.insertAdjacentText('afterend', '\n');
    });
    return (tmp.textContent || tmp.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  return text.trim();
}

async function extractBriefsFromText(rawText) {
  const clipped = (rawText || '').slice(0, 120000);
  if (!clipped.trim()) throw new Error('The document is empty.');

  const prompt =
`You are extracting case briefs from a law student's document. The document contains ONE OR MORE case briefs, each typically starting with the case name (e.g. "Pennoyer v. Neff") followed by labeled sections the student wrote.

Extract every case as a JSON object with EXACTLY these keys:
- caseName (string, required)
- facts (string or null)
- proceduralHistory (string or null)
- issue (string or null)
- holding (string or null)
- reasoning (string or null)

LABEL MATCHING — fuzzy. Accept typos and variations:
- "Facts", "Fact Pattern", "Factual Background", "F:", "Facts of the Case" → facts
- "Procedural History", "Proc. History", "Proceduarl History", "PH", "Procedure" → proceduralHistory
- "Issue", "Issues", "Legal Issue", "Question Presented", "I:" → issue
- "Holding", "Rule", "Disposition", "Holding/Rule", "Holding & Rule", "Rule of Law", "H:" → holding
  (If BOTH "Holding" and a separate "Rule/Disposition" section exist for the same case, CONCATENATE them into the holding field with a blank line between.)
- "Reasoning", "Rationale", "Analysis", "Court's Reasoning", "R:" → reasoning

CRITICAL RULES:
1. If a section is absent in the source for a given case, return null for that field. NEVER invent content.
2. Preserve the student's original wording verbatim. Do NOT summarize, paraphrase, or rewrite.
3. Do NOT include the label itself in the extracted content. (If the source reads "Facts: The plaintiff sued...", return only "The plaintiff sued...".)
4. Trim leading/trailing whitespace per field.
5. Preserve the case name exactly as written, but strip leading numbering like "1." or "Case 3:" or "Brief #2 –".
6. Case names commonly follow patterns: "X v. Y", "In re X", "People v. X", "State v. X", "United States v. X", "Commonwealth v. X", "Regina v. X", "Ex parte X". Identify them as case boundaries.

Return ONLY a valid JSON array — no markdown fences, no commentary:
[{"caseName":"...","facts":"...","proceduralHistory":null,"issue":"...","holding":"...","reasoning":"..."}]

Document:
${clipped}`;

  const text  = await callClaude(prompt, 16000);
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Could not parse the AI response. Try again.');

  let parsed;
  try { parsed = JSON.parse(match[0]); }
  catch(e) {
    const lastBrace = match[0].lastIndexOf('}');
    try { parsed = JSON.parse(match[0].slice(0, lastBrace + 1) + ']'); }
    catch(e2) { throw new Error('AI returned malformed JSON. Try again.'); }
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('No case briefs were found in the document.');
  }

  const clean = s => (typeof s === 'string' && s.trim()) ? s.trim() : null;
  return parsed
    .map(p => ({
      caseName:          (p.caseName || '').trim(),
      facts:             clean(p.facts),
      proceduralHistory: clean(p.proceduralHistory),
      issue:             clean(p.issue),
      holding:           clean(p.holding),
      reasoning:         clean(p.reasoning),
    }))
    .filter(p => p.caseName);
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
  initCloud, clearCloud, flushPendingSave,
  callClaude, callClaudeRich, callAnthropicAPI, callBuiltIn,
  parseTOC, basicCleanTOC, basicCleanContent,
  aiCleanTOC,
  extractCasesFromContent,
  generateQuizBatch,
  generateBriefsHTML,
  generateMissReportHTML,
  generateRedFlagReview,
  readBriefFile,
  extractBriefsFromText,
  qKey,
  genId,
};
