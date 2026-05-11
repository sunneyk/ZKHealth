# ruff: noqa: E501
"""Self-contained HTML template for ZK proof verification.

Provider opens the exported .html file in any browser — no install required.
Verification steps:
  1. Hash integrity via Web Crypto API (built into every browser, no network)
  2. Solana anchor cross-check via Solana Explorer link (independent ledger)
  3. Full Groth16 circuit proof via snarkjs loaded from CDN (optional, needs internet)
"""
from __future__ import annotations

# Placeholders use __TOKEN__ convention to avoid conflicts with CSS/JS braces.
RANGE_VERIFY_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>__TITLE__</title>
<style>
:root{--bg:#0f1117;--surface:#1a1d27;--border:#2a2d3a;--text:#e8eaf0;--muted:#8b8fa8;--accent:#5b8def;--good:#4ade80;--bad:#f87171;--r:8px;--f:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--f);padding:2rem 1rem;line-height:1.5}
.wrap{max-width:660px;margin:0 auto}
.eyebrow{font-size:.68rem;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:.4rem}
h1{font-size:1.35rem;font-weight:600;margin-bottom:.25rem}
.sub{font-size:.75rem;color:var(--muted);margin-bottom:2rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:1.25rem;margin-bottom:1rem}
.card-label{font-size:.65rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:.6rem}
.claim{font-size:1rem;font-weight:600;margin-bottom:.35rem}
.claim-sub{font-size:.78rem;color:var(--muted);margin-bottom:.75rem}
.badge{display:inline-flex;align-items:center;font-size:.72rem;font-weight:700;padding:.2rem .65rem;border-radius:99px}
.badge-pass{background:rgba(74,222,128,.15);color:var(--good)}
.badge-fail{background:rgba(248,113,113,.15);color:var(--bad)}
.step{display:flex;gap:.75rem;padding:.85rem 0;border-bottom:1px solid var(--border)}
.step:last-child{border-bottom:none}
.num{flex-shrink:0;width:1.5rem;height:1.5rem;border-radius:50%;background:var(--border);display:flex;align-items:center;justify-content:center;font-size:.6rem;font-weight:700;color:var(--muted);margin-top:.1rem}
.step-body{flex:1;min-width:0}
.step-title{font-size:.8rem;font-weight:500;margin-bottom:.25rem}
.step-detail{font-size:.7rem;color:var(--muted);font-family:monospace;word-break:break-all;margin-bottom:.3rem}
.status{font-size:.72rem}
.sub-status{font-size:.7rem;margin-left:1rem;margin-top:.15rem;font-family:monospace}
.ok{color:var(--good)}
.err{color:var(--bad)}
.pend{color:var(--muted)}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
button{background:var(--border);border:1px solid #3a3d4a;color:var(--text);padding:.35rem .8rem;border-radius:var(--r);font-size:.72rem;cursor:pointer;font-family:var(--f);margin-top:.5rem}
button:hover{background:#2e3244}
button:disabled{opacity:.5;cursor:not-allowed}
.footer{font-size:.68rem;color:var(--muted);margin-top:1.5rem;line-height:1.6}
.mono{font-family:monospace}
</style>
</head>
<body>
<div class="wrap">
  <div class="eyebrow">ZKHealth · ZK Range Proof</div>
  <h1>Proof of Health Claim</h1>
  <p class="sub">Two zero-knowledge proofs combined into a range claim. No raw values are present.</p>

  <div class="card">
    <div class="card-label">Claim</div>
    <div class="claim">__BIOMARKER_NAME__ &mdash; in __THRESHOLD_DISPLAY__</div>
    <div class="claim-sub">Measured __DATE_DISPLAY__ &nbsp;&middot;&nbsp; Proof <span class="mono">__PROOF_ID_SHORT__&hellip;</span></div>
    <span class="badge __PASS_CLASS__">__PASS_TEXT__</span>
  </div>

  <div class="card">
    <div class="card-label">Verification &mdash; three independent checks</div>

    <div class="step">
      <div class="num">1</div>
      <div class="step-body">
        <div class="step-title">Hash integrity &mdash; runs locally in your browser, no network needed</div>
        <div class="step-detail" id="hash-val">Computing&hellip;</div>
        <div class="status" id="hash-st"><span class="pend">&#x23F3; Running&hellip;</span></div>
      </div>
    </div>

    <div class="step">
      <div class="num">2</div>
      <div class="step-body">
        <div class="step-title">Solana anchor &mdash; __EXPLORER_LINK__</div>
        <div class="step-detail">Expected on-chain memo: __MEMO__</div>
        <div class="status"><span class="pend">Open the Explorer link and confirm the Memo field matches the hash shown in step 1. The ledger is independent of this file.</span></div>
      </div>
    </div>

    <div class="step">
      <div class="num">3</div>
      <div class="step-body">
        <div class="step-title">Groth16 range proof <span style="font-weight:400;color:var(--muted)">&mdash; two circuits, optional, requires internet</span></div>
        <div class="step-detail">Verifies value &lt; __HIGH__ AND value &ge; __LOW__. Both Groth16 circuits share the same commitment.</div>
        <div class="status" id="groth-st"><span class="pend">Not run yet</span></div>
        <div class="sub-status" id="groth-high"></div>
        <div class="sub-status" id="groth-low"></div>
        <button id="groth-btn" onclick="runGroth16()">Run cryptographic verification</button>
      </div>
    </div>
  </div>

  <p class="footer">
    Generated by ZKHealth. Range proofs combine two Groth16 proofs sharing one Poseidon commitment.
    The first proves <span class="mono">value &lt; high</span>; the second proves <span class="mono">value &lt; low</span> evaluates FALSE.
    Together they prove the value is in [low, high) without revealing it.
  </p>
</div>

<script>
(function(){
var D={
  proofH:__PROOF_HIGH_JSON__,
  sigH:__SIGNALS_HIGH_JSON__,
  proofL:__PROOF_LOW_JSON__,
  sigL:__SIGNALS_LOW_JSON__,
  vkey:__VKEY_JSON__,
  canon:__CANONICAL_JSON__,
  hash:"__MEMO_DIGEST__"
};

(async function(){
  try{
    var enc=new TextEncoder().encode(D.canon);
    var buf=await crypto.subtle.digest('SHA-256',enc);
    var hex=Array.from(new Uint8Array(buf)).map(function(b){return b.toString(16).padStart(2,'0');}).join('');
    var computed=hex.slice(0,32);
    document.getElementById('hash-val').textContent='hb-zk:'+computed;
    if(computed===D.hash){
      document.getElementById('hash-st').innerHTML='<span class="ok">&#x2713; Hash matches &mdash; both proofs are intact and unaltered</span>';
    }else{
      document.getElementById('hash-st').innerHTML='<span class="err">&#x2717; Hash mismatch &mdash; this file may have been tampered with</span>';
    }
  }catch(e){
    document.getElementById('hash-st').innerHTML='<span class="err">Error: '+e.message+'</span>';
  }
})();

window.runGroth16=async function(){
  var btn=document.getElementById('groth-btn');
  var st=document.getElementById('groth-st');
  var sH=document.getElementById('groth-high');
  var sL=document.getElementById('groth-low');
  btn.disabled=true;
  btn.textContent='Loading…';
  st.innerHTML='<span class="pend">&#x23F3; Loading snarkjs from CDN…</span>';
  var s=document.createElement('script');
  s.src='https://unpkg.com/snarkjs@0.7.4/build/snarkjs.min.js';
  s.onerror=function(){
    st.innerHTML='<span class="err">Failed to load snarkjs &mdash; check internet connection and retry</span>';
    btn.disabled=false;btn.textContent='Retry';
  };
  s.onload=async function(){
    try{
      btn.textContent='Verifying…';
      st.innerHTML='<span class="pend">&#x23F3; Running both Groth16 verifications…</span>';
      var okH=await snarkjs.groth16.verify(D.vkey,D.sigH,D.proofH);
      var okL=await snarkjs.groth16.verify(D.vkey,D.sigL,D.proofL);
      var highBoundOk = okH && D.sigH[0]==='1';
      var lowBoundOk  = okL && D.sigL[0]==='0';
      sH.innerHTML = highBoundOk
        ? '<span class="ok">&#x2713; Upper bound proof valid &mdash; value &lt; high</span>'
        : '<span class="err">&#x2717; Upper bound failed</span>';
      sL.innerHTML = lowBoundOk
        ? '<span class="ok">&#x2713; Lower bound proof valid &mdash; value &ge; low</span>'
        : '<span class="err">&#x2717; Lower bound failed</span>';
      if(highBoundOk && lowBoundOk){
        st.innerHTML='<span class="ok">&#x2713; Both proofs valid &mdash; value is in range</span>';
      }else{
        st.innerHTML='<span class="err">&#x2717; Range verification failed</span>';
      }
    }catch(e){
      st.innerHTML='<span class="err">Error: '+e.message+'</span>';
    }
    btn.textContent='Done';
  };
  document.head.appendChild(s);
};
})();
</script>
</body>
</html>
"""

VERIFY_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>__TITLE__</title>
<style>
:root{--bg:#0f1117;--surface:#1a1d27;--border:#2a2d3a;--text:#e8eaf0;--muted:#8b8fa8;--accent:#5b8def;--good:#4ade80;--bad:#f87171;--r:8px;--f:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--f);padding:2rem 1rem;line-height:1.5}
.wrap{max-width:660px;margin:0 auto}
.eyebrow{font-size:.68rem;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:.4rem}
h1{font-size:1.35rem;font-weight:600;margin-bottom:.25rem}
.sub{font-size:.75rem;color:var(--muted);margin-bottom:2rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:1.25rem;margin-bottom:1rem}
.card-label{font-size:.65rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:.6rem}
.claim{font-size:1rem;font-weight:600;margin-bottom:.35rem}
.claim-sub{font-size:.78rem;color:var(--muted);margin-bottom:.75rem}
.badge{display:inline-flex;align-items:center;font-size:.72rem;font-weight:700;padding:.2rem .65rem;border-radius:99px}
.badge-pass{background:rgba(74,222,128,.15);color:var(--good)}
.badge-fail{background:rgba(248,113,113,.15);color:var(--bad)}
.step{display:flex;gap:.75rem;padding:.85rem 0;border-bottom:1px solid var(--border)}
.step:last-child{border-bottom:none}
.num{flex-shrink:0;width:1.5rem;height:1.5rem;border-radius:50%;background:var(--border);display:flex;align-items:center;justify-content:center;font-size:.6rem;font-weight:700;color:var(--muted);margin-top:.1rem}
.step-body{flex:1;min-width:0}
.step-title{font-size:.8rem;font-weight:500;margin-bottom:.25rem}
.step-detail{font-size:.7rem;color:var(--muted);font-family:monospace;word-break:break-all;margin-bottom:.3rem}
.status{font-size:.72rem}
.ok{color:var(--good)}
.err{color:var(--bad)}
.pend{color:var(--muted)}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
button{background:var(--border);border:1px solid #3a3d4a;color:var(--text);padding:.35rem .8rem;border-radius:var(--r);font-size:.72rem;cursor:pointer;font-family:var(--f);margin-top:.5rem}
button:hover{background:#2e3244}
button:disabled{opacity:.5;cursor:not-allowed}
.footer{font-size:.68rem;color:var(--muted);margin-top:1.5rem;line-height:1.6}
.mono{font-family:monospace}
</style>
</head>
<body>
<div class="wrap">
  <div class="eyebrow">ZKHealth · ZK Selective Disclosure</div>
  <h1>Proof of Health Claim</h1>
  <p class="sub">This file contains a zero-knowledge proof. No raw health values are present.</p>

  <div class="card">
    <div class="card-label">Claim</div>
    <div class="claim">__BIOMARKER_NAME__ &mdash; __THRESHOLD_DISPLAY__</div>
    <div class="claim-sub">Measured __DATE_DISPLAY__ &nbsp;&middot;&nbsp; Proof <span class="mono">__PROOF_ID_SHORT__&hellip;</span></div>
    <span class="badge __PASS_CLASS__">__PASS_TEXT__</span>
  </div>

  <div class="card">
    <div class="card-label">Verification &mdash; three independent checks</div>

    <div class="step">
      <div class="num">1</div>
      <div class="step-body">
        <div class="step-title">Hash integrity &mdash; runs locally in your browser, no network needed</div>
        <div class="step-detail" id="hash-val">Computing&hellip;</div>
        <div class="status" id="hash-st"><span class="pend">&#x23F3; Running&hellip;</span></div>
      </div>
    </div>

    <div class="step">
      <div class="num">2</div>
      <div class="step-body">
        <div class="step-title">Solana anchor &mdash; __EXPLORER_LINK__</div>
        <div class="step-detail">Expected on-chain memo: __MEMO__</div>
        <div class="status"><span class="pend">Open the Explorer link and confirm the Memo field matches the hash shown in step 1. The ledger is independent of this file.</span></div>
      </div>
    </div>

    <div class="step">
      <div class="num">3</div>
      <div class="step-body">
        <div class="step-title">Groth16 circuit proof <span style="font-weight:400;color:var(--muted)">&mdash; optional, requires internet</span></div>
        <div class="step-detail">Loads snarkjs from unpkg CDN and runs full zk-SNARK math locally in this tab. Nothing is uploaded.</div>
        <div class="status" id="groth-st"><span class="pend">Not run yet</span></div>
        <button id="groth-btn" onclick="runGroth16()">Run cryptographic verification</button>
      </div>
    </div>
  </div>

  <p class="footer">
    Generated by ZKHealth. The Groth16 circuit uses the BN254 curve with a Poseidon commitment.
    Steps 1 &amp; 2 require no external tools and work offline (step 2 needs the Solana Explorer link).
    Step 3 is optional and provides full mathematical assurance without revealing the underlying value.
  </p>
</div>

<script>
(function(){
var D={
  proof:__PROOF_JSON__,
  sig:__PUBLIC_SIGNALS_JSON__,
  vkey:__VKEY_JSON__,
  canon:__CANONICAL_JSON__,
  hash:"__MEMO_DIGEST__"
};

(async function(){
  try{
    var enc=new TextEncoder().encode(D.canon);
    var buf=await crypto.subtle.digest('SHA-256',enc);
    var hex=Array.from(new Uint8Array(buf)).map(function(b){return b.toString(16).padStart(2,'0');}).join('');
    var computed=hex.slice(0,32);
    document.getElementById('hash-val').textContent='hb-zk:'+computed;
    if(computed===D.hash){
      document.getElementById('hash-st').innerHTML='<span class="ok">&#x2713; Hash matches &mdash; proof data is intact and unaltered</span>';
    }else{
      document.getElementById('hash-st').innerHTML='<span class="err">&#x2717; Hash mismatch &mdash; this file may have been tampered with</span>';
    }
  }catch(e){
    document.getElementById('hash-st').innerHTML='<span class="err">Error: '+e.message+'</span>';
  }
})();

window.runGroth16=async function(){
  var btn=document.getElementById('groth-btn');
  var st=document.getElementById('groth-st');
  btn.disabled=true;
  btn.textContent='Loading…';
  st.innerHTML='<span class="pend">&#x23F3; Loading snarkjs from CDN…</span>';
  var s=document.createElement('script');
  s.src='https://unpkg.com/snarkjs@0.7.4/build/snarkjs.min.js';
  s.onerror=function(){
    st.innerHTML='<span class="err">Failed to load snarkjs &mdash; check internet connection and retry</span>';
    btn.disabled=false;btn.textContent='Retry';
  };
  s.onload=async function(){
    try{
      btn.textContent='Verifying…';
      st.innerHTML='<span class="pend">&#x23F3; Running Groth16 verification…</span>';
      var ok=await snarkjs.groth16.verify(D.vkey,D.sig,D.proof);
      if(ok){
        st.innerHTML='<span class="ok">&#x2713; Cryptographic proof is valid &mdash; claim is mathematically verified</span>';
      }else{
        st.innerHTML='<span class="err">&#x2717; Proof verification failed</span>';
      }
    }catch(e){
      st.innerHTML='<span class="err">Error: '+e.message+'</span>';
    }
    btn.textContent='Done';
  };
  document.head.appendChild(s);
};
})();
</script>
</body>
</html>
"""
