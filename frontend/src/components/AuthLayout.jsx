import React from 'react';

/**
 * AuthLayout — the responsive shell every auth screen sits in.
 *
 * The app used to render every screen inside a fixed `max-w-md` card, so on a
 * desktop monitor it was a phone-width column floating in the middle of the
 * page: a mobile layout served over the web rather than a web layout.
 *
 * Two shapes now:
 *
 *   narrow  a centred card, for short forms where extra width helps nobody
 *   split   on large screens, a two-column grid with the camera given the
 *           space it deserves and the guidance beside it; below `lg` the two
 *           columns simply stack, which is the right mobile layout
 *
 * The switch is driven by viewport width, not by user-agent sniffing, so
 * resizing a desktop window narrow gets the phone layout and a tablet in
 * landscape gets the wide one — which is what "it should switch" means in
 * practice.
 */

export const AuthCard = ({ children, className = '' }) => (
    <div
        className={
            'bg-slate-800/60 backdrop-blur-sm border border-slate-700/50 rounded-2xl ' +
            'p-6 sm:p-8 shadow-2xl animate-slide-up ' + className
        }
    >
        {children}
    </div>
);

export const AuthHeader = ({ icon, title, subtitle, compact = false }) => (
    <div className={`text-center ${compact ? 'mb-4' : 'mb-6'}`}>
        <div
            className="w-14 h-14 sm:w-16 sm:h-16 bg-primary-500/20 rounded-2xl flex items-center
                       justify-center text-2xl sm:text-3xl mx-auto mb-3 border border-primary-500/30"
            aria-hidden="true"
        >
            {icon}
        </div>
        <h1 className="text-xl sm:text-2xl font-bold text-white">{title}</h1>
        {subtitle && <p className="text-slate-400 text-sm mt-1">{subtitle}</p>}
    </div>
);

/** A centred column for forms. */
export const Narrow = ({ children }) => (
    <div className="w-full max-w-md mx-auto">{children}</div>
);

/**
 * Camera on one side, guidance on the other — side by side from `lg` up,
 * stacked below it.
 */
export const Split = ({ main, aside, maxWidth = 'max-w-5xl' }) => (
    <div className={`w-full ${maxWidth} mx-auto`}>
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-5 lg:gap-7 items-start">
            <div className="min-w-0">{main}</div>
            {/* Sticky on desktop so the guidance stays in view beside a tall
                camera preview; static on mobile where it simply follows. */}
            <div className="min-w-0 lg:sticky lg:top-20">{aside}</div>
        </div>
    </div>
);

/**
 * Hero — the desktop composition for the entry screens.
 *
 * A single narrow card centred in a 1440px viewport is still a mobile layout,
 * even if it is technically responsive. On a wide screen the space is used for
 * context beside the form; below `lg` the panel is dropped entirely rather than
 * pushed above the form, because on a phone the fastest thing is the field
 * itself, not an explanation of it.
 */
export const Hero = ({ children, title, tagline, points = [] }) => (
    <div className="w-full max-w-md lg:max-w-4xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] gap-10 items-center">
            <div className="hidden lg:block">
                <div className="flex items-center gap-3 mb-5">
                    <span className="text-4xl" aria-hidden="true">👁</span>
                    <span className="text-3xl font-bold bg-gradient-to-r from-primary-400 to-purple-400 bg-clip-text text-transparent">
                        BlinkAuth
                    </span>
                </div>
                <h2 className="text-4xl font-bold text-white leading-tight">{title}</h2>
                <p className="mt-3 text-slate-400 text-base leading-relaxed max-w-md">{tagline}</p>
                <ul className="mt-7 space-y-3">
                    {points.map((point) => (
                        <li key={point} className="flex items-start gap-3 text-slate-300 text-sm">
                            <span className="text-emerald-400 mt-0.5" aria-hidden="true">✓</span>
                            <span>{point}</span>
                        </li>
                    ))}
                </ul>
            </div>
            <div className="min-w-0">{children}</div>
        </div>
    </div>
);

export default AuthCard;
