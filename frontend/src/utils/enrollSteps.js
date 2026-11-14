/**
 * enrollSteps.js — the guided capture poses.
 *
 * `yawTarget` is the ratio produced by getPose(): positive means the subject
 * has turned toward their own left. Kept out of the component file so Vite's
 * fast refresh still works there (a module that exports a component may not
 * also export constants).
 */
export const ENROLL_STEPS = [
    {
        id: 'center',
        label: 'Look straight at the camera',
        detail: 'Keep your whole face in the frame',
        yawTarget: 0,
        yawTolerance: 0.055,
    },
    {
        id: 'left',
        label: 'Turn your head slightly to your LEFT',
        detail: 'A small turn is enough — keep your eyes on the screen',
        yawTarget: 0.13,
        yawTolerance: 0.06,
    },
    {
        id: 'right',
        label: 'Now turn slightly to your RIGHT',
        detail: 'Same again, the other way',
        yawTarget: -0.13,
        yawTolerance: 0.06,
    },
];
