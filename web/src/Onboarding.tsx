import React, { useState, useEffect } from "react";
import Mascot from "./components/Mascot";
import { ProgressBar } from "./components/ProgressBar";
const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:wght@300;400;500&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  html, body, #root {
    height: 100%;
    width: 100%;
    margin: 0;
    padding: 0;
    overflow: hidden;
  }

  @keyframes enterWave {
    0%   { transform: translateX(-160px) rotate(0deg) scale(0.8); opacity: 0; }
    35%  { transform: translateX(14px) rotate(-12deg) scale(1.05); opacity: 1; }
    55%  { transform: translateX(-5px) rotate(9deg); }
    75%  { transform: translateX(3px) rotate(-5deg); }
    100% { transform: translateX(0) rotate(0deg) scale(1); opacity: 1; }
  }

  @keyframes idle {
    0%, 100% { transform: translateY(0px) rotate(0.2deg); }
    50%       { transform: translateY(-6px) rotate(-0.2deg); }
  }

  @keyframes fadeSlideUp {
    from { opacity: 0; transform: translateY(20px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  @keyframes pulseGlow {
    0%, 100% { box-shadow: 0 0 0 0 rgba(74,222,128,0.3); }
    50%       { box-shadow: 0 0 0 10px rgba(74,222,128,0); }
  }

  @keyframes checkPop {
    0%   { transform: scale(0) rotate(-30deg); opacity: 0; }
    60%  { transform: scale(1.3) rotate(5deg); opacity: 1; }
    100% { transform: scale(1) rotate(0deg); opacity: 1; }
  }

  @keyframes shimmer {
    0%   { background-position: -200% center; }
    100% { background-position: 200% center; }
  }

  @keyframes glowPulse {
    0%, 100% { opacity: 0.35; transform: translateX(-50%) scale(1); }
    50%       { opacity: 0.6; transform: translateX(-50%) scale(1.15); }
  }

  @keyframes mascotSwap {
    0%   { opacity: 0; transform: translateX(-30px) scale(0.92); }
    100% { opacity: 1; transform: translateX(0) scale(1); }
  }

  .mascot-enter { animation: enterWave 1.3s cubic-bezier(0.34,1.56,0.64,1) forwards; }
  .mascot-idle  { animation: idle 5s ease-in-out infinite; }
  .mascot-swap  { animation: mascotSwap 0.5s cubic-bezier(0.34,1.56,0.64,1) forwards; }
  .fade-up      { animation: fadeSlideUp 0.5s ease forwards; }
  .check-anim   { animation: checkPop 0.4s cubic-bezier(0.34,1.56,0.64,1) forwards; }

  .shimmer-name {
    background: linear-gradient(90deg, #4ade80, #a3e635, #4ade80);
    background-size: 200% auto;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    animation: shimmer 2.5s linear infinite;
  }

  .niro-input {
    background: rgba(255,255,255,0.04);
    border: 1.5px solid rgba(255,255,255,0.1);
    border-radius: 14px;
    color: #fff;
    font-family: 'DM Sans', sans-serif;
    font-size: 15px;
    outline: none;
    padding: 14px 18px;
    width: 100%;
    transition: border-color 0.2s;
  }
  .niro-input:focus { border-color: rgba(74,222,128,0.55); background: rgba(74,222,128,0.03); }
  .niro-input::placeholder { color: rgba(255,255,255,0.25); }

  .niro-btn {
    background: #4ade80;
    border: none;
    border-radius: 12px;
    color: #0b0b0b;
    cursor: pointer;
    font-family: 'DM Sans', sans-serif;
    font-size: 15px;
    font-weight: 700;
    padding: 14px 32px;
    transition: background 0.2s, transform 0.15s;
    animation: pulseGlow 2.5s ease infinite;
    white-space: nowrap;
  }
  .niro-btn:hover { background: #86efac; transform: translateY(-2px); }
  .niro-btn:active { transform: scale(0.97); }

  .niro-btn-ghost {
    background: rgba(255,255,255,0.05);
    border: 1.5px solid rgba(255,255,255,0.1);
    border-radius: 12px;
    color: rgba(255,255,255,0.6);
    cursor: pointer;
    font-family: 'DM Sans', sans-serif;
    font-size: 15px;
    padding: 14px 32px;
    transition: all 0.2s;
  }
  .niro-btn-ghost:hover { background: rgba(255,255,255,0.09); color: #fff; border-color: rgba(255,255,255,0.2); }

  .back-btn {
    background: transparent;
    border: none;
    color: rgba(255,255,255,0.35);
    cursor: pointer;
    font-family: 'DM Sans', sans-serif;
    font-size: 14px;
    padding: 8px 0;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: color 0.2s;
    margin-bottom: 8px;
  }
  .back-btn:hover { color: rgba(255,255,255,0.75); }
  .back-btn svg { width: 16px; height: 16px; transition: transform 0.2s; }
  .back-btn:hover svg { transform: translateX(-3px); }

  .progress-track {
    height: 3px;
    background: rgba(255,255,255,0.07);
    border-radius: 99px;
    overflow: hidden;
    width: 100%;
    margin-bottom: 32px;
  }
  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #4ade80, #a3e635);
    border-radius: 99px;
    transition: width 0.6s cubic-bezier(0.4,0,0.2,1);
  }

  .feat-icon svg { width: 20px; height: 20px; }
`;

type Frame = "hero" | "about" | "building" | "ready" | "done";
interface UserInfo { email: string; name: string; role: string; }


// ── SVG Icons ──────────────────────────────────────────────────────────────────
const IconSparkle = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>
  </svg>
);
const IconBolt = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 2L4.5 13.5H11L10 22l9-12h-6.5z" fill="rgba(74,222,128,0.15)"/>
  </svg>
);
const IconShield = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2L3 7v5c0 5.5 3.8 10.7 9 12 5.2-1.3 9-6.5 9-12V7z" fill="rgba(74,222,128,0.1)"/>
    <path d="M9 12l2 2 4-4"/>
  </svg>
);
const IconDot = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2">
    <circle cx="12" cy="12" r="4" fill="rgba(74,222,128,0.2)"/>
    <circle cx="12" cy="12" r="8" strokeDasharray="2 3"/>
  </svg>
);
const IconBack = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 12H5M12 5l-7 7 7 7"/>
  </svg>
);

// ── Back Button ────────────────────────────────────────────────────────────────
function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="back-btn" onClick={onClick}>
      <IconBack /> Back
    </button>
  );
}

// ── Hero Frame ─────────────────────────────────────────────────────────────────
function HeroFrame({ onNext, setEmail }: { onNext: () => void; setEmail: (e: string) => void }) {
  const [val, setVal] = useState("");
  const features = [
    { icon: <IconSparkle />, title: "Understands you", sub: "Learns your flow" },
    { icon: <IconBolt />,    title: "Handles tasks",   sub: "Small things done" },
    { icon: <IconShield />,  title: "Private",         sub: "Your data stays yours" },
    { icon: <IconDot />,     title: "Always there",    sub: "Quietly present" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "28px", width: "100%" }}>
      <div className="fade-up" style={{ animationDelay: "0.05s", opacity: 0 }}>
        <p style={{ color: "rgba(255,255,255,0.4)", fontSize: "14px", marginBottom: "10px", fontFamily: "'DM Sans'" }}>Meet your</p>
        <h1 style={{ fontFamily: "'Syne',sans-serif", fontSize: "clamp(52px,5.5vw,80px)", fontWeight: 800, lineHeight: 1, letterSpacing: "-0.02em" }}>
          new<br />buddy<span style={{ color: "#4ade80" }}>.</span>
        </h1>
      </div>

      <p className="fade-up" style={{ animationDelay: "0.15s", opacity: 0, color: "rgba(255,255,255,0.45)", fontSize: "15px", fontFamily: "'DM Sans'", lineHeight: 1.75, maxWidth: "380px" }}>
        An AI that lives quietly on your desktop, understands how you work, and helps without getting in your way.
      </p>

      <div className="fade-up" style={{ animationDelay: "0.25s", opacity: 0 }}>
        <div style={{ display: "flex", gap: "10px" }}>
          <input className="niro-input" placeholder="Enter your email..."
            value={val} onChange={e => setVal(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && val) { setEmail(val); onNext(); } }}
          />
          <button className="niro-btn" onClick={() => { if (val) { setEmail(val); onNext(); } else onNext(); }}>
            Get Started
          </button>
        </div>
        <p style={{ fontSize: "12px", color: "rgba(255,255,255,0.28)", marginTop: "10px", cursor: "pointer", textDecoration: "underline", fontFamily: "'DM Sans'" }}
          onClick={onNext}>Try without sign-in</p>
      </div>

      <div className="fade-up" style={{ animationDelay: "0.38s", opacity: 0, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginTop: "4px" }}>
        {features.map(f => (
          <div key={f.title} style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
            <div className="feat-icon" style={{
              width: "40px", height: "40px", borderRadius: "10px",
              background: "rgba(74,222,128,0.07)",
              border: "1px solid rgba(74,222,128,0.18)",
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0,
            }}>{f.icon}</div>
            <div>
              <p style={{ fontFamily: "'DM Sans'", fontSize: "13px", color: "#fff", fontWeight: 500, marginBottom: "2px" }}>{f.title}</p>
              <p style={{ fontFamily: "'DM Sans'", fontSize: "12px", color: "rgba(255,255,255,0.38)" }}>{f.sub}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── About Frame ────────────────────────────────────────────────────────────────
function AboutFrame({ onNext, onBack, setName, setRole }: { onNext: () => void; onBack: () => void; setName: (n: string) => void; setRole: (r: string) => void }) {
  const [nameVal, setNameVal] = useState("");
  const [roleVal, setRoleVal] = useState("");
  const roles = ["Designer", "Engineer", "Product", "Writer", "Founder", "Other"];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px", width: "100%" }}>
      <BackButton onClick={onBack} />
      <div className="fade-up" style={{ animationDelay: "0.05s", opacity: 0 }}>
        <p style={{ color: "rgba(255,255,255,0.4)", fontSize: "14px", marginBottom: "10px", fontFamily: "'DM Sans'" }}>Tell me</p>
        <h1 style={{ fontFamily: "'Syne',sans-serif", fontSize: "clamp(46px,5vw,68px)", fontWeight: 800, lineHeight: 1, letterSpacing: "-0.02em" }}>
          about<br /><span style={{ color: "#4ade80" }}>you</span>
        </h1>
      </div>
      <p className="fade-up" style={{ animationDelay: "0.15s", opacity: 0, color: "rgba(255,255,255,0.4)", fontSize: "14px", fontFamily: "'DM Sans'", lineHeight: 1.7 }}>
        Just two things — your name and what you do. Easy, right?
      </p>
      <div className="fade-up" style={{ animationDelay: "0.22s", opacity: 0, display: "flex", flexDirection: "column", gap: "12px" }}>
        <input className="niro-input" placeholder="What should I call you?" value={nameVal} onChange={e => setNameVal(e.target.value)} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "8px" }}>
          {roles.map(r => (
            <button key={r} onClick={() => setRoleVal(r)} style={{
              background: roleVal === r ? "rgba(74,222,128,0.12)" : "rgba(255,255,255,0.04)",
              border: `1.5px solid ${roleVal === r ? "rgba(74,222,128,0.5)" : "rgba(255,255,255,0.08)"}`,
              borderRadius: "10px", color: roleVal === r ? "#4ade80" : "rgba(255,255,255,0.5)",
              cursor: "pointer", fontFamily: "'DM Sans'", fontSize: "13px", padding: "10px 4px",
              transition: "all 0.18s", fontWeight: roleVal === r ? 600 : 400,
            }}>{r}</button>
          ))}
        </div>
      </div>
      <div className="fade-up" style={{ animationDelay: "0.35s", opacity: 0 }}>
        <button className="niro-btn" style={{ width: "100%" }}
          onClick={() => { if (nameVal) { setName(nameVal); setRole(roleVal || "Other"); onNext(); } else onNext(); }}>
          That's me →
        </button>
      </div>
    </div>
  );
}

// ── Building Frame ─────────────────────────────────────────────────────────────
const BUILDING_STEPS = ["Analysing how you communicate", "Learning your habits & workflow", "Configuring your privacy settings"];

function BuildingFrame({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {

  const [done, setDone] = useState<number[]>([]);
  const [started, setStarted] = useState(false);
  const onDoneRef = React.useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const tStart = setTimeout(() => setStarted(true), 10);
    BUILDING_STEPS.forEach((_, i) => setTimeout(() => setDone(d => [...d, i]), 900 + i * 950));
    const t = setTimeout(() => onDoneRef.current(), 900 + BUILDING_STEPS.length * 950 + 700);
    return () => {
      clearTimeout(t);
      clearTimeout(tStart);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // empty deps — run once; onDone captured via ref above

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "28px", width: "100%" }}>
      {/* Only show back if not yet started processing */}
      {!started && <BackButton onClick={onBack} />}
      <div className="fade-up" style={{ animationDelay: "0.05s", opacity: 0 }}>
        <p style={{ color: "rgba(255,255,255,0.4)", fontSize: "14px", marginBottom: "10px", fontFamily: "'DM Sans'" }}>Building</p>
        <h1 style={{ fontFamily: "'Syne',sans-serif", fontSize: "clamp(46px,5vw,68px)", fontWeight: 800, lineHeight: 1, letterSpacing: "-0.02em" }}>
          your<br /><span style={{ color: "#4ade80" }}>buddy</span>
        </h1>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {BUILDING_STEPS.map((s, i) => (
          <div key={s} className="fade-up" style={{ animationDelay: `${0.12 + i * 0.1}s`, opacity: 0, display: "flex", alignItems: "center", gap: "14px" }}>
            <div style={{
              width: "26px", height: "26px", borderRadius: "50%",
              border: `2px solid ${done.includes(i) ? "#4ade80" : "rgba(255,255,255,0.12)"}`,
              background: done.includes(i) ? "rgba(74,222,128,0.12)" : "transparent",
              display: "flex", alignItems: "center", justifyContent: "center",
              transition: "all 0.35s", flexShrink: 0,
            }}>
              {done.includes(i) && <span className="check-anim" style={{ color: "#4ade80", fontSize: "13px", fontWeight: 800 }}>✓</span>}
            </div>
            <span style={{ fontFamily: "'DM Sans'", fontSize: "15px", color: done.includes(i) ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.3)", transition: "color 0.35s" }}>{s}</span>
          </div>
        ))}
      </div>
      <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: "99px", height: "5px", overflow: "hidden" }}>
        <div style={{ height: "100%", background: "linear-gradient(90deg,#4ade80,#a3e635)", borderRadius: "99px", width: `${Math.min(100, (done.length / BUILDING_STEPS.length) * 100)}%`, transition: "width 0.8s cubic-bezier(0.4,0,0.2,1)" }} />
      </div>
    </div>
  );
}

// ── Ready Frame ────────────────────────────────────────────────────────────────
function ReadyFrame({ name, onNext, onBack }: { name: string; onNext: () => void; onBack: () => void }) {
  const [plat, setPlat] = useState("Windows");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px", width: "100%" }}>
      <BackButton onClick={onBack} />
      <div className="fade-up" style={{ animationDelay: "0.05s", opacity: 0 }}>
        <p style={{ color: "rgba(255,255,255,0.4)", fontSize: "14px", marginBottom: "10px", fontFamily: "'DM Sans'" }}>Your buddy</p>
        <h1 style={{ fontFamily: "'Syne',sans-serif", fontSize: "clamp(46px,5vw,68px)", fontWeight: 800, lineHeight: 1, letterSpacing: "-0.02em", wordBreak: "break-word" }}>
          {name ? <><span className="shimmer-name">{name}</span> it's<br /><span style={{ color: "#4ade80" }}>ready</span></> : <>is<br /><span style={{ color: "#4ade80" }}>ready</span></>}
        </h1>
      </div>
      <p className="fade-up" style={{ animationDelay: "0.15s", opacity: 0, color: "rgba(255,255,255,0.45)", fontSize: "14px", fontFamily: "'DM Sans'", lineHeight: 1.7 }}>
        What did I say? Your buddy is prepped — just download the app to get started.
      </p>
      <div className="fade-up" style={{ animationDelay: "0.25s", opacity: 0, display: "flex", gap: "8px" }}>
        {["Windows", "Linux"].map(p => (
          <button key={p} onClick={() => setPlat(p)} style={{
            background: plat === p ? "rgba(74,222,128,0.12)" : "rgba(255,255,255,0.04)",
            border: `1.5px solid ${plat === p ? "rgba(74,222,128,0.45)" : "rgba(255,255,255,0.08)"}`,
            borderRadius: "8px", color: plat === p ? "#4ade80" : "rgba(255,255,255,0.45)",
            cursor: "pointer", fontFamily: "'DM Sans'", fontSize: "13px", padding: "8px 18px", transition: "all 0.18s",
          }}>{p}</button>
        ))}
      </div>
      <div className="fade-up" style={{ animationDelay: "0.35s", opacity: 0 }}>
        <button className="niro-btn" style={{ width: "100%" }} onClick={onNext}>Launch me →</button>
      </div>
    </div>
  );
}

// ── Done Frame ─────────────────────────────────────────────────────────────────
function DoneFrame({ name, onBack }: { name: string; onBack: () => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "28px", width: "100%" }}>
      <BackButton onClick={onBack} />
      <div className="fade-up" style={{ animationDelay: "0.05s", opacity: 0 }}>
        <p style={{ color: "rgba(255,255,255,0.4)", fontSize: "14px", marginBottom: "10px", fontFamily: "'DM Sans'" }}>You are all set</p>
        <h1 style={{ fontFamily: "'Syne',sans-serif", fontSize: "clamp(52px,5.5vw,80px)", fontWeight: 800, lineHeight: 1, letterSpacing: "-0.02em" }}>
          <span className="shimmer-name">{name || "Hello"}</span>
        </h1>
      </div>
      <p className="fade-up" style={{ animationDelay: "0.18s", opacity: 0, color: "rgba(255,255,255,0.45)", fontSize: "14px", fontFamily: "'DM Sans'", lineHeight: 1.7 }}>
        Your buddy is ready. Download the app and I'll be right there when you open it.
      </p>
      <div className="fade-up" style={{ animationDelay: "0.28s", opacity: 0, display: "flex", gap: "12px" }}>
       <a href="https://github.com/Dealer-09/Niro/releases/download/v1.0.2/Niro.Setup.1.0.2.exe" style={{ flex: 1 }}>
        <button className="niro-btn" style={{ width: "100%" }}>
          ↓ Download App
        </button>
      </a>
        <button className="niro-btn-ghost">Share Niro</button>
      </div>
      <div className="fade-up" style={{ animationDelay: "0.4s", opacity: 0 }}>
        <div style={{ background: "rgba(74,222,128,0.06)", border: "1px solid rgba(74,222,128,0.18)", borderRadius: "14px", padding: "18px", display: "flex", alignItems: "center", gap: "16px" }}>
          
          <div>
            <p style={{ fontFamily: "'DM Sans'", fontSize: "14px", color: "rgba(255,255,255,0.9)", fontWeight: 600 }}>Early access unlocked</p>
            <p style={{ fontFamily: "'DM Sans'", fontSize: "12px", color: "rgba(255,255,255,0.35)", marginTop: "2px" }}>You're in the first wave. Tell a friend.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
export default function Onboarding() {
  const [frame, setFrame] = useState<Frame>("hero");
  const [info, setInfo] = useState<UserInfo>({ email: "", name: "", role: "" });

  useEffect(() => {
    const el = document.createElement("style");
    el.textContent = STYLES;
    document.head.appendChild(el);
    return () => el.remove();
  }, []);

  const go = (f: Frame) => setFrame(f);
  const showProgress = frame !== "hero" && frame !== "done";

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#0b0b0b", color: "#fff", display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>

      {/* left-side radial glow */}
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", background: "radial-gradient(ellipse at 25% 55%, rgba(34,197,94,0.16) 0%, transparent 55%)" }} />
    
      {/* BODY: mascot left, content right */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", flex: 1, minHeight: 0, position: "relative", zIndex: 10 }}>

        {/* LEFT: Mascot — aligned top-left */}
        <div style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "flex-start",
          padding: "10px 20px 40px 30px",
          minHeight: 0,
        }}>
          <Mascot frame={frame} />
        </div>

        {/* RIGHT: Content, vertically centered */}
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", padding: "40px 80px 40px 40px", minHeight: 0, overflowY: "auto" }}>
          {showProgress && <ProgressBar frame={frame} />}

          {frame === "hero"     && <HeroFrame onNext={() => go("about")} setEmail={e => setInfo(i => ({ ...i, email: e }))} />}
          {frame === "about"    && <AboutFrame onNext={() => go("building")} onBack={() => go("hero")} setName={n => setInfo(i => ({ ...i, name: n }))} setRole={r => setInfo(i => ({ ...i, role: r }))} />}
          {frame === "building" && <BuildingFrame onDone={() => go("ready")} onBack={() => go("about")} />}
          {frame === "ready"    && <ReadyFrame name={info.name} onNext={() => go("done")} onBack={() => go("about")} />}
          {frame === "done"     && <DoneFrame name={info.name} onBack={() => go("ready")} />}
        </div>
      </div>
    </div>
    
  );
}
