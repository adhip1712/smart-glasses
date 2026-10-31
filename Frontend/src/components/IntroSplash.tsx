import { useEffect, useState } from 'react'

/**
 * Short branded opening based on the user's uploaded cyan, three-node logo reference.
 * This is an isolated overlay: the dashboard, existing background, routing and services
 * remain untouched underneath it.
 */
export default function IntroSplash({ onComplete }: { onComplete?: () => void }) {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setVisible(false)
      onComplete?.()
    }, 4200)
    return () => window.clearTimeout(timer)
  }, [onComplete])

  if (!visible) return null

  return (
    <div
      className="vn-intro fixed inset-0 z-[100] flex items-center justify-center overflow-hidden"
      role="presentation"
      aria-label="Visionary Nexus intro"
    >
      <div className="vn-intro__stars" aria-hidden="true" />
      <div className="relative z-10 flex w-full flex-col items-center px-6">
        <svg
          className="vn-intro__symbol"
          viewBox="0 0 240 220"
          role="img"
          aria-label="Visionary Nexus symbol"
        >
          <defs>
            <filter id="vn-neon-glow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="5" result="blur" />
              <feColorMatrix in="blur" type="matrix"
                values="0 0 0 0 0  0 0 0 0 0.65  0 0 0 0 1  0 0 0 0.9 0" result="blueGlow" />
              <feMerge><feMergeNode in="blueGlow" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          {/* Three identical, rotationally balanced strokes. Each stays in its own sector;
              none cross or overlap. The repeated geometry guarantees equal arm lengths. */}
          <g filter="url(#vn-neon-glow)" fill="none" stroke="#08bfff"
             strokeWidth="8" strokeLinecap="round" strokeLinejoin="round">
            {[0, 120, 240].map((angle) => (
              <g key={angle} transform={`rotate(${angle} 120 110)`}>
                <path className="vn-intro__stroke" pathLength="100"
                  d="M120 31 C120 52 136 58 151 68 C169 80 174 99 163 116 C153 132 137 137 123 143" />
              </g>
            ))}
          </g>
          <g className="vn-intro__nodes" fill="#08c5ff" filter="url(#vn-neon-glow)">
            {[0, 120, 240].map((angle) => (
              <circle key={angle} cx="120" cy="31" r="11"
                transform={`rotate(${angle} 120 110)`} />
            ))}
          </g>
        </svg>

        <div className="vn-intro__wordmark" aria-label="VISIONARY NEXUS">
          VISIONARY NEXUS
        </div>
        <div className="vn-intro__subtitle">SMART GLASSES</div>
      </div>

      <style>{`
        .vn-intro {
          background: radial-gradient(ellipse at 50% 42%, #061b3d 0%, #020d25 52%, #010719 100%);
          animation: vn-intro-exit .55s ease 3.65s forwards;
        }
        .vn-intro__stars {
          position: absolute; inset: 0; pointer-events: none;
          background-image: radial-gradient(rgba(0, 153, 255, .22) .8px, transparent .9px);
          background-size: 7px 7px;
          mask-image: radial-gradient(ellipse at center, black 0%, rgba(0,0,0,.65) 48%, transparent 86%);
          opacity: .32;
        }
        .vn-intro__symbol {
          width: clamp(145px, 23vw, 220px);
          height: auto;
          overflow: visible;
          margin-bottom: 22px;
        }
        .vn-intro__stroke {
          stroke-dasharray: 100;
          stroke-dashoffset: 100;
          animation: vn-symbol-draw 1.65s cubic-bezier(.55,.05,.25,1) forwards;
        }
        .vn-intro__nodes { opacity: 0; animation: vn-node-pop .35s ease 1.65s forwards; }
        .vn-intro__wordmark {
          color: #d9f5ff;
          font-family: 'Segoe Print', 'Bradley Hand', 'Comic Sans MS', cursive;
          font-size: clamp(25px, 4vw, 43px);
          font-weight: 500;
          letter-spacing: .13em;
          white-space: nowrap;
          text-shadow: 0 0 12px rgba(0,174,255,.75), 0 0 28px rgba(0,120,255,.35);
          clip-path: inset(0 100% 0 0);
          animation: vn-text-wipe 1.05s cubic-bezier(.22,.7,.25,1) 1.72s forwards;
        }
        .vn-intro__subtitle {
          margin-top: 13px;
          color: rgba(137,205,245,.9);
          font: 500 11px/1.4 'JetBrains Mono', monospace;
          letter-spacing: .42em;
          opacity: 0;
          animation: vn-subtitle-in .45s ease 2.25s forwards;
        }
        @keyframes vn-symbol-draw { to { stroke-dashoffset: 0; } }
        @keyframes vn-node-pop { from { opacity: 0; transform: scale(.65); transform-origin: center; } to { opacity: 1; transform: scale(1); } }
        @keyframes vn-text-wipe { to { clip-path: inset(0 0 0 0); } }
        @keyframes vn-subtitle-in { to { opacity: 1; } }
        @keyframes vn-intro-exit { to { opacity: 0; visibility: hidden; pointer-events: none; } }
        @media (prefers-reduced-motion: reduce) {
          .vn-intro, .vn-intro * { animation-duration: .01ms !important; animation-delay: 0ms !important; }
          .vn-intro__stroke { stroke-dashoffset: 0; }
          .vn-intro__nodes, .vn-intro__subtitle { opacity: 1; }
          .vn-intro__wordmark { clip-path: none; }
        }
      `}</style>
    </div>
  )
}
