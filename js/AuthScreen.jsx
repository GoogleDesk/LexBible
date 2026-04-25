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
  const [phase,  setPhase]  = useAuthState('idle'); // idle | sending | sent | error
  const [errMsg, setErrMsg] = useAuthState('');

  async function sendMagicLink(e) {
    e.preventDefault();
    const clean = email.trim().toLowerCase();
    if (!/.+@.+\..+/.test(clean)) {
      setPhase('error'); setErrMsg('Please enter a valid email address.');
      return;
    }
    setPhase('sending'); setErrMsg('');
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: clean,
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

  return (
    <div style={aS.root}>
      <div style={aS.card}>
        <div style={aS.brand}>LexBrother</div>
        <h2 style={aS.headline}>Sign in to sync across devices</h2>
        <p style={aS.copy}>
          Enter your email and we'll send you a one-click sign-in link. No
          password to remember. Your data (courses, chapters, quizzes, briefs)
          lives in your Supabase project.
        </p>

        {phase === 'sent' ? (
          <div style={aS.sentBox}>
            <strong>Check your inbox.</strong> We sent a sign-in link to
            <div style={aS.sentEmail}>{email.trim().toLowerCase()}</div>
            Click the link to finish signing in. You can close this tab —
            the link opens LexBrother directly.
          </div>
        ) : (
          <form onSubmit={sendMagicLink}>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoFocus
              style={aS.input}
              disabled={phase === 'sending'}
            />
            <button
              type="submit"
              disabled={phase === 'sending' || !email.trim()}
              style={aS.btn}>
              {phase === 'sending' ? 'Sending link…' : 'Email me a sign-in link'}
            </button>
            {phase === 'error' && <div style={aS.err}>{errMsg}</div>}
          </form>
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
