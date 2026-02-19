import { FaceMesh } from '@mediapipe/face_mesh';
import { Camera } from '@mediapipe/camera_utils';

// Eye landmarks for MediaPipe FaceMesh
// Left Eye: [33, 160, 158, 133, 153, 144]
// Right Eye: [362, 385, 387, 263, 373, 380]

const LEFT_EYE = [33, 160, 158, 133, 153, 144];
const RIGHT_EYE = [362, 385, 387, 263, 373, 380];

export const calculateEAR = (landmarks, eyeIndices) => {
    // P1..P6 are the landmark points
    // Vertical distances: ||P2-P6|| and ||P3-P5||
    // Horizontal distance: ||P1-P4||
    // EAR = (||P2-P6|| + ||P3-P5||) / (2 * ||P1-P4||)

    const p1 = landmarks[eyeIndices[0]];
    const p2 = landmarks[eyeIndices[1]];
    const p3 = landmarks[eyeIndices[2]];
    const p4 = landmarks[eyeIndices[3]];
    const p5 = landmarks[eyeIndices[4]];
    const p6 = landmarks[eyeIndices[5]];

    const dist = (pA, pB) => {
        return Math.sqrt(Math.pow(pA.x - pB.x, 2) + Math.pow(pA.y - pB.y, 2));
    };

    const v1 = dist(p2, p6);
    const v2 = dist(p3, p5);
    const h = dist(p1, p4);

    return (v1 + v2) / (2.0 * h);
};

export const getAvgEAR = (landmarks) => {
    const leftEAR = calculateEAR(landmarks, LEFT_EYE);
    const rightEAR = calculateEAR(landmarks, RIGHT_EYE);
    return (leftEAR + rightEAR) / 2.0;
};
