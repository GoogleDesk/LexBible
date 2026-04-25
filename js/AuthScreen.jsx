// AuthScreen — sign-in gate (magic-link email) and "cloud not configured" notice
const { useState: useAuthState } = React;

function ConfigMissingScreen() {
  return (
    <div style={aS.root}>
      <div style={aS.card}>
        <div style={aS.brand}>LexBrother</div>
        <h2 style={aS.headline}>Cloud storage not configured</h2>
        <p style={aS.copy}>
          Open <code style={aS.code}>js/config.js</code> and fill in your Supabase
          project URL and anon key. Instructions are in <code style={aS.code}>README.md</code>.
        </p>
      </div>
    </div>
  );
}

function AuthScreen({ supabase }) {
  const [email,  setEmail]  = useAuthState('');
  // idle | checking | sending | sent | not-allowed | joining | waitlisted | error
  const [phase,  setPhase]  = useAuthState('idle');
  const [errMsg, setErrMsg] = useAuthState('');

  const cleanEmail = email.trim().toLowerCase();

  async function submitEmail(e) {
    e.preventDefault();
    if (!/.+@.+\..+/.test(cleanEmail)) {
      setPhase('error'); setErrMsg('Please enter a valid email address.');
      return;
    }
    setPhase('checking'); setErrMsg('');
    try {
      const { data: allowed, error: rpcErr } = await supabase.rpc(
        'is_email_allowed', { email_input: cleanEmail },
      );
      if (rpcErr) throw rpcErr;
      if (!allowed) { setPhase('not-allowed'); return; }

      setPhase('sending');
      const { error } = await supabase.auth.signInWithOtp({
        email: cleanEmail,
        // Always land on site root after sign-in; routing then takes over.
        options: { emailRedirectTo: window.location.origin + '/' },
      });
      if (error) throw error;
      setPhase('sent');
    } catch (err) {
      setPhase('error');
      setErrMsg(err.message || 'Could not send the sign-in email.');
    }
  }

  async function joinWaitlist() {
    setPhase('joining'); setErrMsg('');
    try {
      // Plain insert (not upsert) — supabase-js upsert internally consults the
      // UPDATE policy too, even with ignoreDuplicates, which would force us to
      // grant UPDATE just to avoid that. INSERT + tolerate unique-violation is
      // the same end result with one fewer policy.
      const { error } = await supabase
        .from('waitlist')
        .insert({ email: cleanEmail });
      // 23505 = unique_violation (already on the list). Treat as success.
      if (error && error.code !== '23505') throw error;
      setPhase('waitlisted');
    } catch (err) {
      // Stay on the not-allowed panel so the error has context, instead of
      // falling through to the sign-in form.
      setPhase('not-allowed');
      setErrMsg(err.message || 'Could not add you to the waitlist.');
    }
  }

  function reset() {
    setPhase('idle'); setErrMsg(''); setEmail('');
  }

  return (
    <div style={aS.root}>
      <div style={aS.card}>
        <div style={aS.brand}>LexBrother</div>

        {phase === 'sent' ? (
          <>
            <h2 style={aS.headline}>Check your inbox</h2>
            <div style={aS.sentBox}>
              We sent a sign-in link to
              <div style={aS.sentEmail}>{cleanEmail}</div>
              Click the link to finish signing in. You can close this tab —
              the link opens LexBrother directly.
            </div>
          </>
        ) : phase === 'not-allowed' ? (
          <>
            <h2 style={aS.headline}>Not currently accepting new users</h2>
            <p style={aS.copy}>
              LexBrother is invite-only right now. If you're interested, we
              can add <strong>{cleanEmail}</strong> to the waitlist and email
              you when access opens up.
            </p>
            <button onClick={joinWaitlist} disabled={phase === 'joining'} style={aS.btn}>
              {phase === 'joining' ? 'Adding…' : 'Add me to the waitlist'}
            </button>
            <button onClick={reset} style={aS.btnGhost}>Use a different email</button>
            {errMsg && <div style={aS.err}>{errMsg}</div>}
          </>
        ) : phase === 'waitlisted' ? (
          <>
            <h2 style={aS.headline}>You're on the list</h2>
            <div style={aS.sentBox}>
              We'll email
              <div style={aS.sentEmail}>{cleanEmail}</div>
              when access opens up. Thanks for your interest.
            </div>
          </>
        ) : (
          <>
            <h2 style={aS.headline}>Sign in to sync across devices</h2>
            <p style={aS.copy}>
              Enter your email and we'll send you a one-click sign-in link. No
              password to remember. Your data (courses, chapters, quizzes, briefs)
              lives in your Supabase project.
            </p>
            <form onSubmit={submitEmail}>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoFocus
                style={aS.input}
                disabled={phase === 'checking' || phase === 'sending'}
              />
              <button
                type="submit"
                disabled={phase === 'checking' || phase === 'sending' || !email.trim()}
                style={aS.btn}>
                {phase === 'checking' ? 'Checking…'
                  : phase === 'sending'  ? 'Sending link…'
                  : 'Email me a sign-in link'}
              </button>
              {phase === 'error' && <div style={aS.err}>{errMsg}</div>}
            </form>
          </>
        )}
      </div>
    </div>
  );
}

const aS = {
  root: {
    position:'fixed', inset:0, display:'flex', alignItems:'center',
    justifyContent:'center', background:'#F8F6F1', padding:20,
    fontFamily:'"Lora", Georgia, serif',
  },
  card: {
    background:'white', border:'1px solid #E2D9CC', borderRadius:12,
    padding:'36px 34px', maxWidth:440, width:'100%',
    boxShadow:'0 10px 40px rgba(26,39,68,.08)',
  },
  brand: {
    fontFamily:'"Playfair Display", Georgia, serif', fontWeight:700,
    fontSize:22, color:'#2A6049', letterSpacing:'0.5px', marginBottom:20,
  },
  headline: {
    fontFamily:'"Playfair Display", Georgia, serif', fontWeight:600,
    fontSize:22, color:'#1A1714', margin:'0 0 10px',
  },
  copy: { fontSize:14, lineHeight:1.55, color:'#6B5B47', margin:'0 0 22px' },
  code: { fontFamily:'ui-monospace, Menlo, Consolas, monospace', fontSize:12, background:'#F5EFE6', padding:'1px 5px', borderRadius:3 },
  input: {
    width:'100%', padding:'11px 13px', fontSize:14, border:'1px solid #D0C4A8',
    borderRadius:6, fontFamily:'inherit', marginBottom:10, background:'#FFF',
  },
  btn: {
    width:'100%', padding:'11px 14px', fontSize:14, fontWeight:600,
    background:'#2A6049', color:'white', border:'none', borderRadius:6,
    cursor:'pointer', fontFamily:'inherit',
  },
  btnGhost: {
    width:'100%', padding:'10px 14px', fontSize:13.5, fontWeight:500,
    background:'none', color:'#6B5B47', border:'1px solid #E2D9CC',
    borderRadius:6, cursor:'pointer', fontFamily:'inherit', marginTop:8,
  },
  err: { marginTop:12, fontSize:13, color:'#9B2335' },
  sentBox: {
    background:'#F5EFE6', border:'1px solid #E2D9CC', borderRadius:6,
    padding:'14px 16px', fontSize:14, lineHeight:1.55, color:'#1A1714',
  },
  sentEmail: {
    fontFamily:'ui-monospace, Menlo, Consolas, monospace',
    fontSize:13, margin:'6px 0 8px', color:'#2A6049',
  },
};

window.AuthScreen         = AuthScreen;
window.ConfigMissingScreen = ConfigMissingScreen;
